// Which iPad the scripts talk to, and how to reach its control server.
//
// This project has been measured on a 2018 A12X and on an M4, and the two are not interchangeable in
// any thermal or throughput reading — so the target is whichever iPad is actually attached rather
// than a UDID pasted into each script. `PRODUCER_DEVICE_UDID` pins one when both are plugged in.

const { execFileSync } = require('node:child_process')

const PORT = Number(process.env.PRODUCER_CONTROL_PORT ?? 8765)

function pairedDevices() {
  const raw = execFileSync(
    'xcrun',
    ['devicectl', 'list', 'devices', '--json-output', '/dev/stdout'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  )
  return JSON.parse(raw.slice(raw.indexOf('{'))).result.devices
}

function resolveDevice() {
  const devices = pairedDevices()
  const wanted = process.env.PRODUCER_DEVICE_UDID
  const connectedPads = devices.filter(
    entry =>
      entry.hardwareProperties.deviceType === 'iPad' &&
      entry.connectionProperties.tunnelState === 'connected'
  )
  const m4 = connectedPads.find(entry =>
    (entry.hardwareProperties.marketingName ?? '').includes('M4')
  )
  const device = wanted
    ? devices.find(entry => entry.hardwareProperties.udid === wanted)
    : (m4 ?? connectedPads[0])
  if (!device) {
    throw new Error(
      wanted
        ? `iPad ${wanted} is not paired — plug it in and trust this Mac`
        : 'no iPad is connected — plug one in, or set PRODUCER_DEVICE_UDID'
    )
  }
  return {
    udid: device.hardwareProperties.udid,
    name: device.deviceProperties.name,
    model: device.hardwareProperties.marketingName,
    hostnames: hostnamesFor(device)
  }
}

function hostnamesFor(device) {
  const hosts = new Set()
  const name = (device.deviceProperties.name ?? '').replace(/[^A-Za-z0-9]+/g, '-')
  if (name) hosts.add(`${name}.local`)
  for (const host of device.connectionProperties.potentialHostnames ?? [])
    hosts.add(host)
  return [...hosts]
}

async function get(host, target, timeoutMs) {
  const response = await fetch(`http://${host}:${PORT}${target}`, {
    signal: AbortSignal.timeout(
      timeoutMs ?? Number(process.env.PRODUCER_CONTROL_TIMEOUT_MS ?? 10000)
    )
  })
  const text = await response.text()
  if (!response.ok) throw new Error(`${target} -> ${response.status} ${text}`)
  return text
}

/// The simulator answers on loopback; a device answers on one of several names, and which one works
/// depends on how it is attached, so they are tried in turn.
async function resolveHost(useDevice) {
  if (!useDevice) return '127.0.0.1'
  if (process.env.PRODUCER_DEVICE_ADDRESS)
    return process.env.PRODUCER_DEVICE_ADDRESS
  for (const host of resolveDevice().hostnames) {
    try {
      await get(host, '/health')
      return host
    } catch {
      continue
    }
  }
  throw new Error(
    'no device address answered — is the app running with -uiTest true?'
  )
}

module.exports = { PORT, get, pairedDevices, resolveDevice, resolveHost }
