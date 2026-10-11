import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  clipValid,
  defaultClip,
  fitClip,
  formatLength,
  formatTenths,
  JOG_RATE,
  jogClip,
  msAt,
  nudge,
  placeClip,
  playFromHere
} from './clipModel'

describe('clipModel', function () {
  it('defaults to the first 15 s, or the whole of a short song', function () {
    expect(defaultClip(90000)).deep.equals({ startMs: 0, endMs: 15000 })
    expect(defaultClip(8000)).deep.equals({ startMs: 0, endMs: 8000 })
  })

  it('slides a 15 s window and keeps it inside the song', function () {
    expect(placeClip(5049, 90000)).deep.equals({
      startMs: 5000,
      endMs: 20000
    })
    expect(placeClip(-3000, 90000)).deep.equals({ startMs: 0, endMs: 15000 })
    expect(placeClip(80000, 90000)).deep.equals({
      startMs: 75000,
      endMs: 90000
    })
    expect(placeClip(80000, 90123)).deep.equals({
      startMs: 75123,
      endMs: 90123
    })
    expect(nudge({ startMs: 5000, endMs: 20000 }, 1000, 90000)).deep.equals({
      startMs: 6000,
      endMs: 21000
    })
    expect(nudge({ startMs: 5000, endMs: 20000 }, -1000, 90000)).deep.equals({
      startMs: 4000,
      endMs: 19000
    })
    let clip = { startMs: 0, endMs: 15000 }
    for (let i = 0; i < 3; i++) clip = nudge(clip, 1000, 90000)
    expect(clip).deep.equals({ startMs: 3000, endMs: 18000 })
  })

  it('fits a saved clip to 15 s inside a shorter copy of the song', function () {
    expect(fitClip({ startMs: 10000, endMs: 40000 }, 233000)).deep.equals({
      startMs: 10000,
      endMs: 25000
    })
    expect(fitClip({ startMs: 10000, endMs: 25000 }, 20000)).deep.equals({
      startMs: 5000,
      endMs: 20000
    })
    expect(fitClip({ startMs: 30000, endMs: 45000 }, 20000)).deep.equals({
      startMs: 5000,
      endMs: 20000
    })
    expect(fitClip({ startMs: 0, endMs: 900 }, 500)).deep.equals({
      startMs: 0,
      endMs: 500
    })
  })

  it('accepts only a 15 s window inside the song, or a short song whole', function () {
    expect(clipValid({ startMs: 0, endMs: 15000 }, 90000)).equals(true)
    expect(clipValid({ startMs: 0, endMs: 8000 }, 8000)).equals(true)
    expect(clipValid({ startMs: 0, endMs: 1000 }, 90000)).equals(false)
    expect(clipValid({ startMs: 0, endMs: 60000 }, 90000)).equals(false)
    expect(clipValid({ startMs: 80000, endMs: 95000 }, 90000)).equals(false)
    expect(clipValid({ startMs: -1, endMs: 14999 }, 90000)).equals(false)
    expect(clipValid({ startMs: 0, endMs: 500 }, 500)).equals(false)
  })

  it('plays the 3 s before the window ends, or the whole of a short clip', function () {
    expect(playFromHere({ startMs: 5000, endMs: 20000 })).deep.equals({
      startMs: 17000,
      endMs: 20000
    })
    expect(playFromHere({ startMs: 0, endMs: 2000 })).deep.equals({
      startMs: 0,
      endMs: 2000
    })
  })

  it('reads a touch on the timeline and formats the times', function () {
    expect(msAt(50, 100, 90000)).equals(45000)
    expect(msAt(-5, 100, 90000)).equals(0)
    expect(msAt(150, 100, 90000)).equals(90000)
    expect(msAt(10, 0, 90000)).equals(0)
    expect(formatTenths(65340)).equals('1:05.3')
    expect(formatTenths(0)).equals('0:00.0')
    expect(formatLength(233000)).equals('3:53')
    expect(formatLength(59600)).equals('1:00')
  })

  it('jogs the window a quarter as far as the same drag on the timeline', function () {
    expect(JOG_RATE).equals(0.25)
    // 40 pt of a 400 pt timeline is 18 s of a 180 s song; the wheel moves 4.5 s.
    expect(jogClip(10000, 40, 400, 180000)).deep.equals({
      startMs: 14500,
      endMs: 29500
    })
    expect(jogClip(10000, -40, 400, 180000)).deep.equals({
      startMs: 5500,
      endMs: 20500
    })
  })

  it('keeps a jog inside the song and in tenth-second steps', function () {
    expect(jogClip(1000, -400, 400, 180000)).deep.equals({
      startMs: 0,
      endMs: 15000
    })
    expect(jogClip(160000, 4000, 400, 180000)).deep.equals({
      startMs: 165000,
      endMs: 180000
    })
    // 1 pt of 400 on a 180 s song is 112.5 ms: one step of 0.1 s.
    expect(jogClip(10000, 1, 400, 180000).startMs).equals(10100)
  })

  it('leaves the window where it is before the timeline is laid out', function () {
    expect(jogClip(10000, 40, 0, 180000)).deep.equals({
      startMs: 10000,
      endMs: 25000
    })
  })
})
