import type { ReactVideoSource } from 'react-native-video'

import { LIVE_DELAY_SEC } from './liveDelay'

/** What a phone's player is told about a source, besides its address. */
export interface NativeSourceOptions {
  /** A game still being written, watched on its own. */
  live: boolean
  aheadSec?: number
  startSec?: number
  behindSec?: number
  heapShare?: number
}

/**
 * The source as react-native-video takes it.
 *
 * Android takes its buffer and live settings with the source, so they are
 * built here once per address and setting — and a reload hands back this same
 * object, so ExoPlayer keeps them.
 */
export function nativeSource(
  uri: string,
  options: NativeSourceOptions
): ReactVideoSource {
  const { live, aheadSec, startSec, behindSec, heapShare } = options
  if (live) {
    return {
      uri,
      bufferConfig: {
        // ExoPlayer keeps a live game this far behind its newest footage,
        // the browser's cushion, instead of three segments (twelve seconds):
        // long enough to ride out a field whose uplink stops for a quarter of
        // a minute. Held at normal speed, so the sound never drifts in pitch
        // to win the time back.
        live: {
          targetOffsetMs: LIVE_DELAY_SEC * 1000,
          minPlaybackSpeed: 1,
          maxPlaybackSpeed: 1
        }
      }
    }
  }
  if (
    aheadSec == null ||
    startSec == null ||
    behindSec == null ||
    heapShare == null
  ) {
    return { uri }
  }
  return {
    uri,
    bufferConfig: {
      // The same number twice keeps it topping up all the time, the way
      // hls.js does, rather than filling, draining to the lower mark and
      // filling again.
      minBufferMs: aheadSec * 1000,
      maxBufferMs: aheadSec * 1000,
      bufferForPlaybackMs: startSec * 1000,
      bufferForPlaybackAfterRebufferMs: startSec * 1000,
      backBufferDurationMs: behindSec * 1000,
      // Read only under `DependingOnMemory`: the library builds the buffer to
      // prefer time over size, so without it nothing but the seconds above
      // stops a player filling the heap.
      maxHeapAllocationPercent: heapShare
    }
  }
}
