import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { APPLE_VENDOR, hlsEngine } from './attachHls'
import { HEVC_TYPE, playableHere } from './playable'

/** A browser as far as playing the video goes. */
function asBrowser(options: {
  vendor: string
  hevc: boolean | null
  hls: '' | 'maybe'
}): void {
  Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { vendor: options.vendor }
  })
  Object.defineProperty(globalThis, 'MediaSource', {
    configurable: true,
    value:
      options.hevc == null
        ? undefined
        : {
            isTypeSupported: (type: string) =>
              options.hevc === true && type === HEVC_TYPE
          }
  })
  Object.defineProperty(globalThis, 'document', {
    configurable: true,
    value: {
      createElement: () => ({ canPlayType: () => options.hls })
    }
  })
}

describe('a browser that can play the video (U31)', function () {
  let saved: Array<readonly [string, PropertyDescriptor | undefined]> = []
  beforeEach(function () {
    saved = ['navigator', 'MediaSource', 'document'].map(
      name => [name, Object.getOwnPropertyDescriptor(globalThis, name)] as const
    )
  })

  afterEach(function () {
    for (const [name, descriptor] of saved) {
      if (descriptor == null) Reflect.deleteProperty(globalThis, name)
      else Object.defineProperty(globalThis, name, descriptor)
    }
  })

  it('is one whose Media Source takes HEVC', function () {
    asBrowser({ vendor: 'Google Inc.', hevc: true, hls: 'maybe' })
    expect(playableHere()).equals(true)
  })

  it('is not Chrome answering maybe to HLS without HEVC', function () {
    asBrowser({ vendor: 'Google Inc.', hevc: false, hls: 'maybe' })
    expect(playableHere()).equals(false)
    asBrowser({ vendor: '', hevc: null, hls: '' })
    expect(playableHere()).equals(false)
  })

  it('is Apple’s engine with HLS of its own', function () {
    asBrowser({ vendor: APPLE_VENDOR, hevc: false, hls: 'maybe' })
    expect(playableHere()).equals(true)
    asBrowser({ vendor: APPLE_VENDOR, hevc: null, hls: '' })
    expect(playableHere()).equals(false)
  })

  it('is played by nobody where neither holds', function () {
    expect(
      hlsEngine({
        vendor: 'Google Inc.',
        nativeHls: true,
        mediaSource: true,
        hevc: false
      })
    ).equals('none')
    expect(
      hlsEngine({ vendor: 'Google Inc.', nativeHls: true, mediaSource: false })
    ).equals('none')
    expect(
      hlsEngine({
        vendor: APPLE_VENDOR,
        nativeHls: true,
        mediaSource: false,
        hevc: false
      })
    ).equals('native')
  })
})
