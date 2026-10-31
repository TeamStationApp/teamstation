import { expect } from 'chai'
import { describe, it } from 'mocha'

import { PlaybackClock } from './playbackClock'
import {
  angleLayout,
  edgeSwipe,
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
    expect(angleLayout(0, state)).includes({ top: 25, height: 50 })
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
  it('requires edge-origin displacement and leaves center touches to focus navigation', () => {
    expect(edgeSwipe({ x: 0.1, y: 0.5 }, { x: 0.7, y: 0.5 })).equals('cameras')
    expect(edgeSwipe({ x: 0.9, y: 0.5 }, { x: 0.3, y: 0.5 })).equals(
      'highlights'
    )
    expect(edgeSwipe({ x: 0.5, y: 0.95 }, { x: 0.5, y: 0.3 })).equals('box')
    expect(edgeSwipe({ x: 0.5, y: 0.5 }, { x: 1, y: 0.5 })).equals(null)
    expect(edgeSwipe({ x: 0, y: 0.5 }, { x: 0.2, y: 0.5 })).equals(null)
    expect(edgeSwipe({ x: 0.5, y: 0 }, { x: 0.5, y: 0.9 })).equals(null)
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
