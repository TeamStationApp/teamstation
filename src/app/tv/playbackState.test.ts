import { expect } from 'chai'
import { describe, it } from 'mocha'

import { defaultScoreboardSettings } from '../../common/nodeSettings'
import { wallAt } from '../../common/wallTimeline'
import { PlaybackClock } from './playbackClock'
import { PlaybackRecovery } from './playbackRecovery'
import {
  angleLayout,
  initialPlayback,
  playbackReducer as reduce
} from './playbackState'
import { commonStart, targetTime, timelineFor } from './playbackTimeline'
import { angleNeighbor, tvLayout } from './tvLayout'

const timeline = (offset = 0): ReturnType<typeof timelineFor> =>
  timelineFor(new Date(100000 + offset).toISOString())
describe('TV playback composition and remote state', () => {
  it('brings a late live camera and its master back to shared seekable footage', () => {
    for (const lag of [0.6, 1.2]) {
      const clock = new PlaybackClock()
      const seeks: number[][] = [[], []]
      for (let i = 0; i < 2; i++)
        clock.register(i, timeline(), seconds => seeks[i].push(seconds))
      clock.load(0, Infinity)
      clock.progress(0, 108 + lag, 108, 0)
      clock.load(1, Infinity)
      clock.progress(1, 108, 108, 0)
      expect(seeks).deep.equals([[107.9], [107.9]])
      for (let i = 0; i < 2; i++) {
        clock.settled(i)
        clock.progress(i, 107.9, 108, 0)
        expect(clock.available(i)).equals(true)
      }
      for (let tick = 1; tick < 2400; tick++) {
        const seconds = 107.9 + tick * 0.25
        const edge = 108 + Math.floor(tick / 24) * 6
        for (let i = 0; i < 2; i++) {
          clock.progress(i, seconds, edge, 0)
          expect(clock.available(i)).equals(true)
        }
      }
    }
  })
  it('rejoins healthy cameras decoding a segment past 6-second safe edges, at every phase of the edge', () => {
    // The first camera decodes 9 s past its safe edge, which advances 6 s at
    // a time; the second opens at that edge. Every stop across one whole edge
    // cycle rejoins them.
    for (let stop = 150; stop <= 156; stop += 0.5) {
      const clock = new PlaybackClock()
      const seeks: number[][] = [[], []]
      for (let i = 0; i < 2; i++)
        clock.register(i, timeline(), seconds => seeks[i].push(seconds))
      clock.load(0, Infinity)
      let seconds = 120
      const edge = (): number => 6 * Math.floor((seconds - 9) / 6)
      for (; seconds <= stop; seconds += 0.25)
        clock.progress(0, seconds, edge(), 0)
      clock.load(1, Infinity)
      clock.progress(1, edge(), edge(), 0)
      const shared = edge() - 0.1
      expect(seeks[0].at(-1), `rejoined at ${stop}`).closeTo(shared, 0.001)
      expect(seeks[1].at(-1)).closeTo(shared, 0.001)
      for (let i = 0; i < 2; i++) {
        clock.settled(i)
        clock.progress(i, shared, edge(), 0)
        expect(clock.available(i)).equals(true)
      }
    }
  })
  it('refuses a rejoin to a camera whose edge trails by more than three segments, after any edge jump', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], [], []]
    for (let i = 0; i < 3; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    for (const i of [0, 1, 2]) {
      clock.load(i, Infinity)
      clock.progress(i, 300, 296, 0)
      clock.settled(i)
    }
    // One reload lists three 4-second segments at once.
    clock.progress(0, 301, 308, 0)
    clock.progress(1, 301, 300, 0)
    // The third camera's feed stopped; it opens again 13 s behind the edge.
    clock.fail(2)
    clock.load(2, Infinity)
    for (const i of [0, 1]) seeks[i].length = 0
    clock.progress(2, 295, 295, 0)
    expect(clock.wall).equals(401000)
    expect(seeks[0].concat(seeks[1])).deep.equals([])
    expect(clock.available(2)).equals(false)
  })
  for (const obstacle of [
    'unknown bounds',
    'missing mapping',
    'gap',
    'expired footage'
  ])
    it(`rejoins a late live camera with the master, leaving out a covered camera whose shared seeking has ${obstacle}`, () => {
      const clock = new PlaybackClock()
      const seeks: number[] = []
      for (let i = 0; i < 3; i++)
        clock.register(i, timeline(), seconds => seeks.push(seconds))
      clock.load(0, Infinity)
      clock.progress(0, 108.6, 108, 0)
      clock.load(1, Infinity)
      clock.load(2, obstacle === 'gap' ? 200 : Infinity)
      const third = clock.ports[2]
      third.seekableEnd = obstacle === 'unknown bounds' ? null : 108
      if (obstacle === 'missing mapping') third.timeline.anchors = []
      if (obstacle === 'gap')
        third.timeline.anchors = [
          [0, 100000],
          [100000, 210000]
        ]
      if (obstacle === 'expired footage') third.seekableStart = 108
      seeks.length = 0
      clock.progress(1, 108, 108, 0)
      // The covered third camera no longer holds the others back.
      expect(clock.wall).equals(207900)
      expect(seeks).contains(107.9)
      expect(clock.available(2)).equals(false)
    })
  it('keeps the others playing while a live camera whose feed stopped waits for its footage', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], [], []]
    for (let i = 0; i < 3; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    for (let i = 0; i < 3; i++) {
      clock.load(i, Infinity)
      clock.progress(i, 300, 330, 0)
      clock.settled(i)
    }
    expect(clock.wall).equals(400000)
    // The third camera's feed stopped at 280 s; it is opened again on its
    // stale playlist, at its safe edge, while the others play on.
    clock.fail(2)
    clock.load(2, Infinity)
    for (const i of [0, 1]) clock.progress(i, 301, 331, 0)
    for (const i of [0, 1]) seeks[i].length = 0
    clock.progress(2, 271, 271, 0)
    expect(clock.wall, 'not pulled back to its last picture').equals(401000)
    expect(seeks[0].concat(seeks[1])).deep.equals([])
    expect(clock.available(2)).equals(false)
    for (let second = 302; second < 320; second++) {
      for (const i of [0, 1]) clock.progress(i, second, second + 30, 0)
      clock.progress(2, 271, 271, 0)
    }
    expect(clock.wall).equals(419000)
    // Its feed returns: footage up to the moment and beyond.
    clock.progress(2, 300, 330, 0)
    clock.settled(2)
    clock.progress(2, 320, 330, 0)
    expect(clock.available(2)).equals(true)
  })
  it('does not pull the others back before a gap a returning live camera has just crossed', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], [], []]
    for (let i = 0; i < 3; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    // The third camera was away for 70 s: its footage resumes at media 200 s,
    // wall 370 s.
    clock.ports[2].timeline.anchors = [
      [0, 100000],
      [200000, 370000]
    ]
    for (const i of [0, 1]) {
      clock.load(i, Infinity)
      clock.progress(i, 272, 273, 0)
      clock.settled(i)
    }
    expect(clock.wall).equals(372000)
    clock.load(2, Infinity)
    for (const i of [0, 1]) seeks[i].length = 0
    // Opened again with a seekable range only just past the gap, its edge
    // within a few seconds of the others'.
    clock.progress(2, 200, 200.05, 0)
    expect(clock.wall, 'not sent back before the gap').equals(372000)
    expect(seeks[0].concat(seeks[1])).deep.equals([])
    expect(clock.available(2)).equals(false)
  })
  it('rejoins a reopened healthy camera while a stalled camera stays covered', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], [], []]
    for (let i = 0; i < 3; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    for (const i of [0, 1, 2]) {
      clock.load(i, Infinity)
      clock.progress(i, 300, 296, 0)
      clock.settled(i)
    }
    // The third camera's feed stops at 296 s; it stays loaded, stuck.
    let second = 300
    const edge = (): number => 296 + 4 * Math.floor((second - 300) / 4)
    for (second = 301; second <= 310; second++) {
      for (const i of [0, 1]) clock.progress(i, second, edge(), 0)
      clock.progress(2, 300, 296, 0)
    }
    expect(clock.available(2)).equals(false)
    // The second camera fails and reopens decoding 3 s behind the moment.
    clock.fail(1)
    clock.load(1, Infinity)
    for (const i of [0, 1, 2]) seeks[i].length = 0
    clock.progress(1, 307, edge(), 0)
    const shared = edge() - 0.1
    expect(clock.wall, 'the stalled camera does not hold it back').equals(
      100000 + shared * 1000
    )
    expect(seeks[0].at(-1)).closeTo(shared, 0.001)
    expect(seeks[1].at(-1)).closeTo(shared, 0.001)
    expect(clock.available(2)).equals(false)
  })
  it('rejoins a healthy camera whose edge lags up to three of the 6-second segments the others step by', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], []]
    for (let i = 0; i < 2; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    clock.load(0, Infinity)
    let seconds = 120
    const edge = (): number => 6 * Math.floor((seconds - 9) / 6)
    for (; seconds <= 150; seconds += 0.25)
      clock.progress(0, seconds, edge(), 0)
    // A segment out of phase, a reload late, and a second of uplink: its edge
    // trails the master's by 13 s, which a healthy feed on 6-second segments
    // can. Past three segments (18 s) it is missing footage.
    clock.load(1, Infinity)
    clock.progress(1, edge() - 19, edge() - 19, 0)
    expect(seeks[1], 'held while it trails three segments').deep.equals([])
    expect(clock.available(1)).equals(false)
    clock.progress(1, edge() - 18.5, edge() - 13, 0)
    const shared = edge() - 13 - 0.1
    expect(seeks[0].at(-1), 'rejoined within three segments').closeTo(
      shared,
      0.001
    )
    expect(seeks[1].at(-1)).closeTo(shared, 0.001)
    for (let i = 0; i < 2; i++) {
      clock.settled(i)
      clock.progress(i, shared, edge() - (i === 0 ? 0 : 13), 0)
      expect(clock.available(i)).equals(true)
    }
  })
  it('keeps a returning live camera covered until its timeline holds the outage', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], [], []]
    for (let i = 0; i < 3; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    for (const i of [0, 1, 2]) {
      clock.load(i, Infinity)
      clock.progress(i, 300, 296, 0)
      clock.settled(i)
    }
    // The third camera's feed stops at 296 s and is opened again, stale.
    let second = 300
    const edge = (): number => 296 + 4 * Math.floor((second - 300) / 4)
    for (second = 301; second <= 360; second++) {
      for (const i of [0, 1]) clock.progress(i, second, edge(), 0)
      if (second === 330) {
        clock.fail(2)
        clock.load(2, Infinity)
      }
      if (second > 330) clock.progress(2, 296, 296, 0)
    }
    expect(clock.wall).equals(460000)
    // Its feed returns at wall 452 s, before the TV has fetched the anchor
    // for the outage: its new footage still maps 56 s too early, and its edge
    // moves on in 4-second steps.
    for (const i of [0, 1, 2]) seeks[i].length = 0
    for (let step = 1; step <= 4; step++) {
      second++
      for (const i of [0, 1]) clock.progress(i, second, edge(), 0)
      clock.progress(2, 296 + 4 * step - 3, 296 + 4 * step, 0)
    }
    expect(clock.wall, 'not pulled back an outage').equals(465000)
    expect(seeks[0].concat(seeks[1])).deep.equals([])
    expect(clock.available(2)).equals(false)
    // The periodic refresh brings the outage's anchor; it joins the moment.
    clock.ports[2].timeline = {
      ...clock.ports[2].timeline,
      anchors: [
        [0, 100000],
        [296000, 452000]
      ]
    }
    second++
    for (const i of [0, 1]) clock.progress(i, second, edge(), 0)
    clock.progress(2, 309.5, 312, 0)
    expect(seeks[2].at(-1)).closeTo(310, 0.001)
    clock.settled(2)
    clock.progress(2, 310, 312, 0)
    expect(clock.wall).equals(466000)
    expect(clock.available(2)).equals(true)
  })
  it('does not let a stalled camera covered by a rejoin pull the others back to its edge', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], [], []]
    for (let i = 0; i < 3; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    for (const i of [0, 1, 2]) {
      clock.load(i, Infinity)
      clock.progress(i, 300, 296, 0)
      clock.settled(i)
    }
    // All three edges step every 4 s; then the third camera's feed stops.
    let second = 300
    const edge = (): number => 296 + 4 * Math.floor((second - 300) / 4)
    for (second = 301; second <= 340; second++) {
      for (const i of [0, 1]) clock.progress(i, second, edge(), 0)
      clock.progress(2, second <= 316 ? second : 316, Math.min(edge(), 312), 0)
    }
    expect(clock.available(2)).equals(false)
    // The second camera reopens behind the moment and rejoins; the rejoin's
    // seek leaves the stalled camera waiting for its moment.
    clock.fail(1)
    clock.load(1, Infinity)
    clock.progress(1, 337, edge(), 0)
    const shared = edge() - 0.1
    expect(clock.wall).equals(100000 + shared * 1000)
    for (const i of [0, 1]) {
      clock.settled(i)
      clock.progress(i, shared, edge(), 0)
    }
    for (const i of [0, 1, 2]) seeks[i].length = 0
    // Its next frame does not send everyone back to its frozen edge.
    clock.progress(2, 316, 312, 0)
    expect(clock.wall).equals(100000 + shared * 1000)
    expect(seeks[0].concat(seeks[1])).deep.equals([])
    expect(clock.available(2)).equals(false)
  })
  it('rejoins a healthy live follower once a refreshed master mapping moves past its safe edge', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], []]
    for (let i = 0; i < 2; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    for (const i of [0, 1]) {
      clock.load(i, Infinity)
      clock.progress(i, 300, 296, 0)
      clock.settled(i)
    }
    expect(clock.wall).equals(400000)
    // The periodic refresh places the master's frames 8 s later than before
    // (an arrival estimate replaced by the frames' own clock). The follower
    // decodes 4 s past its safe edge, so the master's new moment is past it.
    clock.ports[0].timeline = {
      ...clock.ports[0].timeline,
      anchors: [[0, 108000]]
    }
    for (let i = 0; i < 2; i++) seeks[i].length = 0
    const edge = (tick: number): number => 296 + 4 * Math.floor(tick / 16)
    let tick = 1
    for (; tick <= 40 && seeks[1].length === 0; tick++)
      for (const i of [0, 1])
        clock.progress(i, 300 + tick * 0.25, edge(tick), 0)
    expect(
      seeks[1].length,
      'the follower is brought to footage it can seek'
    ).greaterThan(0)
    // The newest moment both can seek: just inside the follower's safe edge.
    expect(seeks[1].at(-1)).closeTo(edge(tick - 1) - 0.1, 0.001)
    expect(seeks[0].at(-1)).closeTo(edge(tick - 1) - 8 - 0.1, 0.001)
    expect(clock.wall).equals(100000 + (edge(tick - 1) - 0.1) * 1000)
    for (const i of [0, 1]) {
      clock.settled(i)
      clock.progress(i, seeks[i].at(-1)!, edge(tick) - (i === 0 ? 8 : 0), 0)
    }
    const start = [seeks[0].at(-1)!, seeks[1].at(-1)!]
    for (let next = 1; next < 80; next++) {
      const step = 4 * Math.floor(next / 16)
      for (const i of [0, 1])
        clock.progress(i, start[i] + next * 0.25, edge(tick) + step, 0)
      expect(clock.available(0)).equals(true)
      expect(clock.available(1), `available at tick ${next}`).equals(true)
    }
  })
  it('rejoins a reopened live camera decoding ahead of the moment it cannot seek', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], []]
    for (let i = 0; i < 2; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    clock.load(0, Infinity)
    clock.progress(0, 300, 296, 0)
    // Watch Live opened the second camera after the first: its decoder runs
    // 3 s ahead of the shared moment, which is past its own safe edge.
    clock.load(1, Infinity)
    expect(clock.ports[1].pendingWall).equals(400000)
    let tick = 0
    for (; tick < 40 && seeks[1].length === 0; tick++) {
      const edge = 299 + 4 * Math.floor(tick / 16)
      clock.progress(0, 300 + tick * 0.25, edge - 3, 0)
      clock.progress(1, 303 + tick * 0.25, edge, 0)
    }
    expect(
      seeks[1].length,
      'not left waiting for a seek it can never make'
    ).greaterThan(0)
    const shared = seeks[0].at(-1)!
    expect(seeks[1].at(-1)).closeTo(shared, 0.001)
    expect(clock.wall).equals(100000 + shared * 1000)
    for (const i of [0, 1]) {
      clock.settled(i)
      clock.progress(i, shared, 300, 0)
      expect(clock.available(i)).equals(true)
    }
  })
  it('leaves a paused follower beyond its safe edge where the viewer put it', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], []]
    for (let i = 0; i < 2; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    for (const i of [0, 1]) {
      clock.load(i, Infinity)
      clock.progress(i, 300, 296, 0)
      clock.settled(i)
    }
    clock.ports[0].timeline = {
      ...clock.ports[0].timeline,
      anchors: [[0, 108000]]
    }
    for (let i = 0; i < 2; i++) seeks[i].length = 0
    clock.progress(0, 300.25, 296, 0, false)
    clock.progress(1, 300.25, 296, 0, false)
    clock.progress(1, 300.5, 296, 0, false)
    expect(seeks).deep.equals([[], []])
  })
  it('never shows a live follower decoding ahead of a moment past its safe edge as in step', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], []]
    for (let i = 0; i < 2; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    // The follower's safe edge trails its decoder by 8 s.
    for (const i of [0, 1]) {
      clock.load(i, Infinity)
      clock.progress(i, 300, i === 0 ? 296 : 292, 0)
      clock.settled(i)
    }
    // A refresh places the follower's frames 5 s later on the wall: its
    // decoder is 5 s ahead of the shared moment, which it cannot seek.
    clock.ports[1].timeline = {
      ...clock.ports[1].timeline,
      anchors: [[0, 105000]]
    }
    for (let i = 0; i < 2; i++) seeks[i].length = 0
    const skew = (): number =>
      Math.abs(
        wallAt(
          clock.ports[1].timeline.anchors,
          clock.ports[1].position * 1000
        )! - clock.wall!
      )
    for (let tick = 1; tick <= 40; tick++) {
      const edge = 4 * Math.floor(tick / 16)
      if (seeks[0].length === 0) {
        clock.progress(0, 300 + tick * 0.25, 296 + edge, 0)
        clock.progress(1, 300 + tick * 0.25, 292 + edge, 0)
      }
      if (clock.available(1))
        expect(skew(), `shown in step at tick ${tick}`).lessThanOrEqual(250)
    }
    expect(seeks[1].length, 'brought into step').greaterThan(0)
    const shared = clock.wall!
    expect(shared).lessThanOrEqual(100000 + 296000)
    for (const i of [0, 1]) {
      clock.settled(i)
      clock.progress(i, seeks[i].at(-1)!, 304, 0)
    }
    expect(clock.available(1)).equals(true)
    expect(skew()).lessThanOrEqual(250)
  })
  it('realigns every playable camera within 250 ms of the moment when a follower mapping changes', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], [], []]
    for (let i = 0; i < 3; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    for (const i of [0, 1, 2]) {
      clock.load(i, Infinity)
      clock.progress(i, 300, 330, 0)
      clock.settled(i)
    }
    for (let i = 0; i < 3; i++) seeks[i].length = 0
    // Under the 0.75 s drift allowance, but over the 250 ms step.
    clock.remap(1, { ...clock.ports[1].timeline, anchors: [[0, 99500]] })
    expect(seeks).deep.equals([[], [300.5], []])
    expect(clock.wall).equals(400000)
    // A large correction is realigned at once, without waiting for a tick.
    clock.settled(1)
    clock.progress(1, 300.5, 330, 0)
    clock.remap(2, { ...clock.ports[2].timeline, anchors: [[0, 131500]] })
    expect(seeks[2]).deep.equals([268.5])
  })
  it('keeps a paused historical moment when the master mapping changes', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], []]
    for (let i = 0; i < 2; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    for (const i of [0, 1]) {
      clock.load(i, Infinity)
      clock.progress(i, 300, 600, 0)
      clock.settled(i)
    }
    // Rewound three minutes, then paused.
    clock.seek(100000 + 120000)
    for (const i of [0, 1]) {
      clock.settled(i)
      clock.progress(i, 120, 600, 0, false)
    }
    for (let i = 0; i < 2; i++) seeks[i].length = 0
    clock.remap(0, { ...clock.ports[0].timeline, anchors: [[0, 101000]] })
    // The master's frames now fall 1 s later: it moves back to the selected
    // moment, the follower is already there, and nothing is pulled to live.
    expect(seeks).deep.equals([[119], []])
    expect(clock.wall).equals(220000)
    clock.settled(0)
    clock.progress(0, 119, 600, 0, false)
    expect(clock.wall).equals(220000)
    expect(clock.available(0)).equals(true)
    expect(clock.available(1)).equals(true)
  })
  it('leaves a follower whose new mapping has no footage at the moment covered, and others in place', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], [], []]
    for (let i = 0; i < 3; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    for (const i of [0, 1, 2]) {
      clock.load(i, Infinity)
      clock.progress(i, 300, 330, 0)
      clock.settled(i)
    }
    for (let i = 0; i < 3; i++) seeks[i].length = 0
    // The refresh reveals an outage: footage from media 290 s resumes at
    // wall 460 s, so the moment (wall 400 s) is missing from this camera.
    clock.remap(2, {
      ...clock.ports[2].timeline,
      anchors: [
        [0, 100000],
        [290000, 460000]
      ]
    })
    expect(seeks).deep.equals([[], [], []])
    expect(clock.available(2)).equals(false)
    expect(clock.available(1)).equals(true)
  })
  it('does not seek when a refresh only adds footage after the moment', () => {
    const clock = new PlaybackClock()
    const seeks: number[][] = [[], []]
    for (let i = 0; i < 2; i++)
      clock.register(i, timeline(), seconds => seeks[i].push(seconds))
    for (const i of [0, 1]) {
      clock.load(i, Infinity)
      clock.progress(i, 300, 330, 0)
      clock.settled(i)
    }
    // 0.4 s apart: within the drift allowance, left alone.
    clock.progress(1, 300.4, 330, 0)
    for (let i = 0; i < 2; i++) seeks[i].length = 0
    for (const i of [0, 1])
      clock.remap(i, {
        ...clock.ports[i].timeline,
        anchors: [
          [0, 100000],
          [310000, 420000]
        ]
      })
    expect(seeks).deep.equals([[], []])
  })
  it('rejoins a live follower within the required half-second wall tolerance', () => {
    const clock = new PlaybackClock()
    for (let i = 0; i < 2; i++) clock.register(i, timeline(), () => undefined)
    clock.load(0, Infinity)
    clock.progress(0, 108.3, 108, 0)
    clock.load(1, Infinity)
    for (let tick = 0; tick < 120; tick++) {
      const edge = 108 + Math.floor(tick / 24) * 6
      clock.progress(0, 108.3 + tick * 0.25, edge, 0)
      clock.progress(1, 108 + tick * 0.25, edge, 0)
      expect(clock.available(1)).equals(true)
    }
  })
  it('keeps a nearby media frame covered across a wall timeline discontinuity', () => {
    const clock = new PlaybackClock()
    clock.register(0, timeline(), () => undefined)
    clock.register(
      1,
      {
        ...timeline(),
        anchors: [
          [0, 100000],
          [40000, 160000]
        ]
      },
      () => undefined
    )
    clock.load(0, Infinity)
    clock.load(1, Infinity)
    clock.progress(0, 39.9, 39.8, 0)
    clock.fail(1)
    clock.load(1, Infinity)
    clock.progress(1, 40, 39.8, 0)
    expect(clock.available(1)).equals(false)
    expect(clock.wall).equals(139900)
  })
  it('hands the clock to a recovered live follower when its master remains failed', () => {
    const clock = new PlaybackClock()
    for (let i = 0; i < 2; i++) {
      clock.register(i, timeline(), () => undefined)
      clock.load(i, Infinity)
    }
    clock.progress(0, 108.001, 108, 0)
    clock.settled(1)
    clock.progress(1, 108.001, 108, 0)
    clock.fail(1)
    clock.fail(0)
    clock.load(1, Infinity)
    clock.progress(1, 108.002, 108, 0)
    for (let seconds = 108.25; seconds < 112; seconds += 0.25)
      clock.progress(1, seconds, 108, 0)
    expect(clock.master).equals(1)
    expect(clock.wall).equals(211750)
    expect(clock.available(1)).equals(true)
  })
  it('retries a failed ended angle when rewind returns to its footage', () => {
    const clock = new PlaybackClock()
    const recovery = new PlaybackRecovery(0)
    for (let i = 0; i < 2; i++) {
      clock.register(i, timeline(), () => undefined)
      clock.load(i, i === 0 ? 10 : 100)
    }
    clock.seek(120000)
    expect(clock.ports[0].ended).equals(true)
    clock.fail(0)
    recovery.error(5001)
    clock.seek(105000)
    expect(clock.ports[0].ended).equals(false)
    expect(clock.ports[0].failed).equals(true)
    expect(recovery.retry(7000, false, clock.ports[0].ended)).equals(true)
  })
  it('keeps a future gap frame covered while another camera covers the selected time', () => {
    const clock = new PlaybackClock()
    clock.register(
      0,
      {
        ...timeline(),
        anchors: [
          [0, 100000],
          [40000, 160000]
        ]
      },
      () => undefined
    )
    clock.register(1, timeline(), () => undefined)
    clock.load(0, 100)
    clock.load(1, 100)
    clock.seek(150000)
    clock.settled(0)
    clock.settled(1)
    expect(clock.progress(0, 40)).equals(150000)
    expect(clock.available(0)).equals(false)
    clock.progress(1, 50)
    expect(clock.progress(1, 51)).equals(151000)
    expect(clock.progress(0, 42)).equals(151000)
    expect(clock.master).equals(1)
    expect(clock.available(0)).equals(false)
    expect(clock.progress(1, 61)).equals(161000)
    clock.settled(0)
    clock.progress(0, 41)
    expect(clock.available(0)).equals(true)
  })
  for (const count of [1, 2])
    it(`rejoins post-gap footage with ${count} cameras while preserving a paused gap selection`, () => {
      const clock = new PlaybackClock()
      const held = {
        ...timeline(),
        anchors: [
          [0, 100000],
          [40000, 160000]
        ] as Array<[number, number]>
      }
      for (let i = 0; i < count; i++) {
        clock.register(i, held, () => undefined)
        clock.load(i, 100)
      }
      clock.seek(150000)
      for (let i = 0; i < count; i++) {
        clock.settled(i)
        expect(clock.progress(i, 40, undefined, undefined, false)).equals(
          150000
        )
        expect(clock.available(i)).equals(false)
      }
      expect(clock.progress(0, 41)).equals(161000)
      expect(clock.available(0)).equals(true)
      expect(clock.progress(0, 42)).equals(162000)
    })
  it('rejoins matching decoded live frames beyond the safe seek edge without seeking', () => {
    const clock = new PlaybackClock()
    const seeks: number[] = []
    for (let i = 0; i < 4; i++)
      clock.register(i, timeline(), seconds => seeks.push(seconds))
    clock.load(0, Infinity)
    clock.progress(0, 108.0009, 108, 0)
    for (let i = 1; i < 4; i++) {
      clock.load(i, Infinity)
      expect(clock.available(i)).equals(false)
      clock.progress(i, 108.001, 108, 0)
      expect(clock.available(i)).equals(true)
      expect(clock.ports[i].pendingWall).equals(null)
    }
    expect(seeks).deep.equals([])
    clock.progress(0, 109, 108, 0)
    for (let i = 1; i < 4; i++) {
      clock.progress(i, 109.01, 108, 0)
      expect(clock.available(i)).equals(true)
    }
  })
  it('does not substitute a nearby decoded frame for a paused live selection', () => {
    const clock = new PlaybackClock()
    clock.register(0, timeline(), () => undefined)
    clock.load(0, Infinity)
    clock.progress(0, 108.001, 108, 0)
    clock.fail(0)
    clock.load(0, Infinity)
    clock.progress(0, 108.002, 108, 0, false)
    expect(clock.available(0)).equals(false)
    expect(clock.ports[0].pendingWall).equals(208001)
    clock.progress(0, 110, 108, 0)
    expect(clock.available(0)).equals(false)
    clock.progress(0, 108.002)
    expect(clock.available(0)).equals(true)
  })
  it('waits for fresh live bounds before restoring the selected moment', () => {
    const clock = new PlaybackClock()
    const seeks: number[] = []
    clock.register(0, timeline(), seconds => seeks.push(seconds))
    clock.load(0, Infinity)
    clock.progress(0, 112, 108, 0)
    clock.fail(0)
    clock.load(0, Infinity)
    expect(clock.available(0)).equals(false)
    expect(clock.progress(0, 200, 210, 0)).equals(212000)
    expect(seeks).deep.equals([112])
    clock.settled(0)
    clock.progress(0, 112, 210, 0)
    expect(clock.progress(0, 113, 210, 0)).equals(213000)
    expect(clock.available(0)).equals(true)
  })
  it('retains a new rewind while live bounds are unknown and an expired target stays unavailable', () => {
    const clock = new PlaybackClock()
    const seeks: number[] = []
    clock.register(0, timeline(), seconds => seeks.push(seconds))
    clock.load(0, Infinity)
    clock.progress(0, 112, 108, 0)
    clock.fail(0)
    clock.load(0, Infinity)
    clock.seek(180000)
    expect(seeks).deep.equals([])
    expect(clock.progress(0, 200)).equals(180000)
    expect(clock.progress(0, 200, 210, 120)).equals(180000)
    expect(seeks).deep.equals([])
    expect(clock.available(0)).equals(false)
    clock.seek(230000)
    expect(seeks).deep.equals([130])
  })
  it('accepts a successful zero-duration live reload and restores its selected moment', () => {
    const clock = new PlaybackClock()
    const seeks: number[] = []
    clock.register(0, timeline(), seconds => seeks.push(seconds))
    clock.load(0, Infinity)
    clock.progress(0, 1, 30, 0)
    clock.fail(0)
    clock.load(0, 0)
    expect(clock.ports[0].failed).equals(false)
    clock.progress(0, 20, 30, 0)
    expect(seeks).deep.equals([1])
    clock.settled(0)
    clock.progress(0, 1, 30, 0)
    expect(clock.progress(0, 2, 30, 0)).equals(102000)
    expect(clock.available(0)).equals(true)
  })
  it('seeks a live clock within its growing native seekable extent', () => {
    const clock = new PlaybackClock()
    const seeks: number[] = []
    clock.register(0, timeline(), seconds => seeks.push(seconds))
    clock.load(0, Infinity)
    clock.progress(0, 40)
    expect(clock.move(10)).equals(null)
    clock.progress(0, 40, 60)
    expect(clock.recordingExtent()).deep.equals({ start: 100000, end: 160000 })
    expect(clock.move(-10)).equals(130000)
    expect(seeks).deep.equals([30])
    clock.settled(0)
    clock.progress(0, 30, 80)
    expect(clock.move(100)).equals(179900)
    expect(clock.ports[0].duration).equals(Infinity)
    clock.progress(0, 30, NaN)
    expect(clock.recordingExtent()?.end).equals(180000)
  })

  it('keeps playing native frames beyond the live seek limit after recovery', () => {
    const clock = new PlaybackClock()
    clock.register(0, timeline(), () => undefined)
    clock.register(1, timeline(), () => undefined)
    clock.load(0, Infinity)
    clock.load(1, Infinity)
    clock.progress(0, 108.001, 108)
    clock.settled(1)
    clock.progress(1, 108.001, 108)
    expect(clock.available(0)).equals(true)
    expect(clock.progress(0, 112, 108)).equals(212000)
    expect(clock.progress(1, 112, 108)).equals(212000)
    expect(clock.available(1)).equals(true)
    expect(clock.recordingExtent()?.end).equals(208000)
    expect(clock.move(-10)).equals(202000)
  })

  it('uses native sliding-window endpoints and hides cameras outside their own window', () => {
    const clock = new PlaybackClock()
    const seeks: number[] = []
    clock.register(0, timeline(), seconds => seeks.push(seconds))
    clock.register(1, timeline(), () => undefined)
    clock.load(0, Infinity)
    clock.load(1, Infinity)
    clock.progress(0, 90, 120, 40)
    clock.progress(1, 90, 120, 80)
    expect(clock.recordingExtent()).deep.equals({ start: 140000, end: 220000 })
    expect(clock.move(-100)).equals(140000)
    expect(seeks.at(-1)).equals(40)
    expect(clock.available(0)).equals(true)
    expect(clock.available(1)).equals(false)
    clock.seek(230000)
    expect(clock.available(0)).equals(false)
    clock.progress(0, 90, 150, 60)
    expect(clock.available(0)).equals(true)
  })

  it('marks the snapped future frame unavailable inside a recording outage', () => {
    const held = {
      ...timeline(),
      anchors: [
        [0, 100000],
        [10000, 130000]
      ] as Array<[number, number]>
    }
    expect(targetTime(held, 120000, 60)).deep.equals({
      seconds: 10,
      available: false
    })
    expect(targetTime(held, 130000, 60)).deep.equals({
      seconds: 10,
      available: true
    })
  })

  it('makes a reloaded failed camera available at the shared moment', () => {
    const clock = new PlaybackClock()
    const seeks: number[] = []
    clock.register(0, timeline(), seconds => seeks.push(seconds))
    clock.load(0, 60)
    clock.progress(0, 20)
    expect(clock.fail(0)).equals(true)
    clock.load(0, 80)
    expect(clock.available(0)).equals(true)
    expect(seeks).deep.equals([20])
    clock.settled(0)
    expect(clock.progress(0, 20)).equals(120000)
  })
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
  it('centers two angles, fills the three-angle board cell and isolates TV settings', () => {
    const screen = { width: 1920, height: 1080 }
    const settings = { ...defaultScoreboardSettings, show: true }
    const three = tvLayout(initialPlayback(3), screen, settings, true, true)
    expect(three.tiles[0].x).equals(960)
    expect(three.tiles[1].y).equals(540)
    expect(three.box).not.equals(null)
    const two = tvLayout(initialPlayback(2), screen, settings, true, true)
    expect(two.tiles[0].y).equals(270)
    expect(two.board!.h).closeTo(two.box!.h, 0.001)
    expect(three.board!.w).equals(960)
    expect(three.box!.w).equals(960)
    expect(three.box!.y + three.box!.h).at.most(540)
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
  it('ignores late native progress and seek completions after a clock reset', () => {
    const clock = new PlaybackClock()
    expect(clock.progress(0, 12)).equals(null)
    expect(() => {
      clock.settled(0)
    }).not.throws()
  })

  it('exposes only finite known recording bounds for proportional scrubbing', () => {
    const clock = new PlaybackClock()
    expect(clock.extent()).equals(null)
    clock.register(0, timeline(), () => undefined)
    clock.load(0, 0)
    expect(clock.extent()).equals(null)
    clock.load(0, 60)
    expect(clock.extent()).deep.equals({ start: 100000, end: 159900 })
    expect(clock.recordingExtent()).deep.equals({ start: 100000, end: 160000 })
    clock.register(
      1,
      {
        anchors: [],
        source: 'start',
        confidence: 'approximate',
        live: false,
        startAt: null
      },
      () => undefined
    )
    clock.load(1, 60)
    expect(clock.extent()).equals(null)
    clock.fail(1)
    expect(clock.extent()).deep.equals({ start: 100000, end: 159900 })
    expect(clock.recordingExtent()).deep.equals({ start: 100000, end: 160000 })
    clock.load(0, 0.01)
    expect(clock.extent()).equals(null)
  })
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
  it('leaves a camera that has not started yet alone until the wall reaches its footage', () => {
    const seeks: number[][] = [[], []]
    const clock = new PlaybackClock()
    clock.register(0, timeline(), value => seeks[0].push(value))
    clock.register(1, timeline(10_000), value => seeks[1].push(value))
    clock.load(0, 60)
    clock.load(1, 60)
    clock.seek(100_000)
    expect(seeks[1]).deep.equals([0])
    expect(clock.available(1)).equals(false)
    clock.settled(0)
    clock.settled(1)
    for (let second = 1; second <= 8; second++) {
      clock.progress(1, second)
      clock.progress(0, second)
    }
    expect(seeks[1], 'no tick-by-tick reseek during the lead-in').deep.equals([
      0
    ])
    for (let second = 9; second <= 11; second++) {
      clock.progress(1, second)
      clock.progress(0, second)
    }
    expect(clock.available(1)).equals(true)
    expect(seeks[1], 'one correction where its footage begins').deep.equals([
      0, 0
    ])
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
    expect(allFailed.fail(1)).equals(true)
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
