#!/usr/bin/env node
'use strict'

// Sends a command to TS Cameraman's control channel and prints the reply.
//
//   node scripts/control.js dump-state
//   node scripts/control.js set-zoom displayed=2.0
//   node scripts/control.js --host 192.168.7.118 flip-camera
//
// The app only listens when launched with -uiTest true.
//
// `frameDelivery` is the one command that goes over the stream's RTSP parameter port instead, so it
// works on any running camera, test launch or not, iOS or Android:
//
//   node scripts/control.js --host 192.168.100.20 frameDelivery 24        # a steady 24 fps
//   node scripts/control.js --host 192.168.100.20 frameDelivery 24:60:20  # 24 up to 60 and back, every 20 s
//   node scripts/control.js --host 192.168.100.20 frameDelivery off
//
// It drops captured frames before the encoder (`test.deliveredFrameRate*`), so the camera stays
// connected with the same format, and prints what the phone reports afterwards.

const http = require('http')
const { exchange } = require('./rtspParams')

const DEFAULT_PORT = 8766
const DEFAULT_HOST = '127.0.0.1'
const DEFAULT_RTSP_PORT = 8554

const FRAME_DELIVERY_NAMES = [
  'test.deliveredFrameRate',
  'test.deliveredFrameRateSwing',
  'test.deliveredFrameRate.actual'
]

// The SET_PARAMETER lines for `frameDelivery <fps|low:high:period|off>`. Each form sets both names,
// so a steady rate clears a swing and a swing clears a steady rate.
function frameDeliveryLines (value) {
  const number = '\\d+(?:\\.\\d+)?'
  if (value === 'off' || value === '0') {
    return ['test.deliveredFrameRate: 0', 'test.deliveredFrameRateSwing:']
  }
  if (new RegExp(`^${number}$`).test(value ?? '')) {
    return [`test.deliveredFrameRate: ${value}`, 'test.deliveredFrameRateSwing:']
  }
  if (new RegExp(`^${number}:${number}:${number}$`).test(value ?? '')) {
    return ['test.deliveredFrameRate: 0', `test.deliveredFrameRateSwing: ${value}`]
  }
  throw new Error('usage: control.js [--host H] [--rtsp-port P] frameDelivery <fps|low:high:period|off>')
}

function parseArguments (argv) {
  const options = { host: DEFAULT_HOST, port: DEFAULT_PORT, rtspPort: DEFAULT_RTSP_PORT, timeout: 5000 }
  const rest = []

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--host') options.host = argv[++index]
    else if (argument === '--port') options.port = Number(argv[++index])
    else if (argument === '--rtsp-port') options.rtspPort = Number(argv[++index])
    else if (argument === '--timeout') options.timeout = Number(argv[++index])
    else rest.push(argument)
  }

  if (rest.length === 0) {
    throw new Error('usage: control.js [--host H] [--port P] <command> [key=value ...]')
  }

  const [command, ...pairs] = rest
  if (command === 'frameDelivery') {
    options.frameDelivery = frameDeliveryLines(pairs[0])
    return options
  }
  const query = pairs
    .map(pair => {
      const at = pair.indexOf('=')
      if (at < 0) throw new Error(`arguments must be key=value, got "${pair}"`)
      return `${encodeURIComponent(pair.slice(0, at))}=${encodeURIComponent(pair.slice(at + 1))}`
    })
    .join('&')

  options.path = `/${command.replace(/^\//, '')}${query ? `?${query}` : ''}`
  return options
}

function send (options) {
  return new Promise((resolve, reject) => {
    const request = http.get(
      { host: options.host, port: options.port, path: options.path, timeout: options.timeout },
      response => {
        let body = ''
        response.setEncoding('utf8')
        response.on('data', chunk => { body += chunk })
        response.on('end', () => resolve({ status: response.statusCode, body }))
      }
    )
    request.on('timeout', () => {
      request.destroy(new Error(`no reply within ${options.timeout} ms — is the app running with -uiTest true?`))
    })
    request.on('error', reject)
  })
}

// Writes the throttle over RTSP, then reads back what the phone reports for it.
async function frameDelivery (options) {
  const target = { host: options.host, port: options.rtspPort, timeout: options.timeout }
  const set = await exchange({ ...target, lines: options.frameDelivery })
  console.log(set.statusLine)
  process.stdout.write(set.body)
  if (set.status !== 200) {
    process.exitCode = 1
    return
  }
  const get = await exchange({ ...target, lines: FRAME_DELIVERY_NAMES })
  process.stdout.write(get.body)
  if (get.status !== 200) process.exitCode = 1
}

async function main () {
  const options = parseArguments(process.argv.slice(2))
  if (options.frameDelivery) return frameDelivery(options)
  const { status, body } = await send(options)

  // Pretty-printed when it is JSON, raw when it is not, so an HTML error page from something else
  // listening on the port is visible rather than swallowed.
  try {
    console.log(JSON.stringify(JSON.parse(body), null, 2))
  } catch {
    console.log(body)
  }

  if (status !== 200) process.exitCode = 1
}

module.exports = { frameDeliveryLines, parseArguments }

if (require.main === module) {
  main().catch(error => {
    console.error(error.message)
    process.exitCode = 1
  })
}
