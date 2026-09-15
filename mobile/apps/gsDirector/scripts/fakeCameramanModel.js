// An in-memory GS Cameraman for the fake camera farm: the parameter vocabulary in
// docs/rtsp-interop.md (Cameraman) answered from a model that zooms, flips and reconfigures the way
// the phone does, so Director and Preview control flows run on a simulator with no phone attached.
//
// Shape mirrors an iPhone 13 Pro: 0.5x / 1x / 3x back lenses, 9x ceiling, a single 1x front
// camera with a 5x digital ceiling. Formats come from gsCameraman/docs/capabilities.json when
// present.

'use strict'

const fs = require('node:fs')
const path = require('node:path')

const WRITABLE = new Set([
  'device.name', 'videoSource.position', 'ptz.zoom', 'videoEncoder.encoding',
  'videoEncoder.resolution.width', 'videoEncoder.resolution.height',
  'videoEncoder.rateControl.frameRateLimit', 'videoEncoder.rateControl.bitrateLimit',
  'videoEncoder.rateControl.bitrateFloor', 'videoEncoder.rateControl.adaptive', 'audioEncoder.enabled',
  'lens.disabled'
])

const BACK_MAPPING = { min: 1, max: 18, multiplier: 0.5, switchOvers: [2, 6] }
const FRONT_MAPPING = { min: 1, max: 5, multiplier: 1, switchOvers: [] }

const LENSES = [
  { id: 'uw', position: 'back', deviceType: 'AVCaptureDeviceTypeBuiltInUltraWideCamera', title: '13 mm', displayedZoom: 0.5, focalLengthMM: 13, native: false },
  { id: 'wide', position: 'back', deviceType: 'AVCaptureDeviceTypeBuiltInWideAngleCamera', title: '26 mm', displayedZoom: 1, focalLengthMM: 26, native: false },
  { id: 'tele', position: 'back', deviceType: 'AVCaptureDeviceTypeBuiltInTelephotoCamera', title: '77 mm', displayedZoom: 3, focalLengthMM: 77, native: false },
  { id: 'front', position: 'front', deviceType: 'AVCaptureDeviceTypeBuiltInWideAngleCamera', title: '1x', displayedZoom: 1, focalLengthMM: null, native: false }
]

function loadFormats () {
  const file = path.resolve(__dirname, '..', '..', 'gsCameraman', 'docs', 'capabilities.json')
  const fallback = [
    { width: 1280, height: 720, frameRate: 30, multiLens: true },
    { width: 1920, height: 1080, frameRate: 30, multiLens: true },
    { width: 1920, height: 1080, frameRate: 60, multiLens: true },
    { width: 3840, height: 2160, frameRate: 30, multiLens: false }
  ]
  try {
    const report = JSON.parse(fs.readFileSync(file, 'utf8'))
    const device = (report.devices || []).find(entry => /Triple/.test(entry.deviceType || '')) || (report.devices || [])[0]
    if (!device || !Array.isArray(device.formats)) return fallback
    const seen = new Map()
    for (const format of device.formats) {
      for (const rate of [24, 25, 30, 50, 60, 120, 240]) {
        if (rate < (format.minimumFrameRate ?? 1) - 0.01 || rate > (format.maximumFrameRate ?? 0) + 0.01) continue
        const key = `${format.width}x${format.height}@${rate}`
        const multi = Boolean(format.supportsMultiLensSwitching)
        seen.set(key, { width: format.width, height: format.height, frameRate: rate, multiLens: (seen.get(key)?.multiLens) || multi })
      }
    }
    const list = [...seen.values()].sort((a, b) => (a.width * a.height - b.width * b.height) || (a.frameRate - b.frameRate))
    return list.length ? list : fallback
  } catch {
    return fallback
  }
}

function number (value) {
  if (Number.isInteger(value)) return String(value)
  return String(Number(value.toFixed(3)))
}

class FakeCameramanModel {
  constructor ({ name, uuid, streamURL }) {
    this.name = name
    this.cname = uuid
    this.model = 'iPhone14,2'
    this.thermal = 'nominal'
    this.battery = 87
    this.charging = false
    this.status = 'running'
    this.position = 'back'
    this.deviceZoom = 2 // 1x displayed on the back triple camera
    this.codec = 'H265'
    this.width = 1920
    this.height = 1080
    this.frameRate = 30
    this.bitrateKbps = 4000
    this.bitrateFloorKbps = 2000
    this.adaptive = true
    this.audio = true
    this.disabled = new Set()
    this.formats = loadFormats()
    this.streamURL = streamURL
    this.clients = 0
  }

  mapping () { return this.position === 'back' ? BACK_MAPPING : FRONT_MAPPING }
  displayedZoom () { return this.deviceZoom * this.mapping().multiplier }
  clampDevice (value) { const m = this.mapping(); return Math.min(Math.max(value, m.min), m.max) }

  encode () {
    const m = this.mapping()
    const pairs = [
      ['device.name', this.name], ['device.cname', this.cname], ['device.model', this.model],
      ['system.thermal', this.thermal], ['system.status', this.status],
      ['system.battery', String(this.battery)], ['system.battery.charging', String(this.charging)],
      ['videoSource.position', this.position],
      ['videoSource.deviceType', this.position === 'back' ? 'AVCaptureDeviceTypeBuiltInTripleCamera' : 'AVCaptureDeviceTypeBuiltInWideAngleCamera'],
      ['videoSource.zoom.minimumDevice', number(m.min)], ['videoSource.zoom.maximumDevice', number(m.max)],
      ['videoSource.zoom.displayMultiplier', number(m.multiplier)],
      ['videoSource.zoom.switchOverDevice', m.switchOvers.map(number).join(',')],
      ['ptz.zoom', number(this.displayedZoom())], ['ptz.zoom.device', number(this.deviceZoom)],
      ['videoEncoder.encoding', this.codec],
      ['videoEncoder.resolution.width', String(this.width)], ['videoEncoder.resolution.height', String(this.height)],
      ['videoEncoder.rateControl.frameRateLimit', number(this.frameRate)],
      ['videoEncoder.rateControl.bitrateLimit', String(this.bitrateKbps)],
      ['videoEncoder.rateControl.bitrateFloor', String(this.bitrateFloorKbps)],
      // A fake link never congests, so it always runs at the ceiling.
      ['videoEncoder.rateControl.adaptive', String(this.adaptive)],
      ['videoEncoder.rateControl.currentBitrate', String(this.bitrateKbps)],
      ['videoEncoder.formats', String(this.formats.length)]
    ]
    this.formats.forEach((format, index) => {
      pairs.push([`format.${index}.width`, String(format.width)], [`format.${index}.height`, String(format.height)],
        [`format.${index}.frameRate`, number(format.frameRate)], [`format.${index}.multiLens`, String(format.multiLens)])
    })
    pairs.push(['audioEncoder.enabled', String(this.audio)], ['audioEncoder.sampleRate', '48000'], ['lens.count', String(LENSES.length)])
    LENSES.forEach((lens, index) => {
      pairs.push([`lens.${index}.id`, lens.id], [`lens.${index}.position`, lens.position], [`lens.${index}.deviceType`, lens.deviceType],
        [`lens.${index}.title`, lens.title], [`lens.${index}.displayedZoom`, number(lens.displayedZoom)],
        [`lens.${index}.focalLengthMM`, lens.focalLengthMM == null ? '' : String(lens.focalLengthMM)], [`lens.${index}.native`, String(lens.native)])
    })
    pairs.push(['lens.disabled', [...this.disabled].sort().join(',')], ['stream.url', this.streamURL], ['stream.clients', String(this.clients)])
    return pairs
  }

  static body (pairs) { return pairs.map(([name, value]) => `${name}: ${value}\r\n`).join('') }

  get (body) {
    const names = body.split('\n').map(line => line.replace(/:.*$/, '').trim()).filter(Boolean)
    const all = this.encode()
    if (names.length === 1 && names[0] === '*') return { status: 200, reason: 'OK', body: FakeCameramanModel.body(all) }
    const map = new Map(all)
    const out = []
    for (const name of names) {
      if (!map.has(name)) return { status: 451, reason: 'Parameter Not Understood', body: `${name}\r\nunknown parameter\r\n` }
      out.push([name, map.get(name)])
    }
    return { status: 200, reason: 'OK', body: FakeCameramanModel.body(out) }
  }

  set (body) {
    const known = new Set(this.encode().map(([name]) => name))
    const lines = body.split('\n').map(line => line.trim()).filter(Boolean)
    const writes = []
    const seen = new Set()
    const bad = (name, detail) => ({ status: 400, reason: 'Bad Request', body: `${name}\r\n${detail}\r\n` })
    for (const line of lines) {
      const colon = line.indexOf(':')
      if (colon < 0) return bad(line, 'expected `name: value`')
      const name = line.slice(0, colon).trim()
      const value = line.slice(colon + 1).trim()
      if (seen.has(name)) return bad(name, 'repeated name')
      seen.add(name)
      if (!known.has(name)) return { status: 451, reason: 'Parameter Not Understood', body: `${name}\r\nunknown parameter\r\n` }
      if (!WRITABLE.has(name)) return { status: 458, reason: 'Parameter Is Read-Only', body: `${name}\r\nread-only parameter\r\n` }
      writes.push([name, value])
    }
    // Validate everything before applying anything.
    const next = {}
    for (const [name, value] of writes) {
      switch (name) {
        case 'device.name': next.name = value.trim() || `Camera ${this.cname.replace(/-/g, '').slice(-4).toUpperCase()}`; break
        case 'videoSource.position': if (!['back', 'front'].includes(value)) return bad(name, 'expected back or front'); next.position = value; break
        case 'ptz.zoom': { const z = Number(value); if (!Number.isFinite(z) || z <= 0) return bad(name, 'expected a positive number'); next.zoom = z; break }
        case 'videoEncoder.encoding': { const c = value.toUpperCase(); if (c === 'HEVC') next.codec = 'H265'; else if (c === 'H264' || c === 'H265') next.codec = c; else return bad(name, 'expected H264 or H265'); break }
        case 'videoEncoder.resolution.width': next.width = Number(value); if (!(next.width > 0)) return bad(name, 'expected a positive integer'); break
        case 'videoEncoder.resolution.height': next.height = Number(value); if (!(next.height > 0)) return bad(name, 'expected a positive integer'); break
        case 'videoEncoder.rateControl.frameRateLimit': next.frameRate = Number(value); if (!(next.frameRate > 0)) return bad(name, 'expected a positive number'); break
        case 'videoEncoder.rateControl.bitrateLimit': next.bitrateKbps = Number(value); if (!Number.isInteger(next.bitrateKbps) || next.bitrateKbps < 1000 || next.bitrateKbps > 50000) return bad(name, 'expected 1000…50000 kbps'); break
        case 'videoEncoder.rateControl.bitrateFloor': next.bitrateFloorKbps = Number(value); if (!Number.isInteger(next.bitrateFloorKbps) || next.bitrateFloorKbps < 1000 || next.bitrateFloorKbps > 50000) return bad(name, 'expected 1000…50000 kbps'); break
        case 'videoEncoder.rateControl.adaptive': if (!['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase())) return bad(name, 'expected true or false'); next.adaptive = ['true', '1', 'yes', 'on'].includes(value.toLowerCase()); break
        case 'audioEncoder.enabled': if (!['true', 'false', '1', '0', 'yes', 'no', 'on', 'off'].includes(value.toLowerCase())) return bad(name, 'expected true or false'); next.audio = ['true', '1', 'yes', 'on'].includes(value.toLowerCase()); break
        case 'lens.disabled': {
          const ids = value.split(',').map(entry => entry.trim()).filter(Boolean)
          for (const id of ids) if (!LENSES.some(lens => lens.id === id)) return bad(name, `unknown lens id ${id}`)
          for (const position of ['back', 'front']) {
            if (!LENSES.some(lens => lens.position === position && !ids.includes(lens.id))) return bad(name, `would disable the last ${position} lens`)
          }
          next.disabled = new Set(ids); break
        }
      }
    }
    if (next.width != null || next.height != null || next.frameRate != null) {
      const w = next.width ?? this.width; const h = next.height ?? this.height; const r = next.frameRate ?? this.frameRate
      if (!this.formats.some(f => f.width === w && f.height === h && Math.abs(f.frameRate - r) < 0.01)) {
        const which = next.frameRate != null ? 'videoEncoder.rateControl.frameRateLimit' : next.height != null ? 'videoEncoder.resolution.height' : 'videoEncoder.resolution.width'
        return bad(which, `${w}x${h}@${number(r)} is not an offered format`)
      }
    }
    // The phone's rate rules: a new rate carries a floor still at the old rate's default (half, not
    // below 1000) to the new rate's, and a floor is never above the rate.
    const defaultFloor = kbps => Math.min(kbps, Math.max(1000, Math.floor(kbps / 2)))
    const rateAfter = (rate, floor, nextRate) => ({
      rate: nextRate,
      floor: Math.min(floor === defaultFloor(rate) ? defaultFloor(nextRate) : floor, nextRate)
    })
    const defaults = { H264: 6000, H265: 4000 }
    let rate = { rate: this.bitrateKbps, floor: this.bitrateFloorKbps }
    if (next.codec != null && rate.rate === defaults[this.codec]) rate = rateAfter(rate.rate, rate.floor, defaults[next.codec])
    if (next.bitrateKbps != null) rate = rateAfter(rate.rate, rate.floor, next.bitrateKbps)
    // A named floor is judged against the rate it will sit under.
    if (next.bitrateFloorKbps != null) {
      if (next.bitrateFloorKbps > rate.rate) return bad('videoEncoder.rateControl.bitrateFloor', `${next.bitrateFloorKbps} kbps is above the ${rate.rate} kbps bitrateLimit`)
      rate.floor = next.bitrateFloorKbps
    }
    // Apply.
    if (next.name != null) this.name = next.name
    if (next.position != null && next.position !== this.position) { this.position = next.position; this.deviceZoom = this.position === 'back' ? 2 : 1 }
    if (next.codec != null) this.codec = next.codec
    if (next.width != null) this.width = next.width
    if (next.height != null) this.height = next.height
    if (next.frameRate != null) this.frameRate = next.frameRate
    this.bitrateKbps = rate.rate
    this.bitrateFloorKbps = rate.floor
    if (next.adaptive != null) this.adaptive = next.adaptive
    if (next.audio != null) this.audio = next.audio
    if (next.disabled != null) this.disabled = next.disabled
    if (next.zoom != null) this.deviceZoom = this.clampDevice(next.zoom / this.mapping().multiplier)
    const map = new Map(this.encode())
    return { status: 200, reason: 'OK', body: FakeCameramanModel.body(writes.map(([name]) => [name, map.get(name)])) }
  }

  handle ({ method, body }) {
    return method === 'GET' ? this.get(body) : this.set(body)
  }
}

module.exports = { FakeCameramanModel }
