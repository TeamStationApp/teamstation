// Which iPad the scripts talk to, and how to reach its control server.
//
// The caller always passes DIRECTOR_DEVICE_UDID (or `--device <udid>`). Auto-picking the first
// connected iPad would send parallel agents to the same machine.

const { execFileSync } = require('node:child_process')

const PORT = Number(process.env.DIRECTOR_CONTROL_PORT ?? 8765)

function pairedDevices() {
  const raw = execFileSync(
    'xcrun',
    ['devicectl', 'list', 'devices', '--json-output', '/dev/stdout'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }
  )
  return JSON.parse(raw.slice(raw.indexOf('{'))).result.devices
}

function resolveDevice() {
  const wanted = process.env.DIRECTOR_DEVICE_UDID
  if (!wanted) {
    throw new Error('set DIRECTOR_DEVICE_UDID or pass --device <udid>')
  }
  const devices = pairedDevices()
  const device = devices.find(entry => entry.hardwareProperties.udid === wanted)
  if (!device) {
    throw new Error(
      `iPad ${wanted} is not paired — plug it in and trust this Mac`
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
  const slug = (device.deviceProperties.name ?? '')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
  if (slug) hosts.add(`${slug}.local`)
  for (const host of device.connectionProperties.potentialHostnames ?? [])
    hosts.add(host)
  return [...hosts]
}

async function get(host, target, timeoutMs) {
  const response = await fetch(`http://${host}:${PORT}${target}`, {
    signal: AbortSignal.timeout(
      timeoutMs ?? Number(process.env.DIRECTOR_CONTROL_TIMEOUT_MS ?? 10000)
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
  if (process.env.DIRECTOR_DEVICE_ADDRESS)
    return process.env.DIRECTOR_DEVICE_ADDRESS
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
