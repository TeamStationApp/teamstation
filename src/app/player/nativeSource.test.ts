import { expect } from 'chai'
import { describe, it } from 'mocha'

import { LIVE_DELAY_SEC } from './liveDelay'
import { TILE_BUFFER } from './multiCam/buffering'
import { nativeSource } from './nativeSource'

const URI = 'https://media.example.test/videos/vid_00000000/master.m3u8'

describe('the source a phone’s player is given (U30)', function () {
  it('carries half a minute ahead and twenty seconds behind for the single player, and the live cushion 45 s back', function () {
    expect(nativeSource(URI, { live: true })).deep.equals({
      uri: URI,
      bufferConfig: {
        minBufferMs: 30_000,
        maxBufferMs: 30_000,
        backBufferDurationMs: 20_000,
        live: {
          targetOffsetMs: 45_000,
          minPlaybackSpeed: 1,
          maxPlaybackSpeed: 1
        }
      }
    })
    expect(LIVE_DELAY_SEC * 1000).equals(45_000)
    expect(nativeSource(URI, { live: false }).bufferConfig).deep.equals({
      minBufferMs: 30_000,
      maxBufferMs: 30_000,
      backBufferDurationMs: 20_000
    })
  })

  it('carries a grid tile’s buffer, its start and its share of the heap', function () {
    expect(
      nativeSource(URI, { live: false, ...TILE_BUFFER }).bufferConfig
    ).deep.equals({
      minBufferMs: 30_000,
      maxBufferMs: 30_000,
      bufferForPlaybackMs: 5000,
      bufferForPlaybackAfterRebufferMs: 5000,
      backBufferDurationMs: 20_000,
      maxHeapAllocationPercent: 0.15
    })
  })
})
