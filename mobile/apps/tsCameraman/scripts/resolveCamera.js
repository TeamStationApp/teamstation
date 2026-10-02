#!/usr/bin/env node
// Resolves a TS Cameraman's address from its Bonjour advertisement and prints it.
//
// Shells out to dns-sd rather than speaking mDNS directly, because dns-sd uses the system resolver
// and therefore sees exactly what any other client on this Mac would see — including whether the
// advertisement is usable at all, which is part of what the end-to-end run is checking.

'use strict'

const { execFile } = require('child_process')

const SERVICE_TYPE = '_rtsp._tcp'

/// dns-sd never exits on its own, so every call is a timed capture of whatever it printed.
function capture (args, timeout) {
  return new Promise((resolve) => {
    const child = execFile('dns-sd', args, { timeout }, (error, stdout) => {
      resolve(stdout || '')
    })
    setTimeout(() => child.kill(), timeout)
  })
}

async function browse (timeout) {
  const output = await capture(['-B', SERVICE_TYPE], timeout)
  const names = []
  for (const line of output.split('\n')) {
    // "11:05:13.068  Add  3  28  local.  _rtsp._tcp.  Camera 14E7"
    const match = /\bAdd\b\s+\d+\s+\d+\s+\S+\s+_rtsp\._tcp\.\s+(.+?)\s*$/.exec(line)
    if (match && !names.includes(match[1])) names.push(match[1])
  }
  return names
}

async function resolveHostname (name, timeout) {
  const output = await capture(['-L', name, SERVICE_TYPE], timeout)
  const match = /can be reached at\s+(\S+):(\d+)/.exec(output)
  if (!match) return null
  // dns-sd escapes spaces in the hostname as \032; the host part never contains one in practice.
  return { hostname: match[1].replace(/\.$/, ''), port: Number(match[2]) }
}

async function resolveAddress (hostname, timeout) {
  const output = await capture(['-G', 'v4', hostname], timeout)
  const addresses = []
  for (const line of output.split('\n')) {
    const match = /\bAdd\b.*\s(\d+\.\d+\.\d+\.\d+)\s/.exec(line)
    if (!match) continue
    const address = match[1]
    // 0.0.0.0 is "no such record" and 169.254.x is the USB link-local interface, which is not the
    // path a real client would take.
    if (address === '0.0.0.0' || address.startsWith('169.254.')) continue
    if (!addresses.includes(address)) addresses.push(address)
  }
  return addresses[0] || null
}

async function main () {
  const wanted = process.argv[2]
  const names = await browse(4000)
  if (names.length === 0) throw new Error(`no ${SERVICE_TYPE} service is being advertised`)

  const name = wanted ? names.find((n) => n.includes(wanted)) : names[0]
  if (!name) throw new Error(`no advertised camera matched "${wanted}" (saw ${names.join(', ')})`)

  const service = await resolveHostname(name, 4000)
  if (!service) throw new Error(`"${name}" is advertised but does not resolve to a host`)

  const address = await resolveAddress(service.hostname, 4000)
  if (!address) throw new Error(`${service.hostname} has no routable IPv4 address`)

  process.stderr.write(`${name} at ${service.hostname}:${service.port}\n`)
  process.stdout.write(address)
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
