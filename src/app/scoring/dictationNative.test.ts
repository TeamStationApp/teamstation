import { expect } from 'chai'
import { describe, it } from 'mocha'
import { act, createElement, type ReactNode } from 'react'
import { createRoot } from 'react-dom/client'

import { phoneDictationUrl } from './dictationAddress'
import { dictationHeaders } from './dictationHeaders'
import { dictationOn } from './dictationPlatform'
import { openDictationSocket as openBrowserSocket } from './dictationSocket'
import { openDictationSocket as openPhoneSocket } from './dictationSocket.native'
import {
  makeOpenMicrophone,
  openMicrophone,
  openPhoneMicrophone,
  type PcmModule
} from './microphone.native'
import { appendPcm, bytesFromBase64, PCM_FRAME_BYTES } from './pcmFrames'
import { CONTROL_COLORS, type ControlKind } from './scoringControlStyle'
import { useSpaceToTalk } from './spaceToTalk.native'
import { dictationUrl } from './useDictation.native'

/** Base64 of raw bytes, the shape the native module posts. */
function encode(bytes: Uint8Array): string {
  let binary = ''
  for (const byte of bytes) binary += String.fromCharCode(byte)
  return btoa(binary)
}

/** A constructor that records the arguments it was called with. */
function capturingSocket(seen: unknown[][]): unknown {
  return function Socket(...args: unknown[]): void {
    seen.push(args)
  }
}

/** Swaps a global for the test and puts the previous value back. */
function replaceGlobal(name: 'WebSocket', value: unknown): () => void {
  const prior = Object.getOwnPropertyDescriptor(globalThis, name)
  Object.defineProperty(globalThis, name, {
    configurable: true,
    writable: true,
    value
  })
  return () => {
    if (prior == null) Reflect.deleteProperty(globalThis, name)
    else Object.defineProperty(globalThis, name, prior)
  }
}

/** A module cache entry, so a later `require` returns `exports` and does not load the file. */
function cachedModule(id: string, exports: unknown): NodeJS.Module {
  const cached: NodeJS.Module = {
    id,
    filename: id,
    loaded: true,
    exports,
    children: [],
    paths: [],
    path: id,
    isPreloading: false,
    parent: null,
    require
  }
  return cached
}

function restoreCache(id: string, prior: NodeJS.Module | undefined): void {
  if (prior == null) Reflect.deleteProperty(require.cache, id)
  else require.cache[id] = prior
}

describe('dictation on the phone', function () {
  it('builds an absolute socket address and refuses a page-relative one', function () {
    // Loading the types file is what puts it in the coverage report.
    require('./dictationTypes')
    expect(phoneDictationUrl('https://app.teamstation.app/api/v1')).equals(
      'wss://app.teamstation.app/api/v1/dictation'
    )
    expect(dictationUrl('https://app.teamstation.app/api/v1')).equals(
      'wss://app.teamstation.app/api/v1/dictation'
    )
    expect(phoneDictationUrl('http://127.0.0.1:8080/api/v1/')).equals(
      'ws://127.0.0.1:8080/api/v1/dictation'
    )
    expect(() => phoneDictationUrl('/api/v1')).throws(
      'Dictation on the phone needs an absolute API address'
    )
    expect(() => phoneDictationUrl('')).throws(
      'Dictation on the phone needs an absolute API address'
    )
  })

  it('sends the session as a bearer header, and nothing when there is no token', function () {
    expect(dictationHeaders(undefined)).equals(undefined)
    expect(dictationHeaders('')).equals(undefined)
    expect(dictationHeaders('session-token')).deep.equals({
      Authorization: 'Bearer session-token'
    })
  })

  it('draws the button on the web, on iPhone and on Android', function () {
    expect(dictationOn('web')).equals(true)
    expect(dictationOn('ios')).equals(true)
    expect(dictationOn('android')).equals(true)
    expect(dictationOn('')).equals(false)
  })

  it('opens the phone socket with the bearer header, and without one when signed out', function () {
    const seen: unknown[][] = []
    const restore = replaceGlobal('WebSocket', capturingSocket(seen))
    try {
      openPhoneSocket('wss://app.teamstation.app/api/v1/dictation', 'tok')
      openPhoneSocket('wss://app.teamstation.app/api/v1/dictation')
      openPhoneSocket('wss://app.teamstation.app/api/v1/dictation', '')
      const missing = replaceGlobal('WebSocket', undefined)
      try {
        expect(() => openPhoneSocket('wss://example/dictation', 'tok')).throws(
          'This phone has no WebSocket'
        )
      } finally {
        missing()
      }
    } finally {
      restore()
    }
    expect(seen).deep.equals([
      [
        'wss://app.teamstation.app/api/v1/dictation',
        undefined,
        { headers: { Authorization: 'Bearer tok' } }
      ],
      ['wss://app.teamstation.app/api/v1/dictation'],
      ['wss://app.teamstation.app/api/v1/dictation']
    ])
  })

  it('opens the browser socket with no headers, so the cookie is what authenticates it', function () {
    const seen: unknown[][] = []
    const restore = replaceGlobal('WebSocket', capturingSocket(seen))
    try {
      openBrowserSocket('ws://localhost/api/v1/dictation', 'ignored')
    } finally {
      restore()
    }
    expect(seen).deep.equals([['ws://localhost/api/v1/dictation']])
  })

  it('refuses PCM that is not base64', function () {
    expect(() => bytesFromBase64('!!!!')).throws()
  })

  it('cuts base64 PCM into tenth-of-a-second frames and keeps the leftover', function () {
    expect(
      Array.from(bytesFromBase64(encode(Uint8Array.of(0, 255))))
    ).deep.equals([0, 255])
    const whole = new Uint8Array(PCM_FRAME_BYTES)
    whole[0] = 7
    const exact = appendPcm(new Uint8Array(0), whole)
    expect(exact.frames).to.have.length(1)
    expect(exact.frames[0].byteLength).equals(PCM_FRAME_BYTES)
    expect(new Uint8Array(exact.frames[0])[0]).equals(7)
    expect(exact.rest).to.have.length(0)

    const short = appendPcm(new Uint8Array(0), whole.slice(0, 100))
    expect(short.frames).to.have.length(0)
    expect(short.rest).to.have.length(100)

    const joined = appendPcm(short.rest, new Uint8Array(PCM_FRAME_BYTES))
    expect(joined.frames).to.have.length(1)
    expect(joined.rest).to.have.length(100)

    const bulk = new Uint8Array(PCM_FRAME_BYTES * 2 + 5)
    const two = appendPcm(new Uint8Array(0), bulk)
    expect(two.frames).to.have.length(2)
    expect(two.rest).to.have.length(5)
  })

  it('forwards whole frames from the microphone and drops an empty chunk', async function () {
    const frames: ArrayBuffer[] = []
    let listener: ((event: { pcm: string }) => void) | undefined
    let removed = 0
    let stopped = 0
    const module: PcmModule = {
      async start() {},
      stop() {
        stopped++
      },
      onPcm(next) {
        listener = next
        return {
          remove() {
            removed++
          }
        }
      }
    }
    const mic = await makeOpenMicrophone(module)(frame => {
      frames.push(frame)
    })
    listener?.({ pcm: '' })
    const raw = new Uint8Array(PCM_FRAME_BYTES + 10)
    raw[0] = 3
    listener?.({ pcm: encode(raw) })
    expect(frames).to.have.length(1)
    expect(new Uint8Array(frames[0])[0]).equals(3)
    mic.stop()
    expect(removed).equals(1)
    expect(stopped).equals(1)
  })

  it('unsubscribes when the microphone refuses to start', async function () {
    let removed = 0
    const module: PcmModule = {
      async start() {
        throw new Error('permission denied')
      },
      stop() {},
      onPcm() {
        return {
          remove() {
            removed++
          }
        }
      }
    }
    try {
      await openPhoneMicrophone(() => undefined, module)
      expect.fail('start should reject')
    } catch (error) {
      expect(error).instanceOf(Error)
      expect((error as Error).message).equals('permission denied')
    }
    expect(removed).equals(1)
  })

  it('loads the native module when no stand-in is passed', async function () {
    const nativeSpec = require.resolve('../walkup/NativeDictationMicrophone')
    const frames: ArrayBuffer[] = []
    let listener: ((event: { pcm: string }) => void) | undefined
    let removed = 0
    const fake: PcmModule = {
      async start() {},
      stop() {},
      onPcm(next) {
        listener = next
        return {
          remove() {
            removed++
          }
        }
      }
    }
    const prior = require.cache[nativeSpec]
    require.cache[nativeSpec] = cachedModule(nativeSpec, { default: fake })
    try {
      const mic = await openMicrophone(frame => {
        frames.push(frame)
      })
      listener?.({ pcm: encode(new Uint8Array(PCM_FRAME_BYTES)) })
      expect(frames).to.have.length(1)
      mic.stop()
      expect(removed).equals(1)
    } finally {
      restoreCache(nativeSpec, prior)
    }
  })

  it('reads the microphone spec once React Native can answer for it', function () {
    const reactNative = require.resolve('react-native')
    const nativeSpec = require.resolve('../walkup/NativeDictationMicrophone')
    const priorReact = require.cache[reactNative]
    const priorSpec = require.cache[nativeSpec]
    let asked: string | undefined
    require.cache[reactNative] = cachedModule(reactNative, {
      TurboModuleRegistry: {
        getEnforcing(name: string) {
          asked = name
          return {}
        }
      }
    })
    Reflect.deleteProperty(require.cache, nativeSpec)
    try {
      require('../walkup/NativeDictationMicrophone')
      expect(asked).equals('DictationMicrophone')
    } finally {
      restoreCache(reactNative, priorReact)
      restoreCache(nativeSpec, priorSpec)
    }
  })

  it('draws every phone backdrop and deck icon', async function () {
    const reactNative = require.resolve('react-native')
    const svg = require.resolve('react-native-svg')
    const priorReact = require.cache[reactNative]
    const priorSvg = require.cache[svg]
    function element(type: string) {
      return function Element(props: { children?: ReactNode }) {
        return createElement(type, {}, props.children)
      }
    }
    require.cache[reactNative] = cachedModule(reactNative, {
      __esModule: true,
      View: element('div')
    })
    require.cache[svg] = cachedModule(svg, {
      __esModule: true,
      default: element('svg'),
      Circle: element('circle'),
      Defs: element('defs'),
      LinearGradient: element('linearGradient'),
      Path: element('path'),
      Rect: element('rect'),
      Stop: element('stop')
    })
    const art = require('./ScoringControlArt.native.tsx') as {
      ControlBackdrop: (props: {
        kind: keyof typeof CONTROL_COLORS
      }) => ReturnType<typeof createElement>
      ControlIcon: (props: {
        kind: ControlKind
      }) => ReturnType<typeof createElement>
    }
    const icons: ControlKind[] = [
      'more',
      'undo',
      'ball',
      'called',
      'swing',
      'foul',
      'contact',
      'music'
    ]
    const host = document.createElement('div')
    const root = createRoot(host)
    try {
      await act(async () => {
        root.render(
          createElement(
            'div',
            {},
            ...Object.keys(CONTROL_COLORS).map(kind =>
              createElement(art.ControlBackdrop, {
                key: `backdrop-${kind}`,
                kind: kind as keyof typeof CONTROL_COLORS
              })
            ),
            ...icons.map(kind =>
              createElement(art.ControlIcon, { key: `icon-${kind}`, kind })
            )
          )
        )
      })
      expect(host.querySelectorAll('svg').length).equals(
        Object.keys(CONTROL_COLORS).length + icons.length
      )
    } finally {
      await act(async () => {
        root.unmount()
      })
      restoreCache(reactNative, priorReact)
      restoreCache(svg, priorSvg)
    }
  })

  it('keeps a space hook so the scoring screen calls the same thing', async function () {
    function Probe(): null {
      useSpaceToTalk(true, true, {
        current: { hold() {}, release() {} }
      })
      return null
    }
    const node = document.createElement('div')
    const root = createRoot(node)
    await act(async () => {
      root.render(createElement(Probe))
    })
    await act(async () => {
      root.unmount()
    })
  })
})
