import { expect } from 'chai'
import { describe, it } from 'mocha'

const safari = 'AppleWebKit/605.1.15 Version/18.0 Mobile/15E148 Safari/604.1'
const desktopSafari =
  'Macintosh AppleWebKit/605.1.15 Version/26.5 Safari/605.1.15'
interface Probe {
  ua?: string
  platform?: string
  touches?: number
  framed?: boolean
  loaded?: boolean
  value?: string
  stalled?: boolean
  repeat?: boolean
}

/** Run both parser scripts, including the deadline while a stylesheet is held. */
function load(options: Probe = {}): { requests: string[]; tags: string[] } {
  const requests: string[] = []
  const tags: string[] = []
  const window = { top: {} }
  if (options.framed !== true) window.top = window
  let expire: () => void = () => {
    throw new Error('missing timer')
  }
  const sheet = {
    disabled: false,
    removed: false,
    remove() {
      this.removed = true
    }
  }
  const document = {
    readyState: options.loaded === true ? 'complete' : 'loading',
    querySelector: () => tags[0],
    getElementById: () => sheet,
    write: (value: string) => {
      const href = /^<link rel="stylesheet" [^>]*href="([^"]+)">$/.exec(
        value
      )?.[1]
      if (href != null) requests.push(href)
      else tags.push(value)
    },
    teamStationFinishAppBanner: undefined as (() => void) | undefined
  }
  const globals = {
    window,
    document,
    setTimeout: (callback: () => void, delay: number) => {
      expect(delay).equals(1500)
      expire = callback
      return 1
    },
    clearTimeout: (timer: number) => expect(timer).equals(1),
    getComputedStyle: () => ({
      getPropertyValue: () => options.value ?? '00042'
    }),
    navigator: {
      userAgent: options.ua ?? 'iPhone ' + safari,
      platform: options.platform ?? 'iPhone',
      maxTouchPoints: options.touches ?? 5
    },
    TS_API_BASE_URL: 'https://api.example.test/api/v1//'
  }
  const original = Object.getOwnPropertyDescriptors(globalThis)
  const file = require.resolve('./iosAppBanner')
  try {
    for (const [key, value] of Object.entries(globals))
      Object.defineProperty(globalThis, key, { value, configurable: true })
    for (let i = 0; i < (options.repeat === true ? 2 : 1); i++) {
      Reflect.deleteProperty(require.cache, file)
      require(file)
    }
    if (options.stalled === true) {
      expire()
      expect(sheet.disabled && sheet.removed).equals(true)
    }
    document.teamStationFinishAppBanner?.()
    document.teamStationFinishAppBanner?.()
  } finally {
    Reflect.deleteProperty(require.cache, file)
    for (const key of Object.keys(globals)) {
      const descriptor = Object.getOwnPropertyDescriptor(original, key)?.value
      if (descriptor == null) Reflect.deleteProperty(globalThis, key)
      else Object.defineProperty(globalThis, key, descriptor)
    }
  }
  return { requests, tags }
}

describe('Safari Smart App Banner in the parsing head', () => {
  it('offers the path ID once on iPhone and iPad, including desktop mode', () => {
    for (const options of [
      { repeat: true },
      { ua: 'iPad ' + safari },
      { ua: desktopSafari, platform: 'MacIntel', touches: 5 }
    ]) {
      expect(load(options)).deep.equals({
        requests: ['https://api.example.test/api/v1/node/ios-app-banner'],
        tags: ['<meta name="apple-itunes-app" content="app-id=00042">']
      })
    }
  })
  it('skips branded Brave and DuckDuckGo on iPhone and desktop-mode iPad', () => {
    for (const suffix of [' Brave', ' Ddg/26.5']) {
      for (const options of [
        { ua: 'iPhone ' + safari + suffix },
        { ua: desktopSafari + suffix, platform: 'MacIntel', touches: 5 }
      ]) {
        expect(load(options), options.ua).deep.equals({
          requests: [],
          tags: []
        })
      }
    }
  })
  it('never requests metadata in other browsers, frames, or after head parsing', () => {
    for (const options of [
      { ua: 'Macintosh ' + safari, platform: 'MacIntel', touches: 0 },
      { ua: 'Android ' + safari },
      { ua: 'iPod touch ' + safari },
      { framed: true },
      { loaded: true },
      { ua: 'iPhone AppleWebKit/605.1.15 Mobile/15E148' },
      ...['CriOS', 'FxiOS', 'EdgiOS', 'OPiOS', 'GSA', 'DuckDuckGo'].map(
        name => ({ ua: 'iPhone ' + name + '/1 ' + safari })
      )
    ])
      expect(load(options)).deep.equals({ requests: [], tags: [] })
  })
  it('continues loading on an unavailable or malformed response', () => {
    for (const options of [
      { stalled: true },
      ...['', ' ', '42x', '42; color:red', 'null'].map(value => ({ value }))
    ]) {
      const result = load({ ...options, repeat: true })
      expect(result.requests).length(1)
      expect(result.tags).deep.equals([])
    }
  })
})
