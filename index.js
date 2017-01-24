#!/usr/bin/env node
"use strict"

const osmosis = require("osmosis")
const chalk = require("chalk")
const rainbow = require("chalk-rainbow")
const twilio = require("twilio")
const blessed = require("blessed")
const contrib = require("blessed-contrib")
const format = require("date-format")
const pretty = require("pretty-ms")
const airports = require("airports")

// Time constants
const TIME_MS = 1
const TIME_SEC = TIME_MS * 1000
const TIME_MIN = TIME_SEC * 60
const TIME_HOUR = TIME_MIN * 60

// Fares
var prevLowestOutboundFare
var prevLowestReturnFare
const fares = {
  outbound: [],
  return: []
}

// Flight times
const flightTimes = {
  "anytime":   "ANYTIME",
  "morning":   "BEFORE_NOON",
  "afternoon": "NOON_TO_6PM",
  "evening":   "AFTER_6PM"
}

// Command line options
var originAirport
var destinationAirport
var outboundDateString
var outboundTimeOfDay = flightTimes["anytime"]
var returnDateString
var returnTimeOfDay = flightTimes["anytime"]
var adultPassengerCount
var individualDealPrice
var totalDealPrice
var interval = 30 // In minutes
var fareType = "DOLLARS"
var isOneWay = false

// Parse command line options (no validation, sorry!)
process.argv.forEach((arg, i, argv) => {
  switch (arg) {
    case "--from":
      originAirport = argv[i + 1]
      break
    case "--to":
      destinationAirport = argv[i + 1]
      break
    case "--leave-date":
      outboundDateString = argv[i + 1]
      break
    case "--leave-time":
      outboundTimeOfDay = (flightTimes[argv[i + 1 ]] === undefined) ? flightTimes["anytime"] : flightTimes[argv[i + 1 ]]
      break
    case "--return-date":
      returnDateString = argv[i + 1]
      break
    case "--return-time":
      returnTimeOfDay = (flightTimes[argv[i + 1 ]] === undefined) ? flightTimes["anytime"] : flightTimes[argv[i + 1 ]]
      break
    case "--fare-type":
      fareType = argv[i + 1].toUpperCase()
      break
    case "--passengers":
      adultPassengerCount = argv[i + 1]
      break
    case "--individual-deal-price":
      individualDealPrice = parseInt(argv[i + 1])
      break
    case "--total-deal-price":
      totalDealPrice = parseInt(argv[i + 1])
      break
    case "--interval":
      interval = parseFloat(argv[i + 1])
      break
    case "--one-way":
      isOneWay = true
      break
  }
})

// Remove invalid fields for a one-way flight
// Doing this after all flags are parsed in the event
// flags are out of order
if (isOneWay) {
  returnDateString = ""
  returnTimeOfDay = ""
  totalDealPrice = undefined;
}

// Check if Twilio env vars are set
const isTwilioConfigured = process.env.TWILIO_ACCOUNT_SID &&
                           process.env.TWILIO_AUTH_TOKEN &&
                           process.env.TWILIO_PHONE_FROM &&
                           process.env.TWILIO_PHONE_TO

/**
 * Dashboard renderer
 */
class Dashboard {

  constructor() {
    this.markers = []
    this.widgets = {}

    // Configure blessed
    this.screen = blessed.screen({
      title: "SWA Dashboard",
      autoPadding: true,
      dockBorders: true,
      fullUnicode: true,
      smartCSR: true
    })

    this.screen.key(["escape", "q", "C-c"], (ch, key) => process.exit(0))

    // Grid settings
    this.grid = new contrib.grid({
      screen: this.screen,
      rows: 12,
      cols: 12
    })

    // Graphs
    this.graphs = {
      outbound: {
        title: "Origin/Outbound",
        x: [],
        y: [],
        style: {
          line: "red"
        }
      },
    }

    // Graph return flight if one-way is not selected
    if (!isOneWay) {
      this.graphs.return = {
        title: "Destination/Return",
        x: [],
        y: [],
        style: {
          line: "yellow"
        }
      }
    }

    // Shared settings
    const shared = {
      border: {
        type: "line"
      },
      style: {
        fg: "blue",
        text: "blue",
        border: {
          fg: "green"
        }
      }
    }

    // Widgets
    const widgets = {
      map: {
        type: contrib.map,
        size: {
          width: 9,
          height: 5,
          top: 0,
          left: 0
        },
        options: Object.assign({}, shared, {
          label: "Map",
          startLon: 54,
          endLon: 110,
          startLat: 112,
          endLat: 140,
          region: "us"
        })
      },
      settings: {
        type: contrib.log,
        size: {
          width: 3,
          height: 5,
          top: 0,
          left: 9
        },
        options: Object.assign({}, shared, {
          label: "Settings",
          padding: {
            left: 1
          }
        })
      },
      graph: {
        type: contrib.line,
        size: {
          width: 12,
          height: 4,
          top: 5,
          left: 0
        },
        options: Object.assign({}, shared, {
          label: "Prices",
          showLegend: true,
          legend: {
            width: 20
          }
        })
      },
      log: {
        type: contrib.log,
        size: {
          width: 12,
          height: 3,
          top: 9,
          left: 0
        },
        options: Object.assign({}, shared, {
          label: "Log",
          padding: {
            left: 1
          }
        })
      }
    }

    // For each widget, create a new contrib widget object and replace
    for (let name in widgets) {
      let widget = widgets[name]

      this.widgets[name] = this.grid.set(
        widget.size.top,
        widget.size.left,
        widget.size.height,
        widget.size.width,
        widget.type,
        widget.options
      )
    }
  }

  /**
   * Render screen
   *
   * @return {Void}
   */
  render() {
    this.screen.render()
  }

  /**
   * Plot graph data
   *
   * @param {Arr} prices
   *
   * @return {Void}
   */
  plot(prices) {
    const now = format("MM/dd/yy-hh:mm:ss", new Date())
    const data = []

    Object.assign(this.graphs.outbound, {
      x: [...this.graphs.outbound.x, now],
      y: [...this.graphs.outbound.y, prices.outbound]
    })

    data.push(this.graphs.outbound)

    // Add data point if one-way is not selected
    if (!isOneWay) {
      Object.assign(this.graphs.return, {
        x: [...this.graphs.return.x, now],
        y: [...this.graphs.return.y, prices.return]
      })

      data.push(this.graphs.return)
    }

    this.widgets.graph.setData(data)
  }

  /**
   * Add waypoint marker to map
   *
   * @param {Obj} data
   *
   * @return {Void}
   */
  waypoint(data) {
    this.markers.push(data)

    if (this.blink) {
      return
    }

    // Blink effect
    var visible = true

    this.blink = setInterval(() => {
      if (visible) {
        this.markers.forEach((m) => this.widgets.map.addMarker(m))
      } else {
        this.widgets.map.clearMarkers()
      }

      visible = !visible

      this.render()
    }, 1 * TIME_SEC)
  }

  /**
   * Log data
   *
   * @param {Arr} messages
   *
   * @return {Void}
   */
  log(messages) {
    const now = format("MM/dd/yy-hh:mm:ss", new Date())
    messages.forEach((m) => this.widgets.log.log(`${now}: ${m}`))
  }

  /**
   * Display settings
   *
   * @param {Arr} config
   *
   * @return {Void}
   */
  settings(config) {
    // At this stage, this.widgets.settings is a contrib Log widget that has an `add(line)` function
    config.forEach((c) => this.widgets.settings.add(c))
  }
}

const dashboard = new Dashboard()

/**
 * Send a text message using Twilio
 *
 * @param {Str} message
 *
 * @return {Void}
 */
const sendTextMessage = (message) => {
  try {
    const twilioClient = twilio(process.env.TWILIO_ACCOUNT_SID, process.env.TWILIO_AUTH_TOKEN)

    twilioClient.sendMessage({
      from: process.env.TWILIO_PHONE_FROM,
      to: process.env.TWILIO_PHONE_TO,
      body: message
    }, function(err, data) {
      if (!dashboard) return
      if (err) {
        dashboard.log([
          chalk.red(`Error: failed to send SMS to ${process.env.TWILIO_PHONE_TO} from ${process.env.TWILIO_PHONE_FROM}`)
        ])
      } else {
        dashboard.log([
          chalk.green(`Successfully sent SMS to ${process.env.TWILIO_PHONE_TO} from ${process.env.TWILIO_PHONE_FROM}`)
        ])
      }
    })
  } catch(e) {}
}

/**
 * Format fare type price
 *
 * @param {Int} price
 *
 * @return {Str}
 */
const formatPrice = (price) => {
  if (fareType === 'POINTS') {
    return `${price} pts`
  } else {
    return `\$${price}`
  }
}

/**
 * Parse and return pricing from HTML markup
 *
 * @param {Str} priceMarkup
 *
 * @return {Int}
 */
const parsePriceMarkup = (priceMarkup) => {
  if (fareType === 'POINTS') {
    const matches = priceMarkup.text().split(',').join('')
    return parseInt(matches)
  } else {
    const matches = priceMarkup.toString().match(/\$.*?(\d+)/)
    return parseInt(matches[1])
  }
}

/**
 * Fetch latest Southwest prices
 *
 * @return {Void}
 */
const fetch = () => {
  const formData = {
  }

  osmosis
    .get("https://www.southwest.com")
    .submit(".booking-form--form", {
      twoWayTrip: !isOneWay,
      airTranRedirect: "",
      returnAirport: isOneWay ? "" : "RoundTrip",
      outboundTimeOfDay,
      returnTimeOfDay,
      seniorPassengerCount: 0,
      fareType,
      originAirport,
      destinationAirport,
      outboundDateString,
      returnDateString,
      adultPassengerCount
    })
    .find("#faresOutbound .product_price")
    .then((priceMarkup) => {
      const price = parsePriceMarkup(priceMarkup)
      fares.outbound.push(price)
    })
    .find("#faresReturn .product_price")
    .then((priceMarkup) => {
      if (isOneWay) return // Only record return prices if it's a two-way flight
      const price = parsePriceMarkup(priceMarkup)
      fares.return.push(price)
    })
    .done(() => {
      const lowestOutboundFare = Math.min(...fares.outbound)
      const lowestReturnFare = Math.min(...fares.return)
      var faresAreValid = true

      // Clear previous fares
      fares.outbound = []
      fares.return = []

      // Get difference from previous fares
      const outboundFareDiff = prevLowestOutboundFare - lowestOutboundFare
      const returnFareDiff = prevLowestReturnFare - lowestReturnFare
      var outboundFareDiffString = ""
      var returnFareDiffString = ""

      // Create a string to show the difference
      if (!isNaN(outboundFareDiff) && !isNaN(returnFareDiff)) {

        // Usually this is because of a scraping error
        if (!isFinite(outboundFareDiff) || !isFinite(returnFareDiff)) {
          faresAreValid = false
        }

        if (outboundFareDiff > 0) {
          outboundFareDiffString = chalk.green(`(down ${formatPrice(Math.abs(outboundFareDiff))})`)
        } else if (outboundFareDiff < 0) {
          outboundFareDiffString = chalk.red(`(up ${formatPrice(Math.abs(outboundFareDiff))})`)
        } else if (outboundFareDiff === 0) {
          outboundFareDiffString = chalk.blue(`(no change)`)
        }

        if (returnFareDiff > 0) {
          returnFareDiffString = chalk.green(`(down ${formatPrice(Math.abs(returnFareDiff))})`)
        } else if (returnFareDiff < 0) {
          returnFareDiffString = chalk.red(`(up ${formatPrice(Math.abs(returnFareDiff))})`)
        } else if (returnFareDiff === 0) {
          returnFareDiffString = chalk.blue(`(no change)`)
        }
      }

      if (faresAreValid) {
        // Store current fares for next time
        prevLowestOutboundFare = lowestOutboundFare
        prevLowestReturnFare = lowestReturnFare

        // Do some Twilio magic (SMS alerts for awesome deals)
        const awesomeDealIsAwesome = (
          totalDealPrice && (lowestOutboundFare + lowestReturnFare <= totalDealPrice)
        ) || (
          individualDealPrice && (lowestOutboundFare <= individualDealPrice || lowestReturnFare <= individualDealPrice)
        )

        if (awesomeDealIsAwesome) {
          const message = `Deal alert! Combined total has hit ${formatPrice(lowestOutboundFare + lowestReturnFare)}. Individual fares are ${formatPrice(lowestOutboundFare)} (outbound) and ${formatPrice(lowestReturnFare)} (return).`

          // Party time
          dashboard.log([
            rainbow(message)
          ])

          if (isTwilioConfigured) {
            sendTextMessage(message)
          }
        }

        dashboard.log([
          `Lowest fares for an outbound flight is currently ${formatPrice([lowestOutboundFare, outboundFareDiffString].filter(i => i).join(" "))}`,
        ])

        if (!isOneWay) {
          dashboard.log([
            `Lowest fares for a return flight is currently ${formatPrice([lowestReturnFare, returnFareDiffString].filter(i => i).join(" "))}`
          ])
        }

        dashboard.plot({
          outbound: lowestOutboundFare,
          return: lowestReturnFare
        })
      }

      dashboard.render()

      setTimeout(fetch, interval * TIME_MIN)
    })
}

// Get lat/lon for airports (no validation on non-existent airports)
airports.forEach((airport) => {
  switch (airport.iata) {
    case originAirport:
      dashboard.waypoint({ lat: airport.lat, lon: airport.lon, color: "red", char: "X" })
      break
    case destinationAirport:
      dashboard.waypoint({ lat: airport.lat, lon: airport.lon, color: "yellow", char: "X" })
      break
  }
})

dashboard.settings([
  `Origin airport: ${originAirport}`,
  `Destination airport: ${destinationAirport}`,
  `Outbound date: ${outboundDateString}`,
  `Outbound time: ${outboundTimeOfDay.toLowerCase()}`,
  !isOneWay && `Return date: ${returnDateString}`,
  !isOneWay && `Return time: ${returnTimeOfDay.toLowerCase()}`,
  `Trip type: ${isOneWay ? "one-way" : "two-way"}`,
  `Fare type: ${fareType.toLowerCase()}`,
  `Passengers: ${adultPassengerCount}`,
  `Interval: ${pretty(interval * TIME_MIN)}`,
  !isOneWay && `Individual deal price: ${individualDealPrice ? `<= ${formatPrice(individualDealPrice)}` : "disabled"}`,
  `Total deal price: ${totalDealPrice ? `<= ${formatPrice(totalDealPrice)}` : "disabled"}`,
  `SMS alerts: ${isTwilioConfigured ? process.env.TWILIO_PHONE_TO : "disabled"}`
].filter(s => s))

fetch()
