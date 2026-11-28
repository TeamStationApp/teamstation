import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { APPLE_VENDOR, hlsEngine } from './attachHls'
import { H264_TYPE, HEVC_TYPE, mediaSourceType, playableHere } from './playable'

/** A browser as far as playing the video goes. */
function asBrowser(options: {
  vendor: string
  hevc: boolean | null
  /** Media Source takes H.264 as well; only where it exists at all. */
  h264?: boolean
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
              (options.hevc === true && type === HEVC_TYPE) ||
              (options.h264 === true && type === H264_TYPE)
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
        codecSupported: false
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
        codecSupported: false
      })
    ).equals('native')
  })

  it('asks about the codec each video is (U8)', function () {
    // Chrome on Linux: H.264 through Media Source, no HEVC.
    asBrowser({ vendor: 'Google Inc.', hevc: false, h264: true, hls: 'maybe' })
    expect(playableHere('avc1')).equals(true)
    expect(playableHere('avc3')).equals(true)
    expect(playableHere('hvc1')).equals(false)
    expect(playableHere('hev1')).equals(false)
    // A row without the tag is HEVC, as every older one is.
    expect(playableHere(null)).equals(false)
    expect(playableHere()).equals(false)
    // And one that decodes HEVC only plays those.
    asBrowser({ vendor: 'Google Inc.', hevc: true, h264: false, hls: 'maybe' })
    expect(playableHere('avc1')).equals(false)
    expect(playableHere('hvc1')).equals(true)
    expect(playableHere(undefined)).equals(true)
    // Apple's own player plays both, whatever its Media Source says.
    asBrowser({ vendor: APPLE_VENDOR, hevc: false, h264: false, hls: 'maybe' })
    expect(playableHere('avc1')).equals(true)
    expect(playableHere('hvc1')).equals(true)
  })

  it('stands for each family with one type, whatever its spelling (U8)', function () {
    expect(mediaSourceType('avc1')).equals(H264_TYPE)
    expect(mediaSourceType('AVC1.640028')).equals(H264_TYPE)
    expect(mediaSourceType('hvc1')).equals(HEVC_TYPE)
    expect(mediaSourceType('')).equals(HEVC_TYPE)
    expect(mediaSourceType(null)).equals(HEVC_TYPE)
  })

  it('plays through hls.js only where Media Source takes the codec (U9)', function () {
    expect(
      hlsEngine({
        vendor: 'Google Inc.',
        nativeHls: false,
        mediaSource: true,
        codecSupported: false
      })
    ).equals('none')
    expect(
      hlsEngine({
        vendor: 'Google Inc.',
        nativeHls: false,
        mediaSource: true,
        codecSupported: true
      })
    ).equals('hls.js')
  })
})
