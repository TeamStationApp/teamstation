import { readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

import {
  configuredInit,
  hevcSegment,
  IDR_SLICE,
  parameterSetNals,
  wallClockNal
} from './frameWallFixture'
import { timelineStartSec } from './segmentClock'

export function firstPublishOnDisk(
  dir: string,
  videoStartMs: number,
  pdtLagMs = 1400
): {
  init: Buffer
  listed: Buffer[]
} {
  const init = configuredInit(parameterSetNals(1))
  writeFileSync(join(dir, 'init.mp4'), init)
  const listed = [0, 4, 8].map(at =>
    hevcSegment(at, [wallClockNal(videoStartMs + at * 1000), IDR_SLICE])
  )
  listed.forEach((bytes, at) => {
    writeFileSync(join(dir, `seg00000${at}.m4s`), bytes)
  })
  writeFileSync(
    join(dir, 'master.m3u8'),
    [
      '#EXTM3U',
      '#EXT-X-VERSION:7',
      '#EXT-X-TARGETDURATION:4',
      '#EXT-X-MEDIA-SEQUENCE:0',
      '#EXT-X-PLAYLIST-TYPE:EVENT',
      '#EXT-X-MAP:URI="init.mp4"',
      `#EXT-X-PROGRAM-DATE-TIME:${new Date(videoStartMs + pdtLagMs).toISOString()}`,
      '#EXTINF:4.000000,',
      'seg000000.m4s',
      '#EXTINF:4.000000,',
      'seg000001.m4s',
      '#EXTINF:3.960000,',
      'seg000002.m4s',
      ''
    ].join('\n')
  )
  return { init, listed }
}

/** Where a segment sits on the timeline, once something has stamped it. */
export async function placedAt(
  dir: string,
  init: Buffer,
  name: string,
  beyond = 1,
  progress: () => void = () => {}
): Promise<number | undefined> {
  let at: number | undefined
  for (let i = 0; i < 100; i++) {
    progress()
    try {
      at = timelineStartSec(init, readFileSync(join(dir, name)))
    } catch {
      at = undefined
    }
    if (at != null && at > beyond) return at
    await new Promise(resolve => setTimeout(resolve, 30))
  }
  return at
}
