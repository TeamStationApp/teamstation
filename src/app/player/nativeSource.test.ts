import { expect } from 'chai'
import { describe, it } from 'mocha'

import { LIVE_DELAY_SEC } from './liveDelay'
import { nativeSource } from './nativeSource'

const URI = 'https://media.example.test/videos/vid_00000000/master.m3u8'

describe('the source a phone’s player is given', function () {
  it('carries the live cushion, at normal speed, for a live game', function () {
    expect(nativeSource(URI, { live: true })).deep.equals({
      uri: URI,
      bufferConfig: {
        live: {
          targetOffsetMs: LIVE_DELAY_SEC * 1000,
          minPlaybackSpeed: 1,
          maxPlaybackSpeed: 1
        }
      }
    })
  })

  it('carries a grid tile’s buffer, and nothing for a plain recording', function () {
    expect(
      nativeSource(URI, {
        live: false,
        aheadSec: 30,
        startSec: 5,
        behindSec: 20,
        heapShare: 0.25
      }).bufferConfig
    ).deep.equals({
      minBufferMs: 30_000,
      maxBufferMs: 30_000,
      bufferForPlaybackMs: 5000,
      bufferForPlaybackAfterRebufferMs: 5000,
      backBufferDurationMs: 20_000,
      maxHeapAllocationPercent: 0.25
    })
    expect(nativeSource(URI, { live: false, aheadSec: 30 })).deep.equals({
      uri: URI
    })
  })
})
