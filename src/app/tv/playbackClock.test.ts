import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { WallTimeline } from '../../common/wallTimeline'
import { PlaybackClock } from './playbackClock'

const START = 1_000_000
const live = (anchors: WallTimeline['anchors']): WallTimeline => ({
  anchors,
  source: 'arrival',
  confidence: 'approximate',
  live: true,
  startAt: null
})

/** Every camera reports `seconds`, the master first, as AVPlayer's progress does. */
function tick(clock: PlaybackClock, seconds: number): void {
  for (let i = 0; i < clock.ports.length; i++) clock.progress(i, seconds)
}

describe('TV native playback clock through one live camera outage', () => {
  it('keeps the others at their cushion when the master returns from a 64 s outage, and rejoins it after its hole', () => {
    const seeks: number[][] = [[], [], [], []]
    const clock = new PlaybackClock()
    for (let i = 0; i < 4; i++) {
      clock.register(i, live([[0, START]]), seconds => seeks[i].push(seconds))
      clock.load(i, Infinity)
    }
    // The opening lines every camera up on the master's live position.
    tick(clock, 600)
    for (let i = 0; i < 4; i++) clock.settled(i)
    for (const s of seeks) s.length = 0
    for (let t = 600.25; t <= 650; t += 0.25) tick(clock, t)
    expect(clock.master).equals(0)
    // SynthA's publisher was cut for 64 s; the server continues its playlist
    // with the media contiguous and the return placed by the wall clock.
    clock.ports[0].timeline = live([
      [0, START],
      [659_000, START + 723_000]
    ])
    for (let t = 650.25; t <= 700; t += 0.25) tick(clock, t)
    // The game went on at 1× from another camera: nobody was dragged 64 s
    // forward, to the live edge of a stream played 45 s behind it.
    expect(seeks.slice(1).map(s => s.length)).deep.equals([0, 0, 0])
    expect(clock.wall).equals(START + 700_000)
    expect(clock.master).not.equals(0)
    // SynthA waits at the far side of its hole: unavailable at this moment.
    expect(seeks[0].at(-1)).equals(659)
    expect(clock.available(0)).equals(false)
    for (const i of [1, 2, 3]) expect(clock.available(i)).equals(true)
    clock.settled(0)
    for (let t = 700.25; t <= 725; t += 0.25) tick(clock, t)
    expect(clock.available(0)).equals(true)
    expect(seeks[0].at(-1)).equals(660)

    // AVPlayer gave up on the camera meanwhile: the others play on, and the
    // camera, opened again, rejoins at the wall.
    expect(clock.fail(0)).equals(false)
    expect(clock.available(0)).equals(false)
    clock.retry(0)
    clock.load(0, Infinity)
    expect(clock.available(0)).equals(true)
    expect(seeks[0].at(-1)).equals(661)
  })

  it('still crosses a hole when no other camera has the moment', () => {
    const clock = new PlaybackClock()
    clock.register(
      0,
      live([
        [0, START],
        [10_000, START + 74_000]
      ]),
      () => undefined
    )
    clock.load(0, Infinity)
    clock.progress(0, 9)
    clock.progress(0, 10.25)
    expect(clock.wall).equals(START + 74_250)
    expect(clock.available(0)).equals(true)
  })

  it('goes on from the earliest picture after an outage every camera shared, sought into', () => {
    const seeks: number[][] = [[], []]
    const clock = new PlaybackClock()
    // Both away from 100 s on the wall; A back 30 s later, B 40 s later.
    clock.register(
      0,
      live([
        [0, START],
        [100_000, START + 130_000]
      ]),
      s => seeks[0].push(s)
    )
    clock.register(
      1,
      live([
        [0, START],
        [100_000, START + 140_000]
      ]),
      s => seeks[1].push(s)
    )
    clock.load(0, 600)
    clock.load(1, 600)
    clock.seek(START + 110_000)
    // Not every camera ended with the clock standing still: the game is at A's return.
    expect(clock.wall).equals(START + 130_000)
    expect(clock.ports.map(p => p.ended)).deep.equals([false, true])
    expect(clock.available(clock.master)).equals(true)
    expect(clock.master).equals(0)
    expect(seeks[0].at(-1)).equals(100)
    // A moment past both ends is still the end.
    clock.seek(START + 900_000)
    expect(clock.ports.every(p => p.ended)).equals(true)
  })

  it('never hands the clock to a camera reopened and not yet loaded', () => {
    const clock = new PlaybackClock()
    // A was reopened; B, the master, is away from 100 s to 130 s; C has every moment.
    clock.register(0, live([[0, START]]), () => undefined)
    clock.register(
      1,
      live([
        [0, START],
        [100_000, START + 130_000]
      ]),
      () => undefined
    )
    clock.register(2, live([[0, START]]), () => undefined)
    for (const i of [0, 1, 2]) clock.load(i, 600)
    clock.seek(START + 50_000)
    clock.master = 1
    clock.fail(0)
    clock.retry(0)
    // Scrubbed into B's hole: C carries the clock, not A, whose player is not there yet.
    clock.seek(START + 110_000)
    expect(clock.master).equals(2)
    clock.load(0, 600)
    expect(clock.master).equals(2)
  })

  it('hands the clock on when a camera fails while the master is reopened and not yet loaded', () => {
    const clock = new PlaybackClock()
    for (const i of [0, 1, 2])
      clock.register(i, live([[0, START]]), () => undefined)
    for (const i of [0, 1, 2]) clock.load(i, 600)
    clock.seek(START + 50_000)
    expect(clock.master).equals(0)
    // The master failed, and nobody else took over before it was reopened.
    clock.ports[0].failed = true
    clock.retry(0)
    expect(clock.fail(1)).equals(false)
    expect(clock.master).equals(2)
    // With every camera gone but the one not loaded, the clock says so once it
    // can never load either.
    expect(clock.fail(2)).equals(false)
    expect(clock.fail(0)).equals(true)
  })
})
