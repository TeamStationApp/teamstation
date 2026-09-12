#!/usr/bin/env node
// Loop the four captured cameras as RTSP servers and advertise the same Bonjour types the
// hardware used. NearStream identity is `_awx_service._tcp` (SRV 25644, media still :554).
// GS Cameraman identity is `_rtsp._tcp` on 554. Nothing NDI is published.
//
// Director discovers one camera per IPv4, so the director-facing mode adds four aliases on
// the Mac's LAN and binds :554 on each. That needs root:
//
//   sudo -E "$(command -v node)" scripts/fakeRtspCameras.js
//
// Local ffprobe without sudo (not reachable as four cameras from the iPad):
//
//   node scripts/fakeRtspCameras.js --local
//
// Fixture dir defaults to the 2026-08-20 stopwatch take.

const { spawn, spawnSync } = require('node:child_process')
const fs = require('node:fs')
const http = require('node:http')
const os = require('node:os')
const path = require('node:path')
const { createCameraServer, LoopSource, selfTest } = require('./rtspLoopServer')
const { FakeCameramanModel } = require('./fakeCameramanModel')

const DEFAULT_FIXTURE_DIR = '/Users/paul/recordings/gsDirector-rtsp-fixtures/20260820-stopwatch'
const STATE_PATH = '/tmp/gs-director-rtsp-farm.json'
const LOCAL_BASE_PORT = 18554
/// Loopback aliases this run added, so it can take them away again.
const LOOPBACK_ALIASES = []

function usage() {
  return `Usage: node scripts/fakeRtspCameras.js [options]
  --fixtures DIR   Capture directory with cameras.json and video/*.mkv
  --local          10.255.77.1-4 aliased onto lo0, no LAN aliases, no Bonjour. One private
                   address per camera, because Director identifies a camera by its IPv4 and
                   accepts only private LAN addresses. Needs root or passwordless sudo.
  --advertise      Publish mDNS anyway, at whatever host and port the cameras ended up on.
                   With --local that is loopback on a high port, which an iOS *simulator* can
                   reach because it shares this Mac's network stack — so a simulator gets real
                   discovery over real RTSP with no root and no LAN aliases.
  --no-advertise   Do not publish mDNS (RTSP only)
  --no-alias       Do not add LAN aliases (bind the chosen hosts as they are)
  --hosts a,b,c,d  Four IPv4s, in cameras.json order
  --cameraman NAME Add a GS Cameraman that answers GET_PARAMETER / SET_PARAMETER (control=params/1),
                   advertised on _awx_service._tcp, so Director and Preview control flows run
                   on a simulator with no phone attached
  --only-cameraman Serve just that phone on this Mac's own LAN address: no aliases, no root
  --status-port N  Loopback HTTP that reports the fake phone's parameters as JSON (default 8768),
                   so a Maestro runScript can assert on the phone's state; 0 disables it
  --base-port N    Port for --local cameras (default ${LOCAL_BASE_PORT}). Use 554 under sudo to
                   match production exactly, which some code paths assume when an advertisement
                   carries no port of its own.
  --stop           Tear down a previous farm from ${STATE_PATH}
  --self-test      Packetization checks, then exit
`
}

function parseArgs(argv) {
  const options = {
    fixtures: process.env.DIRECTOR_RTSP_FIXTURES || DEFAULT_FIXTURE_DIR,
    local: false,
    advertise: true,
    alias: true,
    hosts: null,
    stop: false,
    basePort: LOCAL_BASE_PORT,
    forceAdvertise: false,
    selfTest: false,
    cameraman: null,
    onlyCameraman: false,
    statusPort: 8768
  }
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === '--help' || arg === '-h') {
      process.stdout.write(usage())
      process.exit(0)
    }
    if (arg === '--local') {
      options.local = true
      options.advertise = false
      options.alias = false
      continue
    }
    if (arg === '--no-advertise') {
      options.advertise = false
      options.forceAdvertise = false
      continue
    }
    if (arg === '--advertise') {
      options.advertise = true
      options.forceAdvertise = true
      continue
    }
    if (arg === '--no-alias') {
      options.alias = false
      continue
    }
    if (arg === '--stop') {
      options.stop = true
      continue
    }
    if (arg === '--self-test') {
      options.selfTest = true
      continue
    }
    if (arg === '--fixtures') {
      options.fixtures = argv[index + 1]
      index += 1
      continue
    }
    if (arg === '--base-port') {
      options.basePort = Number(argv[index + 1])
      if (!(options.basePort > 0)) throw new Error('--base-port needs a port')
      index += 1
      continue
    }
    if (arg === '--status-port') {
      options.statusPort = Number(argv[index + 1])
      index += 1
      continue
    }
    if (arg === '--only-cameraman') {
      options.onlyCameraman = true
      options.alias = false
      continue
    }
    if (arg === '--cameraman') {
      options.cameraman = argv[index + 1]
      if (!options.cameraman) throw new Error('--cameraman needs a name')
      index += 1
      continue
    }
    if (arg === '--hosts') {
      options.hosts = argv[index + 1].split(',').map(value => value.trim()).filter(Boolean)
      index += 1
      continue
    }
    throw new Error(`unknown argument ${arg}\n${usage()}`)
  }
  if (options.local) {
    options.advertise = options.forceAdvertise === true
    options.alias = false
  }
  return options
}

function loadInventory(fixtureDir) {
  const inventory = JSON.parse(fs.readFileSync(path.join(fixtureDir, 'cameras.json'), 'utf8'))
  return inventory.cameras.map(camera => {
    const file = path.join(fixtureDir, 'video', `${camera.slug}.mkv`)
    const sdpPath = path.join(fixtureDir, 'sdp', `${camera.slug}.sdp`)
    if (!fs.existsSync(file)) throw new Error(`missing ${file}`)
    if (!fs.existsSync(sdpPath)) throw new Error(`missing ${sdpPath}`)
    const sdp = fs.readFileSync(sdpPath, 'utf8').replace(/\s+$/, '') + '\n'
    if (/ndi/i.test(camera.bonjour?.serviceType || '')) {
      throw new Error(`${camera.slug} advertises NDI; this farm will not publish NDI`)
    }
    return { ...camera, file, sdp }
  })
}

function sdpMedia(sdp) {
  const video = /a=rtpmap:(\d+)\s+(H264|H265|HEVC)\/(\d+)/i.exec(sdp)
  const audio = /a=rtpmap:(\d+)\s+mpeg4-generic\/(\d+)/i.exec(sdp)
  const videoSsrc = /m=video[\s\S]*?a=ssrc:(\d+)/i.exec(sdp)
  const audioSsrc = /m=audio[\s\S]*?a=ssrc:(\d+)/i.exec(sdp)
  if (!video || !audio) throw new Error('SDP is missing video or audio rtpmap')
  return {
    codec: video[2].toUpperCase() === 'H264' ? 'h264' : 'hevc',
    videoPayloadType: Number(video[1]),
    videoClock: Number(video[3]),
    audioPayloadType: Number(audio[1]),
    audioRate: Number(audio[2]),
    videoSsrc: videoSsrc ? Number(videoSsrc[1]) : null,
    audioSsrc: audioSsrc ? Number(audioSsrc[1]) : null
  }
}

/// A private address per camera, aliased onto the loopback interface: 10.255.77.1, .2, .3, .4.
///
/// Two constraints meet here. Director identifies a camera by its IPv4, so two cameras on one
/// address collapse into one row; and it only accepts a camera on a private LAN address — 10/8,
/// 172.16/12, 192.168/16 — because a phone whose Wi-Fi drops advertises its cellular address. So
/// 127.0.0.x will not do. A /32 alias on lo0 in 10/8 satisfies both, touches no real subnet, and an
/// iOS simulator reaches it because it shares this Mac's network stack. Adding one needs root.
const LOOPBACK_BASE = '10.255.77.'

function loopbackHosts(count) {
  const hosts = []
  for (let index = 0; index < count; index += 1) {
    const address = `${LOOPBACK_BASE}${index + 1}`
    if (!ensureLoopbackAlias(address)) {
      throw new Error(
        `could not alias ${address} onto lo0; this needs root or passwordless sudo, and without it `
        + 'Director has no private address to reach the cameras on'
      )
    }
    hosts.push(address)
  }
  return hosts
}

function ensureLoopbackAlias(address) {
  const env = { ...process.env, PATH: `/usr/sbin:/sbin:${process.env.PATH || ''}` }
  const existing = spawnSync('ifconfig', ['lo0'], { encoding: 'utf8', env })
  if ((existing.stdout || '').includes(`inet ${address} `)) return true
  const args = ['lo0', 'alias', address, 'netmask', '255.255.255.255', 'up']
  const added = isRoot()
    ? spawnSync('ifconfig', args, { encoding: 'utf8', env })
    : spawnSync('sudo', ['-n', 'ifconfig', ...args], { encoding: 'utf8', env })
  if (added.status !== 0) return false
  LOOPBACK_ALIASES.push(address)
  return true
}

function removeLoopbackAliases() {
  const env = { ...process.env, PATH: `/usr/sbin:/sbin:${process.env.PATH || ''}` }
  while (LOOPBACK_ALIASES.length > 0) {
    const address = LOOPBACK_ALIASES.pop()
    if (isRoot()) {
      spawnSync('ifconfig', ['lo0', '-alias', address], { encoding: 'utf8', env })
    } else {
      spawnSync('sudo', ['-n', 'ifconfig', 'lo0', '-alias', address], { encoding: 'utf8', env })
    }
  }
}

function isIPv4(entry) {
  return entry.family === 'IPv4' || entry.family === 4
}

/// The address that actually routes off-box — leftover ifconfig aliases are listed first
/// and are not reachable after Wi-Fi moves to another subnet.
function lanInterface() {
  const routed = defaultRouteInterface()
  const nics = os.networkInterfaces()
  const names = [routed?.name, 'en0', 'en1', ...Object.keys(nics)].filter(Boolean)
  for (const name of names) {
    const match = ipv4OnSubnet(nics[name] || [], routed?.gateway)
    if (match) return { name, address: match.address, netmask: match.netmask }
  }
  throw new Error('no LAN IPv4 interface')
}

function defaultRouteInterface() {
  const result = spawnSync('route', ['-n', 'get', 'default'], { encoding: 'utf8' })
  const name = /(?:^|\n)\s*interface:\s+(\S+)/.exec(result.stdout || '')?.[1]
  const gateway = /(?:^|\n)\s*gateway:\s+(\S+)/.exec(result.stdout || '')?.[1]
  return name ? { name, gateway } : null
}

function ipv4OnSubnet(entries, gateway) {
  const ipv4s = entries.filter(entry => isIPv4(entry) && !entry.internal)
  const gw = gateway ? parseIPv4(gateway) : null
  if (gw != null) {
    const match = ipv4s.find(entry => {
      const addr = parseIPv4(entry.address)
      const mask = parseIPv4(entry.netmask)
      return addr != null && mask != null && (addr & mask) === (gw & mask)
    })
    if (match) return match
  }
  return ipv4s[0] || null
}

function parseIPv4(text) {
  const parts = text.split('.').map(Number)
  if (parts.length !== 4 || parts.some(part => Number.isNaN(part) || part < 0 || part > 255)) {
    return null
  }
  return ((parts[0] << 24) >>> 0) + (parts[1] << 16) + (parts[2] << 8) + parts[3]
}

function formatIPv4(value) {
  return `${(value >>> 24) & 0xff}.${(value >>> 16) & 0xff}.${(value >>> 8) & 0xff}.${value & 0xff}`
}

function interfaceAddresses(name) {
  return (os.networkInterfaces()[name] || [])
    .filter(entry => entry.family === 'IPv4')
    .map(entry => entry.address)
}

function pingQuiet(host) {
  const result = spawnSync('ping', ['-c', '1', '-W', '200', host], { encoding: 'utf8' })
  return result.status === 0
}

function chooseHosts(count, nic, requested) {
  if (requested && requested.length !== count) {
    throw new Error(`--hosts needs ${count} addresses, got ${requested.length}`)
  }
  if (requested) return requested

  const addr = parseIPv4(nic.address)
  const mask = parseIPv4(nic.netmask)
  const network = addr & mask
  const broadcast = network | (~mask >>> 0)
  const existing = new Set(interfaceAddresses(nic.name))
  const chosen = []
  const prefer = []
  for (let offset = 201; offset <= 204; offset += 1) {
    const candidate = formatIPv4(network + offset)
    const numeric = parseIPv4(candidate)
    if (numeric > network && numeric < broadcast) prefer.push(candidate)
  }
  const scan = []
  for (let host = network + 1; host < broadcast; host += 1) {
    scan.push(formatIPv4(host >>> 0))
  }
  for (const candidate of [...prefer, ...scan]) {
    if (chosen.length >= count) break
    if (candidate === nic.address) continue
    if (existing.has(candidate)) {
      chosen.push(candidate)
      continue
    }
    if (pingQuiet(candidate)) continue
    chosen.push(candidate)
  }
  if (chosen.length < count) throw new Error(`could not find ${count} free IPv4s on ${nic.name}`)
  return chosen.slice(0, count)
}

function isRoot() {
  return typeof process.getuid === 'function' && process.getuid() === 0
}

function runRoot(command, args) {
  if (isRoot()) {
    const result = spawnSync(command, args, { encoding: 'utf8' })
    if (result.status !== 0) {
      throw new Error(`${command} ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
    }
    return
  }
  const result = spawnSync('sudo', ['-n', command, ...args], { encoding: 'utf8' })
  if (result.status !== 0) {
    throw new Error(
      `${command} needs root (aliases and :554). Re-run:\n  sudo -E "$(command -v node)" scripts/fakeRtspCameras.js\n${result.stderr}`
    )
  }
}

function addAlias(nic, address) {
  if (interfaceAddresses(nic.name).includes(address)) return false
  runRoot('ifconfig', [nic.name, 'inet', address, 'netmask', nic.netmask, 'alias'])
  return true
}

function removeAlias(nicName, address) {
  spawnSync('ifconfig', [nicName, 'inet', address, '-alias'], { encoding: 'utf8' })
  if (interfaceAddresses(nicName).includes(address) && !isRoot()) {
    spawnSync('sudo', ['-n', 'ifconfig', nicName, 'inet', address, '-alias'], { encoding: 'utf8' })
  }
}

function txtPairs(camera, host) {
  const txt = { ...(camera.bonjour.txt || {}) }
  delete txt.ndi
  delete txt.NDI
  txt.ip = host
  txt.busy = 'no'
  return Object.entries(txt)
    .filter(([key]) => !/ndi/i.test(key))
    .map(([key, value]) => `${key}=${value == null ? '' : String(value)}`)
}

function advertise(camera, host, rtspPort) {
  const serviceType = camera.bonjour.serviceType
  if (/ndi/i.test(serviceType)) {
    throw new Error(`refusing to advertise ${serviceType}`)
  }
  const srvPort = serviceType === '_awx_service._tcp' ? camera.bonjour.srvPort : rtspPort
  const hostname = String(camera.bonjour.hostname || `${camera.slug}.local`).replace(/\.$/, '')
  const args = [
    '-P',
    camera.bonjour.instance,
    serviceType,
    'local.',
    String(srvPort),
    hostname,
    host,
    ...txtPairs(camera, host)
  ]
  const child = spawn('dns-sd', args, { stdio: ['ignore', 'pipe', 'pipe'] })
  child.stdout.on('data', () => {})
  child.stderr.on('data', chunk => {
    process.stderr.write(`dns-sd ${camera.slug}: ${chunk}`)
  })
  return child
}

function ssrcFromSlug(slug, salt) {
  let hash = 2166136261 ^ salt
  for (const char of slug) {
    hash ^= char.charCodeAt(0)
    hash = Math.imul(hash, 16777619)
  }
  return hash >>> 0 || 1
}

function writeState(state) {
  fs.writeFileSync(STATE_PATH, `${JSON.stringify(state, null, 2)}\n`)
}

function stopFromState() {
  if (!fs.existsSync(STATE_PATH)) {
    process.stdout.write(`no farm state at ${STATE_PATH}\n`)
    return
  }
  const state = JSON.parse(fs.readFileSync(STATE_PATH, 'utf8'))
  for (const pid of state.pids || []) {
    try {
      process.kill(pid, 'SIGTERM')
    } catch {
      // Already gone.
    }
  }
  for (const alias of state.aliases || []) {
    removeAlias(alias.iface, alias.address)
  }
  fs.unlinkSync(STATE_PATH)
  process.stdout.write('stopped\n')
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  if (options.selfTest) {
    process.stdout.write(`${selfTest()}\n`)
    return
  }
  if (options.stop) {
    stopFromState()
    return
  }

  let cameras = loadInventory(options.fixtures)
  if (options.onlyCameraman && !options.cameraman) throw new Error('--only-cameraman needs --cameraman NAME')
  // The controllable phone reuses the captured Cameraman's media under its own identity.
  if (options.cameraman) {
    const template = cameras.find(camera => camera.kind === 'gs-cameraman') || cameras[cameras.length - 1]
    const uuid = 'c0ffee00-0000-4000-8000-000000000001'
    cameras.push({
      ...template,
      slug: 'gsCameraman-fake-control',
      kind: 'gs-cameraman-control',
      displayName: options.cameraman,
      bonjour: {
        serviceType: '_awx_service._tcp',
        instance: options.cameraman,
        hostname: `${uuid}.local.`,
        srvPort: 554,
        txt: { uuid, name: options.cameraman, path: '/live/mainstream', control: 'params/1' }
      },
      rtsp: { ...template.rtsp, server: 'GS Cameraman/1.0' },
      controlUUID: uuid
    })
  }
  if (options.onlyCameraman) cameras = cameras.filter(camera => camera.controlUUID)
  const nic = options.local ? null : lanInterface()
  const hosts = options.local
    ? loopbackHosts(cameras.length)
    : options.onlyCameraman
      ? [nic.address]
      : chooseHosts(cameras.length, nic, options.hosts)
  const addedAliases = []
  const servers = []
  const advertisers = []
  const sources = []

  const cleanup = async () => {
    for (const child of advertisers) {
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
    }
    for (const server of servers) {
      try {
        await server.close()
      } catch {
        // ignore
      }
    }
    for (const source of sources) source.stop()
    if (options.alias) {
      for (const alias of addedAliases) removeAlias(alias.iface, alias.address)
    }
    removeLoopbackAliases()
    if (fs.existsSync(STATE_PATH)) fs.unlinkSync(STATE_PATH)
  }

  process.on('SIGINT', () => {
    cleanup().finally(() => process.exit(0))
  })
  process.on('SIGTERM', () => {
    cleanup().finally(() => process.exit(0))
  })

  try {
    if (options.alias) {
      for (const host of hosts) {
        if (addAlias(nic, host)) addedAliases.push({ iface: nic.name, address: host })
      }
    }

    for (let index = 0; index < cameras.length; index += 1) {
      const camera = cameras[index]
      const host = hosts[index]
      const port = options.local ? options.basePort : 554
      const media = sdpMedia(camera.sdp)
      const source = new LoopSource({
        file: camera.file,
        codec: media.codec,
        videoPayloadType: media.videoPayloadType,
        audioPayloadType: media.audioPayloadType,
        videoClock: media.videoClock,
        frameRate: 30,
        audioRate: media.audioRate,
        videoSsrc: media.videoSsrc ?? ssrcFromSlug(camera.slug, 1),
        audioSsrc: media.audioSsrc ?? ssrcFromSlug(camera.slug, 2)
      })
      source.on('log', message => process.stderr.write(`${camera.slug}: ${message}`))
      source.on('error', error => process.stderr.write(`${camera.slug}: ${error.message}\n`))
      let parameters = null
      let publicMethods = null
      if (camera.controlUUID) {
        const model = new FakeCameramanModel({
          name: camera.displayName,
          uuid: camera.controlUUID,
          streamURL: `rtsp://${host}:${port}/live/mainstream`
        })
        parameters = request => model.handle(request)
        publicMethods = 'OPTIONS, DESCRIBE, SETUP, PLAY, PAUSE, TEARDOWN, GET_PARAMETER, SET_PARAMETER'
        camera.model = model
      }
      const server = createCameraServer({
        host,
        port,
        path: '/live/mainstream',
        sdp: camera.sdp,
        serverHeader: camera.rtsp.server,
        source,
        parameters,
        publicMethods,
        listenHost: options.onlyCameraman ? '0.0.0.0' : host
      })
      await server.listen()
      source.start()
      servers.push(server)
      sources.push(source)
      if (options.advertise) advertisers.push(advertise(camera, host, port))
      process.stdout.write(
        `${camera.displayName}  ${camera.bonjour.serviceType}  rtsp://${host}:${port}/live/mainstream\n`
      )
    }

    const phone = cameras.find(camera => camera.model)
    if (phone && options.statusPort > 0) {
      const status = http.createServer((request, response) => {
        const params = Object.fromEntries(phone.model.encode())
        response.setHeader('Content-Type', 'application/json')
        response.end(JSON.stringify(params))
      })
      status.listen(options.statusPort, '127.0.0.1')
      servers.push({ close: () => new Promise(resolve => status.close(resolve)) })
      process.stdout.write(`Phone status: http://127.0.0.1:${options.statusPort}/\n`)
    }

    writeState({
      pids: [process.pid, ...advertisers.map(child => child.pid).filter(Boolean)],
      aliases: options.alias
        ? hosts.map(address => ({ iface: nic.name, address }))
        : addedAliases
    })

    process.stdout.write(
      options.advertise
        ? `Advertising _awx_service._tcp (${cameras.filter(c => c.bonjour.serviceType === '_awx_service._tcp').length}) and _rtsp._tcp (${cameras.filter(c => c.bonjour.serviceType === '_rtsp._tcp').length}). No _ndi._tcp.\n`
        : 'RTSP only; Bonjour off.\n'
    )
    process.stdout.write('Ctrl-C to stop.\n')
    await new Promise(() => {})
  } catch (error) {
    await cleanup()
    throw error
  }
}

main().catch(error => {
  process.stderr.write(`${error.message}\n`)
  process.exit(1)
})
