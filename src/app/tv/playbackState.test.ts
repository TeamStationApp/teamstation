import { expect } from 'chai'
import { describe, it } from 'mocha'

import { angleNeighbor, tvLayout } from './tvLayout'
import { defaultScoreboardSettings } from '../../common/nodeSettings'
import { PlaybackClock } from './playbackClock'
import {
  angleLayout,
  initialPlayback,
  playbackReducer as reduce
} from './playbackState'
import { commonStart, targetTime, timelineFor } from './playbackTimeline'

const timeline = (offset = 0): ReturnType<typeof timelineFor> =>
  timelineFor(new Date(100000 + offset).toISOString())
describe('TV playback composition and remote state', () => {
  it('keeps hidden angles resident, prevents an empty layout and collapses enlargement on toggles', () => {
    let state = initialPlayback(4)
    expect(angleLayout(3, state)).includes({ left: 50, top: 50, width: 50 })
    state = reduce(state, { type: 'enlarge', index: 2 })
    expect(angleLayout(2, state)).includes({ width: 100, zIndex: 2 })
    expect(angleLayout(1, state)).includes({ opacity: 1, width: 50 })
    state = reduce(state, { type: 'collapse' })
    for (const index of [3, 2]) state = reduce(state, { type: 'toggle', index })
    expect(angleLayout(0, state)).includes({ top: 50, height: 50 })
    expect(angleLayout(3, state)).includes({ opacity: 0, width: 50 })
    state = reduce(state, { type: 'toggle', index: 1 })
    expect(angleLayout(0, state)).includes({ width: 100 })
    state = reduce(state, { type: 'toggle', index: 0 })
    expect(state.visible).deep.equals([0])
    expect(reduce(state, { type: 'enlarge', index: 0 })).equals(state)
    state = reduce(state, { type: 'toggle', index: 3 })
    expect(state.visible).deep.equals([0, 3])
  })
  it('protects explicit panels, keeps highlights and stats open and completes each clip once', () => {
    let state = reduce(initialPlayback(4), { type: 'ready', count: 4 })
    expect(state).includes({ side: 'cameras', box: 'preview' })
    state = reduce(state, { type: 'open', panel: 'highlights' })
    state = reduce(state, { type: 'box' })
    state = reduce(state, { type: 'previewTimeout' })
    expect(state).includes({ side: 'highlights', box: 'compact' })
    expect(reduce(state, { type: 'cameraTimeout' })).equals(state)
    state = reduce(state, { type: 'box' })
    expect(state.box).equals('expanded')
    state = reduce(state, { type: 'dismiss' })
    state = reduce(state, { type: 'clip', id: 'clip', end: 110000 })
    expect(reduce(state, { type: 'progress', wall: 109999 })).equals(state)
    state = reduce(state, { type: 'progress', wall: 110000 })
    expect(state).includes({
      side: 'highlights',
      selectedClip: 'clip',
      paused: false,
      clipEnd: null
    })
    state = reduce(state, { type: 'dismiss' })
    expect(reduce(state, { type: 'progress', wall: 111000 })).equals(state)
    state = reduce(state, { type: 'clip', id: 'next', end: 120000 })
    state = reduce(state, { type: 'seek' })
    expect(reduce(state, { type: 'progress', wall: 130000 })).equals(state)
    state = reduce(state, { type: 'ended' })
    expect(state.paused).equals(true)
    state = reduce(state, { type: 'pause' })
    expect(state.paused).equals(false)
    state = reduce(state, { type: 'open', panel: 'cameras' })
    state = reduce(state, { type: 'activity' })
    expect(state.activity).greaterThan(1)
    state = reduce(state, { type: 'cameraTimeout' })
    expect(state.side).equals(null)
    expect(
      reduce(reduce(initialPlayback(1), { type: 'ready', count: 1 }), {
        type: 'previewTimeout'
      })
    ).includes({ side: null, box: 'closed' })
  })
  it('moves within rows and columns before reaching a panel boundary', () => {
    const four = initialPlayback(4)
    expect(angleNeighbor(four, 0, 'right')).equals(1)
    expect(angleNeighbor(four, 1, 'right')).equals(null)
    expect(angleNeighbor(four, 0, 'down')).equals(2)
    expect(angleNeighbor(four, 2, 'down')).equals(null)
    expect(angleNeighbor(four, 2, 'up')).equals(0)
    expect(angleNeighbor(four, 1, 'left')).equals(0)
    expect(angleNeighbor(four, 0, 'left')).equals(null)
    const three = initialPlayback(3)
    expect(angleNeighbor(three, 0, 'left')).equals(null)
    expect(angleNeighbor(three, 0, 'down')).equals(2)
    expect(angleNeighbor(three, 1, 'up')).equals(null)
    expect(angleNeighbor(initialPlayback(2), 0, 'right')).equals(1)
    expect(angleNeighbor(initialPlayback(1), 0, 'down')).equals(null)
    expect(angleNeighbor({ ...four, full: 1 }, 1, 'left')).equals(null)
    expect(angleNeighbor(four, 8, 'right')).equals(null)
    expect(angleNeighbor({ ...four, visible: [1, 3] }, 1, 'right')).equals(3)
  })
  it('shares landscape geometry and isolates the four-angle TV setting', () => {
    const screen = { width: 1920, height: 1080 }
    const settings = { ...defaultScoreboardSettings, show: true }
    const three = tvLayout(initialPlayback(3), screen, settings, true, true)
    expect(three.tiles[0].x).equals(960)
    expect(three.tiles[1].y).equals(540)
    expect(three.box).not.equals(null)
    const two = tvLayout(initialPlayback(2), screen, settings, true, true)
    expect(two.tiles[0].y).equals(540)
    expect(two.box!.x).lessThan(960)
    expect(two.board!.x).greaterThan(960)
    const four = initialPlayback(4)
    const normal = tvLayout(four, screen, settings, true, true)
    const changed = tvLayout(
      four,
      screen,
      { ...settings, tvLandscape: { x: 0.2, y: 0.2, height: 0.3 } },
      true,
      true
    )
    expect(changed.board!.x).greaterThan(normal.board!.x)
    expect(changed.tiles).deep.equals(normal.tiles)
    expect(
      tvLayout(initialPlayback(3), screen, null, false, false).boardCell
    ).equals(true)
    expect(
      tvLayout(initialPlayback(1), screen, settings, true, true).box
    ).equals(null)
  })
})
describe('TV native playback clock contracts', () => {
  it('maps unequal starts, corrects drift, retains all seek ports and seeks backwards', () => {
    const calls: number[][] = [[], [], [], []]
    const clock = new PlaybackClock()
    for (let i = 0; i < 4; i++) {
      clock.register(i, timeline(i * 1000), time => calls[i].push(time))
      clock.load(i, 60)
    }
    clock.start()
    expect(calls.map(a => a.at(-1))).deep.equals([3, 2, 1, 0])
    expect(clock.progress(0, 55)).equals(103000)
    for (let i = 0; i < 4; i++) {
      clock.settled(i)
      clock.progress(i, 3 - i)
    }
    expect(clock.progress(0, 5)).equals(105000)
    expect(calls.map(a => a.at(-1))).deep.equals([3, 4, 3, 2])
    clock.seek(101000)
    expect(calls.map(a => a.at(-1))).deep.equals([1, 0, 0, 0])
    expect(clock.available(2)).equals(false)
    clock.fail(0)
    expect(clock.master).equals(1)
    expect(clock.available(0)).equals(false)
    clock.settled(1)
    expect(clock.progress(1, 55)).equals(101000)
    clock.progress(1, 0)
    expect(clock.progress(1, 4)).equals(105000)
    expect(clock.progress(0, 9)).equals(105000)
    clock.load(3, 0)
    expect(clock.ports[3].duration).equals(Infinity)
  })
  it('continues longer recordings, seeks beyond a shorter master, and restores exhausted angles on rewind', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], []]
    clock.register(0, timeline(), value => seeks[0].push(value))
    clock.register(1, timeline(1000), value => seeks[1].push(value))
    clock.load(0, 20)
    clock.load(1, 60)
    clock.start()
    expect(clock.end(0)).equals(false)
    expect(clock.master).equals(1)
    expect(clock.available(0)).equals(false)
    expect(seeks[1].at(-1)).equals(19)
    expect(clock.move(10)).equals(130000)
    expect(seeks[1].at(-1)).equals(29)
    expect(clock.move(-25)).equals(105000)
    expect(clock.available(0)).equals(true)
    expect(seeks[0].at(-1)).equals(5)
    expect(clock.end(0)).equals(false)
    expect(clock.end(1)).equals(true)
    clock.seek(105000)
    expect(clock.available(0)).equals(true)
    expect(clock.available(1)).equals(true)
    expect(clock.move(999)).equals(160900)
    clock.fail(1)
    expect(clock.move(999)).equals(119900)
    const missing = new PlaybackClock()
    expect(missing.available(0)).equals(false)
    missing.register(0, timelineFor(null), () => undefined)
    missing.load(0, 10)
    expect(missing.move(10)).equals(null)
    missing.wall = 100000
    expect(missing.move(10)).equals(null)
    expect(missing.end(0)).equals(true)
  })
  it('skips exhausted cameras after a successor fails and reports no continuing source', () => {
    const clock = new PlaybackClock()
    for (let i = 0; i < 3; i++) {
      clock.register(i, timeline(), () => undefined)
      clock.load(i, i === 0 ? 20 : 60)
    }
    clock.start()
    expect(clock.end(0)).equals(false)
    expect(clock.master).equals(1)
    expect(clock.fail(1)).equals(false)
    expect(clock.master).equals(2)
    clock.settled(2)
    clock.progress(2, 0)
    expect(clock.progress(2, 21)).equals(121000)
    expect(clock.fail(2)).equals(true)
    const pending = new PlaybackClock()
    pending.register(0, timeline(), () => undefined)
    pending.register(1, timeline(), () => undefined)
    expect(pending.fail(0)).equals(false)
    pending.load(1, 60)
    expect(pending.master).equals(1)
    expect(pending.fail(0)).equals(false)
    const allFailed = new PlaybackClock()
    for (let i = 0; i < 2; i++)
      allFailed.register(i, timeline(), () => undefined)
    expect(allFailed.fail(0)).equals(false)
    allFailed.load(0, 0)
    expect(allFailed.fail(1)).equals(true)
    allFailed.load(1, 0)
    expect(allFailed.available(0)).equals(false)
    expect(allFailed.available(1)).equals(false)
  })
  it('hands off the master during a forward seek before its end callback', () => {
    const clock = new PlaybackClock()
    for (let i = 0; i < 2; i++) {
      clock.register(i, timeline(), () => undefined)
      clock.load(i, i === 0 ? 20 : 60)
    }
    clock.start()
    expect(clock.move(30)).equals(130000)
    expect(clock.master).equals(1)
    expect(clock.available(0)).equals(false)
    expect(clock.end(0)).equals(false)
  })
  it('handles missing clocks, late loading, duration limits and unavailable streams honestly', () => {
    const clock = new PlaybackClock()
    clock.register(0, timelineFor(null), () => undefined)
    expect(clock.available(0)).equals(true)
    clock.start()
    expect(clock.wall).equals(null)
    clock.load(0, 10)
    expect(clock.progress(0, 3)).equals(null)
    clock.fail(0)
    expect(clock.master).equals(0)
    expect(commonStart([])).equals(null)
    expect(commonStart([timeline(), timelineFor(null)])).equals(null)
    expect(targetTime(timelineFor(null), 1, 5)).equals(null)
    expect(targetTime(timeline(), 120000, 10)).deep.equals({
      seconds: 10,
      available: false
    })
    expect(targetTime(timeline(), 99000, 10)).deep.equals({
      seconds: 0,
      available: false
    })
  })
})
