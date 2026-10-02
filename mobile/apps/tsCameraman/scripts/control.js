#!/usr/bin/env node
'use strict'

// Sends a command to TS Cameraman's control channel and prints the reply.
//
//   node scripts/control.js dump-state
//   node scripts/control.js set-zoom displayed=2.0
//   node scripts/control.js --host 192.168.7.118 flip-camera
//
// The app only listens when launched with -uiTest true.

const http = require('http')

const DEFAULT_PORT = 8766
const DEFAULT_HOST = '127.0.0.1'

function parseArguments (argv) {
  const options = { host: DEFAULT_HOST, port: DEFAULT_PORT, timeout: 5000 }
  const rest = []

  for (let index = 0; index < argv.length; index++) {
    const argument = argv[index]
    if (argument === '--host') options.host = argv[++index]
    else if (argument === '--port') options.port = Number(argv[++index])
    else if (argument === '--timeout') options.timeout = Number(argv[++index])
    else rest.push(argument)
  }

  if (rest.length === 0) {
    throw new Error('usage: control.js [--host H] [--port P] <command> [key=value ...]')
  }

  const [command, ...pairs] = rest
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

async function main () {
  const options = parseArguments(process.argv.slice(2))
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

main().catch(error => {
  console.error(error.message)
  process.exitCode = 1
})
