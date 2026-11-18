import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PNG } from 'pngjs'

import {
  benchClock,
  findPicture,
  frameIn,
  MIN_CONFIDENCE,
  type Picture,
  readClock,
  readingEpochMs
} from './clockReader'
import { HEIGHT, renderFrame, WIDTH } from './syntheticFrames'

/** 17:04:05.678 UTC on a day in November 2026. Frames 0–2 of each ten seconds are the white flash, so the picture is frame 10. */
const SHOWN = Date.UTC(2026, 10, 14, 17, 4, 5, 678)
const DAY_MS = ((17 * 60 + 4) * 60 + 5) * 1000 + 678

/** A synthetic frame showing SHOWN, as RGBA, box-averaged down by `factor`. */
export function drawnPicture(
  label: string,
  factor = 1,
  epochMs = SHOWN
): Picture {
  const rgb = renderFrame({ index: 10, startEpochMs: epochMs - 333, label })
  const width = Math.floor(WIDTH / factor)
  const height = Math.floor(HEIGHT / factor)
  const data = new Uint8Array(width * height * 4)
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const sum = [0, 0, 0]
      let n = 0
      for (let dy = 0; dy < factor; dy++) {
        for (let dx = 0; dx < factor; dx++) {
          const at = ((y * factor + dy) * WIDTH + (x * factor + dx)) * 3
          sum[0] += rgb[at]
          sum[1] += rgb[at + 1]
          sum[2] += rgb[at + 2]
          n++
        }
      }
      const to = (y * width + x) * 4
      data[to] = Math.round(sum[0] / n)
      data[to + 1] = Math.round(sum[1] / n)
      data[to + 2] = Math.round(sum[2] / n)
      data[to + 3] = 255
    }
  }
  return { width, height, data }
}

function fixture(name: string): Picture {
  const png = PNG.sync.read(readFileSync(join(__dirname, 'fixtures', name)))
  return { width: png.width, height: png.height, data: png.data }
}

describe('the clock reader', function () {
  it('reads the clock of a drawn frame at full, half and quarter size, and its label down to a third', function () {
    for (const factor of [1, 2, 3, 4]) {
      const picture = drawnPicture('SYNTHA', factor)
      const reading = readClock(picture, {
        x: 0,
        y: 0,
        w: picture.width,
        h: picture.height
      })
      expect(reading, `factor ${factor}`).deep.equals({
        msOfDay: DAY_MS,
        // At a quarter the label's cells are 2.5 pixels: too small to read.
        label: factor === 4 ? null : 'SYNTHA',
        confidence: 1
      })
    }
  })

  it('fits the frame inside a box of another shape, as the player does', function () {
    expect(frameIn({ x: 0, y: 0, w: 1280, h: 1000 })).deep.equals({
      x: 0,
      y: 140,
      w: 1280,
      h: 720
    })
    expect(frameIn({ x: 10, y: 0, w: 2000, h: 360 })).deep.equals({
      x: 690,
      y: 0,
      w: 640,
      h: 360
    })
    // A frame letterboxed in a square tile still reads.
    const drawn = drawnPicture('SYNTHB', 2)
    const square = new Uint8Array(640 * 640 * 4)
    for (let i = 0; i < square.length; i += 4) square.set([24, 24, 24, 255], i)
    for (let y = 0; y < drawn.height; y++) {
      square.set(
        drawn.data.subarray(y * 640 * 4, (y + 1) * 640 * 4),
        (y + 140) * 640 * 4
      )
    }
    expect(
      readClock(
        { width: 640, height: 640, data: square },
        { x: 0, y: 0, w: 640, h: 640 }
      )?.msOfDay
    ).equals(DAY_MS)
  })

  it('reads nothing where no clock is, and less than certain over a damaged digit', function () {
    const blank = new Uint8Array(320 * 180 * 4).fill(24)
    expect(
      readClock(
        { width: 320, height: 180, data: blank },
        {
          x: 0,
          y: 0,
          w: 320,
          h: 180
        }
      )
    ).equals(null)
    // Paint over the first hour digit: eight of nine digits still read.
    const picture = drawnPicture('SYNTHC')
    for (let y = 110; y < 270; y++) {
      for (let x = 80; x < 164; x++) {
        picture.data.set([24, 24, 24, 255], (y * WIDTH + x) * 4)
      }
    }
    const reading = readClock(picture, { x: 0, y: 0, w: WIDTH, h: HEIGHT })!
    expect(reading.confidence).lessThan(MIN_CONFIDENCE)
    expect(reading.confidence).closeTo(8 / 9, 0.001)
  })

  it('reads real watcher screenshots of the soak: the iPad and the Pixel 8', function () {
    const ipad = fixture('clock-ipad-171746910.png')
    expect(
      readClock(ipad, { x: 0, y: 0, w: ipad.width, h: ipad.height })
    ).deep.equals({
      msOfDay: ((17 * 60 + 17) * 60 + 46) * 1000 + 910,
      label: 'SYNTHETIC',
      confidence: 1
    })
    const android = fixture('clock-android-164822443.png')
    expect(
      readClock(android, { x: 0, y: 0, w: android.width, h: android.height })
    ).deep.equals({
      msOfDay: ((16 * 60 + 48) * 60 + 22) * 1000 + 443,
      label: 'SYNTHETIC',
      confidence: 1
    })
  })

  it('places a bench clock reading on the latest bench day that is not after the picture', function () {
    const bench = benchClock(-480)
    const near = Date.UTC(2026, 10, 14, 1, 0, 0)
    // 17:00 on the bench (UTC−8) the day before is 01:00 UTC on the 14th.
    expect(readingEpochMs({ msOfDay: 17 * 3_600_000 }, near, bench)).equals(
      Date.UTC(2026, 10, 14, 1, 0, 0)
    )
    // Just before the bench's midnight, taken just after it: the day before.
    const afterMidnight = Date.UTC(2026, 10, 14, 8, 0, 1)
    expect(
      readingEpochMs({ msOfDay: 86_400_000 - 1000 }, afterMidnight, bench)
    ).equals(Date.UTC(2026, 10, 14, 7, 59, 59))
    // A frame a moment ahead of this machine's clock is the publisher's skew, not tomorrow.
    expect(
      readingEpochMs(
        { msOfDay: 0 },
        Date.UTC(2026, 10, 14, 23, 59, 59),
        benchClock()
      )
    ).equals(Date.UTC(2026, 10, 15))
  })

  it('places a fixture reading in the latest loop whose frame is not after the picture', function () {
    const start = Date.UTC(2026, 10, 16, 20, 0, 0)
    const fixture = { startedAtMs: start, loopMs: 30 * 60_000 }
    const minute = 60_000
    // The first loop, live.
    expect(
      readingEpochMs(
        { msOfDay: 5 * minute },
        start + 5 * minute + 3000,
        fixture
      )
    ).equals(start + 5 * minute)
    // The third loop.
    expect(
      readingEpochMs({ msOfDay: minute }, start + 61 * minute + 2000, fixture)
    ).equals(start + 61 * minute)
    // Scrubbed back 20 minutes, across the loop's start: the earlier loop.
    expect(
      readingEpochMs({ msOfDay: 25 * minute }, start + 45 * minute, fixture)
    ).equals(start + 25 * minute)
    // On a loop's boundary.
    expect(readingEpochMs({ msOfDay: 0 }, start + 30 * minute, fixture)).equals(
      start + 30 * minute
    )
    // A picture before the camera began is still in its first loop.
    expect(readingEpochMs({ msOfDay: 1000 }, start - minute, fixture)).equals(
      start + 1000
    )
  })

  it('finds a frame from its ink, wherever and at whatever size a page shows it', function () {
    const frame = drawnPicture('SYNTHA', 2)
    // The frame at half size, 100 px in and 50 down on a white page.
    const page: Picture = {
      width: 1000,
      height: 600,
      data: new Uint8Array(1000 * 600 * 4).fill(255)
    }
    for (let y = 0; y < frame.height; y++) {
      for (let x = 0; x < frame.width; x++) {
        const from = (y * frame.width + x) * 4
        const to = ((y + 50) * page.width + x + 100) * 4
        page.data.set(frame.data.subarray(from, from + 4), to)
      }
    }
    // A badge's edge above the frame blends to the ink's colour, a few pixels a row.
    for (let y = 20; y < 30; y++) {
      for (let x = 500; x < 504; x++)
        page.data.set([255, 200, 0, 255], (y * page.width + x) * 4)
    }
    const found = findPicture(page)!
    expect(found.x).closeTo(100, 3)
    expect(found.y).closeTo(50, 3)
    expect(found.w).closeTo(640, 6)
    expect(found.h).closeTo(360, 4)
    expect(readClock(page, found)?.label).equals('SYNTHA')
    // A page with no frame on it has none to find.
    expect(
      findPicture({
        width: 10,
        height: 10,
        data: new Uint8Array(400).fill(255)
      })
    ).equals(null)
  })
})
