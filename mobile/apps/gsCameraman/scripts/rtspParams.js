#!/usr/bin/env node
// Reads or writes GS Cameraman's RTSP parameters from the Mac, with nothing of Director in the path.
//
//   node scripts/rtspParams.js --host 10.10.7.118                 # GET_PARAMETER *
//   node scripts/rtspParams.js --host 10.10.7.118 ptz.zoom system.thermal
//   node scripts/rtspParams.js --host 10.10.7.118 'ptz.zoom: 3'    # SET_PARAMETER
//
// Lines with a colon are written, bare names are read. Prints the status line and the body; exits
// non-zero on anything but 2xx so a script can assert on it.

'use strict'

const net = require('net')

function parseArgs (argv) {
  const options = { host: null, port: 8554, path: '/live/mainstream', timeout: 5000, lines: [] }
  for (let i = 2; i < argv.length; i += 1) {
    const key = argv[i]
    const next = () => {
      const value = argv[i + 1]
      if (value === undefined) throw new Error(`${key} needs a value`)
      i += 1
      return value
    }
    switch (key) {
      case '--host': options.host = next(); break
      case '--port': options.port = Number(next()); break
      case '--path': options.path = next(); break
      case '--timeout': options.timeout = Number(next()); break
      default:
        if (key.startsWith('--')) throw new Error(`unknown argument ${key}`)
        options.lines.push(key)
    }
  }
  if (!options.host) throw new Error('--host is required')
  return options
}

function request (socket, method, uri, cseq, body) {
  let text = `${method} ${uri} RTSP/1.0\r\nCSeq: ${cseq}\r\nUser-Agent: rtspParams.js\r\n`
  if (body) text += `Content-Type: text/parameters\r\nContent-Length: ${Buffer.byteLength(body)}\r\n`
  text += '\r\n'
  socket.write(text + (body || ''))
}

// One response at a time: status line, headers, then Content-Length bytes of body.
function readResponse (buffer) {
  const end = buffer.indexOf('\r\n\r\n')
  if (end < 0) return null
  const head = buffer.slice(0, end).toString('utf8').split('\r\n')
  const headers = {}
  for (const line of head.slice(1)) {
    const colon = line.indexOf(':')
    if (colon > 0) headers[line.slice(0, colon).trim().toLowerCase()] = line.slice(colon + 1).trim()
  }
  const length = Number(headers['content-length'] || 0)
  if (buffer.length < end + 4 + length) return null
  return {
    statusLine: head[0],
    status: Number(head[0].split(' ')[1]),
    headers,
    body: buffer.slice(end + 4, end + 4 + length).toString('utf8'),
    consumed: end + 4 + length
  }
}

async function main () {
  const options = parseArgs(process.argv)
  const uri = `rtsp://${options.host}:${options.port}${options.path}`
  const writes = options.lines.filter(line => line.includes(':'))
  const reads = options.lines.filter(line => !line.includes(':'))
  const method = writes.length ? 'SET_PARAMETER' : 'GET_PARAMETER'
  const body = (writes.length ? writes : (reads.length ? reads : ['*']))
    .map(line => line.trim()).join('\r\n') + '\r\n'

  const socket = net.connect({ host: options.host, port: options.port })
  socket.setTimeout(options.timeout, () => { console.error('timed out'); process.exit(2) })
  await new Promise((resolve, reject) => socket.once('connect', resolve).once('error', reject))

  let buffer = Buffer.alloc(0)
  const responses = []
  const waitFor = count => new Promise((resolve, reject) => {
    const onData = chunk => {
      buffer = Buffer.concat([buffer, chunk])
      let parsed
      while ((parsed = readResponse(buffer))) {
        buffer = buffer.slice(parsed.consumed)
        responses.push(parsed)
      }
      if (responses.length >= count) { socket.off('data', onData); resolve() }
    }
    socket.on('data', onData)
    socket.once('error', reject)
  })

  request(socket, 'OPTIONS', uri, 1)
  await waitFor(1)
  const options_ = responses[0]
  const publicMethods = options_.headers.public || ''
  if (!publicMethods.includes('SET_PARAMETER')) {
    console.error(`camera does not advertise SET_PARAMETER (Public: ${publicMethods})`)
  }

  request(socket, method, uri, 2, body)
  await waitFor(2)
  const answer = responses[1]
  console.log(answer.statusLine)
  process.stdout.write(answer.body)
  socket.end()
  process.exit(answer.status >= 200 && answer.status < 300 ? 0 : 1)
}

main().catch(error => {
  console.error(error.message)
  process.exit(2)
})
