import { expect } from 'chai'
import { describe, it } from 'mocha'

import { halvesOf, stateBefore } from '../../common/replay/replayRewind'
import {
  extendTimeline,
  type ReplayTimeline,
  replayTimelineOf
} from '../../common/replay/replayTimeline'
import { allowedAngle } from '../../common/scoring/rules'
import {
  correctedGame,
  finalGame,
  firstActionOfHalf,
  inProgressGame,
  replayActions,
  replayContext,
  scored
} from '../../test/replayGameFixture'
import { initialScoringState, scoringReducer } from '../scoring/scoringMachine'
import {
  CATCH_UP_MS,
  catchingUp,
  CELEBRATION_MS,
  HALF_MS,
  IN_PLAY_TAIL_MS,
  LIVE_HALF_MS,
  LIVE_SLOT_MS,
  replayCard,
  replayIdle,
  replayReducer,
  type ReplayState,
  REWIND_NOTICE_MS,
  SLOT_MS,
  startReplay
} from './replayMachine'

const context = replayContext()
const WORDS = {
  playBall: 'Play ball!',
  waiting: 'Waiting for the next pitch',
  paused: 'Paused',
  changed: 'Play changed by the scorer'
}

/** One field callback, as a field sends them: contact, done, each motion. */
function field(state: ReplayState): ReplayState {
  const shown = state.scoring.presentation
  if (shown != null)
    return replayReducer(state, {
      type: 'FIELD',
      event:
        shown.kind === 'hit' && shown.stage === 'swing'
          ? {
              type: 'PRESENTATION_CONTACT',
              id: shown.id,
              generation: shown.generation
            }
          : {
              type: 'PRESENTATION_DONE',
              id: shown.id,
              generation: shown.generation,
              stage: shown.stage
            }
    })
  const moving = state.scoring.motions.find(motion => !motion.complete)
  if (moving == null) return state
  return replayReducer(state, {
    type: 'FIELD',
    event: { type: 'MOTION_DONE', id: moving.id, generation: moving.generation }
  })
}

interface Run {
  state: ReplayState
  /** When each step started, by key, in ms. */
  started: Map<string, number>
  now: number
}

/** Ticks every 100 ms, the field answering every 300 ms, until `until`. */
function run(
  state: ReplayState,
  until: (state: ReplayState) => boolean,
  from = 0,
  answer = true
): Run {
  const started = new Map<string, number>()
  let now = from
  let last = state.shown?.key ?? ''
  let next = state
  for (let i = 0; i < 40000 && !until(next); i++) {
    now += 100
    next = replayReducer(next, { type: 'TICK', now })
    if (answer && now % 300 === 0) next = field(next)
    const key = next.shown?.key ?? ''
    if (key !== last || next.shownCount !== state.shownCount) {
      if (!started.has(key)) started.set(key, now)
      last = key
    }
  }
  return { state: next, started, now }
}

/** When a replay's first pitch is thrown: after "Play ball!" has shown. */
const FIRST = 100 + SLOT_MS.other

/** A replay at its first pitch, having opened on "Play ball!". */
function atFirstPitch(timeline: ReplayTimeline): ReplayState {
  let state = replayReducer(startReplay('replay', timeline), {
    type: 'TICK',
    now: 100
  })
  expect(state.shown).equals(null)
  expect(replayCard(state, WORDS).line).equals('Play ball!')
  state = replayReducer(state, { type: 'TICK', now: FIRST - 100 })
  expect(state.shown).equals(null)
  state = replayReducer(state, { type: 'TICK', now: FIRST })
  expect(state.shown?.key).equals('0-0')
  return state
}

async function timelineOf(
  stored: Promise<Awaited<ReturnType<typeof finalGame>>>
): Promise<ReplayTimeline> {
  return replayTimelineOf(await stored, context)
}

describe('replay machine', function () {
  this.timeout(60000)

  it('plays every step of a finished game to the final out, ending on the stored game', async function () {
    const timeline = await timelineOf(finalGame())
    const start = startReplay('replay', timeline)
    expect(replayCard(start, WORDS).line).equals('Play ball!')
    const done = run(start, state => state.final)
    expect(done.state.final).equals(true)
    expect(done.state.queue).length(0)
    expect(done.state.scoring.session.liveData.linescore.teams).deep.equals(
      timeline.end.liveData.linescore.teams
    )
    expect(done.state.scoring.past).length(0)
    expect(done.state.scoring.log).length(0)
    expect(done.state.scoring.checkpoints).length(0)
    expect(replayCard(done.state, WORDS).line).equals(
      "That's the ballgame! Valley Pines win, three to two."
    )
    expect(replayCard(done.state, WORDS).detail).equals('')
    // Ignored once over.
    expect(replayReducer(done.state, { type: 'PAUSE', now: done.now })).equals(
      done.state
    )
  })

  it('throws a pitch every four and a half seconds, and waits longer for a ball in play and a new half', async function () {
    const timeline = await timelineOf(finalGame())
    const { started } = run(
      startReplay('replay', timeline),
      state => state.shown?.key === '4-1'
    )
    const at = (key: string): number => started.get(key)!
    expect(at('0-1') - at('0-0')).equals(SLOT_MS.pitch)
    expect(at('0-2') - at('0-1')).equals(SLOT_MS.pitch)
    // Rizzo's single settles, then waits out its tail.
    expect(at('3-1') - at('2-3')).greaterThanOrEqual(SLOT_MS.inPlay)
    // The double play ends the top of the 1st.
    expect(at('4-1') - at('3-2')).greaterThanOrEqual(SLOT_MS.inPlay + HALF_MS)
    expect(IN_PLAY_TAIL_MS).lessThan(SLOT_MS.inPlay)
  })

  it('flies a ball to where the scorer put it, at the angle set, and lights up a home run', async function () {
    const timeline = await timelineOf(finalGame())
    const homer = replayActions().find(
      action =>
        action.type === 'ballInPlay' && action.homeRunKind === 'out-of-park'
    )!
    const reached = run(
      startReplay('replay', timeline),
      state =>
        state.scoring.presentation?.kind === 'hit' && state.shown?.key === '4-2'
    )
    const hit = reached.state.scoring.presentation!
    if (hit.kind !== 'hit' || homer.type !== 'ballInPlay')
      throw new Error('no hit')
    // Out of the park, the landing is carried along the scorer's line to
    // past the fence, as on the scorer's own field.
    const { x, z } = homer.location!
    expect(Math.atan2(hit.arc.target.x, hit.arc.target.z)).closeTo(
      Math.atan2(x, z),
      1e-9
    )
    expect(Math.hypot(hit.arc.target.x, hit.arc.target.z)).greaterThanOrEqual(
      Math.hypot(x, z)
    )
    // At the scorer's angle, in whole degrees as the scorer's field draws it.
    expect(hit.arc.angle).equals(
      allowedAngle(homer.launchAngle!, 'Home Run', 'out-of-park')
    )
    expect(hit.arc.angle).equals(32)
    // The lights go up with the step, and the next tick starts their time.
    const applied = reached.started.get('4-2')!
    const lit = reached.state.scoring.celebration!
    expect(lit.kind).equals('out-of-park')
    const lights = run(
      reached.state,
      state => state.scoring.celebration == null,
      reached.now
    )
    expect(lights.now).equals(applied + 100 + CELEBRATION_MS)
    // The next pitch waits for them to go out.
    expect(lights.started.get('5-1') ?? Infinity).greaterThanOrEqual(lights.now)
  })

  it('waits for a hit that never makes contact rather than skipping it', async function () {
    const timeline = await timelineOf(finalGame())
    const at = run(
      startReplay('replay', timeline),
      state => state.shown?.key === '2-3'
    )
    const stuck = run(at.state, () => false, at.now, false)
    expect(stuck.state.shown?.key).equals('2-3')
    expect(replayIdle(stuck.state.scoring)).equals(false)
  })

  it('holds on pause, and restarts what was left of the slot on play', async function () {
    const timeline = await timelineOf(finalGame())
    let state = atFirstPitch(timeline)
    state = replayReducer(state, { type: 'PAUSE', now: FIRST + 1000 })
    expect(state.paused).equals(true)
    expect(replayCard(state, WORDS).detail).equals('Paused')
    expect(replayReducer(state, { type: 'PAUSE', now: FIRST + 1100 })).equals(
      state
    )
    const held = run(state, () => false, FIRST + 1000)
    expect(held.state.shown?.key).equals('0-0')
    state = replayReducer(held.state, { type: 'PLAY', now: held.now })
    expect(state.slotEndsAt).equals(held.now + SLOT_MS.pitch - 1000)
    expect(replayReducer(state, { type: 'PLAY', now: held.now })).equals(state)
    const resumed = run(state, next => next.shown?.key === '0-1', held.now)
    expect(resumed.now - held.now).within(
      SLOT_MS.pitch - 1000,
      SLOT_MS.pitch - 1000 + 400
    )
  })

  it('pauses the home-run lights with the replay', async function () {
    const timeline = await timelineOf(finalGame())
    const lit = run(
      startReplay('replay', timeline),
      state =>
        state.scoring.celebration != null && state.celebrationEndsAt != null
    )
    let state = replayReducer(lit.state, { type: 'PAUSE', now: lit.now + 1000 })
    const held = run(state, () => false, lit.now + 1000)
    expect(held.state.scoring.celebration).not.equals(null)
    state = replayReducer(held.state, { type: 'PLAY', now: held.now })
    expect(state.celebrationEndsAt).equals(held.now + CELEBRATION_MS - 1000)
  })

  it('waits for the announcer before the next step', async function () {
    const timeline = await timelineOf(finalGame())
    let state = atFirstPitch(timeline)
    state = replayReducer(state, { type: 'SPEAKING', speaking: true })
    expect(replayReducer(state, { type: 'SPEAKING', speaking: true })).equals(
      state
    )
    const held = run(state, () => false, FIRST)
    expect(held.state.shown?.key).equals('0-0')
    state = replayReducer(held.state, { type: 'SPEAKING', speaking: false })
    expect(
      run(state, next => next.shown?.key === '0-1', held.now).state.shown?.key
    ).equals('0-1')
  })

  it('writes where the game stands under the sentence', async function () {
    const timeline = await timelineOf(finalGame())
    const at = run(
      startReplay('replay', timeline),
      state => state.shown?.key === '2-3' && replayIdle(state.scoring)
    )
    expect(replayCard(at.state, WORDS)).deep.equals({
      line: 'Anthony R lines a single to left field. Juan S scores! Harbor Hawks lead one to nothing.',
      detail: '0–0 · 1 out · runner on 1st'
    })
  })

  describe('live', function () {
    const actions = replayActions()

    it('opens on the game as it stands, with nothing animating', async function () {
      const timeline = await timelineOf(inProgressGame())
      const state = startReplay('live', timeline)
      expect(state.queue).length(0)
      expect(state.shown?.key).equals(timeline.steps.at(-1)?.key)
      expect(replayIdle(state.scoring)).equals(true)
      expect(state.final).equals(false)
      expect(state.scoring.session.liveData.linescore.balls).equals(
        timeline.end.liveData.linescore.balls
      )
      expect(replayCard(state, WORDS).line).equals(
        state.narrations.get(timeline.steps.at(-1)!.key)!.text
      )
      const empty = startReplay('live', await timelineOf(scored([])))
      expect(empty.shown).equals(null)
      expect(replayCard(empty, WORDS).line).equals('Waiting for the next pitch')
    })

    it('plays what the scorer adds, and a grown step only for what it grew by', async function () {
      const inPlay = actions.findIndex(action => action.type === 'ballInPlay')
      const before = await timelineOf(scored(actions.slice(0, inPlay)))
      let state = startReplay('live', before)
      const hit = extendTimeline(
        before,
        await scored(actions.slice(0, inPlay + 1)),
        context
      )
      state = replayReducer(state, { type: 'CHANGED', change: hit })
      expect(
        state.queue.map(entry => entry.actions.map(a => a.type))
      ).deep.equals([['ballInPlay']])
      const played = run(
        state,
        next => next.queue.length === 0 && replayIdle(next.scoring)
      )
      expect(played.state.shownCount).equals(1)
      const grown = extendTimeline(
        hit.timeline,
        await scored(actions.slice(0, inPlay + 3)),
        context
      )
      state = replayReducer(played.state, { type: 'CHANGED', change: grown })
      expect(
        state.queue.map(entry => entry.actions.map(a => a.type))
      ).deep.equals([['result', 'runnerMovement']])
      const done = run(
        state,
        next => next.queue.length === 0 && replayIdle(next.scoring),
        played.now
      )
      expect(done.state.changed).equals(false)
      expect(done.state.shownCount).equals(3)
      expect(
        done.state.scoring.session.liveData.linescore.teams.away.runs
      ).equals(1)
    })

    it('replaces a queued step that grew before it played', async function () {
      const before = await timelineOf(scored(actions.slice(0, 10)))
      let state = startReplay('live', before)
      state = { ...state, paused: true }
      const first = extendTimeline(
        before,
        await scored(actions.slice(0, 11)),
        context
      )
      state = replayReducer(state, { type: 'CHANGED', change: first })
      const second = extendTimeline(
        first.timeline,
        await scored(actions.slice(0, 12)),
        context
      )
      state = replayReducer(state, { type: 'CHANGED', change: second })
      expect(state.queue).length(1)
      expect(state.queue[0].actions.map(action => action.type)).deep.equals([
        'pitch',
        'baseRunning'
      ])
    })

    it('waits for the scorer’s close of a walk, and takes it without a snap', async function () {
      const four = actions.findIndex((action, i) => i === 4)
      const before = await timelineOf(scored(actions.slice(0, four)))
      let state = startReplay('live', before)
      const ball = extendTimeline(
        before,
        await scored(actions.slice(0, four + 1)),
        context
      )
      state = replayReducer(state, { type: 'CHANGED', change: ball })
      let now = run(
        state,
        next => next.queue.length === 0 && replayIdle(next.scoring)
      ).now
      state = run(
        state,
        next => next.queue.length === 0 && replayIdle(next.scoring)
      ).state
      expect(state.scoring.session.pending).not.equals(null)
      const closed = extendTimeline(
        ball.timeline,
        await scored(actions.slice(0, four + 2)),
        context
      )
      state = replayReducer(state, { type: 'CHANGED', change: closed })
      const after = run(
        state,
        next => next.queue.length === 0 && replayIdle(next.scoring),
        now
      )
      now = after.now
      expect(after.state.changed).equals(false)
      expect(after.state.scoring.session.pending).equals(null)
      expect(replayCard(after.state, WORDS).line).not.contains('Play changed')
    })

    it('keeps within a moment of the scorer: a short slot for each step', async function () {
      const before = await timelineOf(scored(actions.slice(0, 1)))
      let state = startReplay('live', before)
      const next = extendTimeline(
        before,
        await scored(actions.slice(0, 2)),
        context
      )
      state = replayReducer(state, { type: 'CHANGED', change: next })
      state = replayReducer(state, { type: 'TICK', now: 100 })
      expect(state.slotEndsAt).equals(100 + LIVE_SLOT_MS.pitch)
      expect(LIVE_SLOT_MS.pitch).lessThan(SLOT_MS.pitch)
      // A new half waits a little, not a replay's pause.
      expect(LIVE_HALF_MS).lessThan(HALF_MS)
    })

    it('catches up quickly when the scorer is several steps ahead', async function () {
      const before = await timelineOf(scored(actions.slice(0, 1)))
      let state = startReplay('live', before)
      const ahead = extendTimeline(
        before,
        await scored(actions.slice(0, 9)),
        context
      )
      state = replayReducer(state, { type: 'CHANGED', change: ahead })
      expect(state.queue.length).greaterThan(3)
      state = replayReducer(state, { type: 'TICK', now: 100 })
      expect(state.slotEndsAt).equals(100 + CATCH_UP_MS)
      // A pitch in catch-up is drawn without its presentation.
      expect(state.scoring.presentation).equals(null)
      // It keeps hurrying until one step is left, then paces as usual.
      const hurried: number[] = []
      let at = 100
      while (state.queue.length > 0) {
        const before = state.queue.length
        at += 100
        state = field(replayReducer(state, { type: 'TICK', now: at }))
        if (state.queue.length < before) hurried.push(state.slotEndsAt! - at)
      }
      const last = hurried.length - 1
      expect(hurried.slice(0, last).every(slot => slot === CATCH_UP_MS)).equals(
        true
      )
      expect(hurried[last]).greaterThan(CATCH_UP_MS)
      expect(state.hurrying).equals(false)
    })

    it('catches up without waiting for the announcer', async function () {
      const before = await timelineOf(scored(actions.slice(0, 1)))
      let state = startReplay('live', before)
      state = replayReducer(state, {
        type: 'CHANGED',
        change: extendTimeline(
          before,
          await scored(actions.slice(0, 9)),
          context
        )
      })
      state = replayReducer(state, { type: 'TICK', now: 100 })
      expect(catchingUp(state)).equals(true)
      // The announcer is reading the step just shown.
      state = replayReducer(state, { type: 'SPEAKING', speaking: true })
      const queued = state.queue.length
      state = field(
        replayReducer(state, { type: 'TICK', now: 100 + CATCH_UP_MS })
      )
      expect(state.queue.length).equals(queued - 1)
      expect(state.slotEndsAt).equals(100 + 2 * CATCH_UP_MS)
      // Caught up to the last step, it waits for the sentence again.
      while (catchingUp(state)) {
        state = replayReducer(state, {
          type: 'TICK',
          now: (state.slotEndsAt ?? 0) + 1
        })
        state = field(field(field(state)))
      }
      state = replayReducer(state, { type: 'SPEAKING', speaking: true })
      const waiting = state.queue.length
      state = replayReducer(state, { type: 'TICK', now: 1e9 })
      expect(state.queue.length).equals(waiting)
    })

    it('ends when the plays it reads end the game, though the server never says so', async function () {
      const timeline = await timelineOf(inProgressGame())
      let state = startReplay('live', timeline)
      // The phone was away as the last out and the end were saved; reading
      // the game again brings them, and no word that the game is final.
      state = replayReducer(state, {
        type: 'CHANGED',
        change: extendTimeline(timeline, await finalGame(), context)
      })
      expect(state.gameOver).equals(true)
      state = run(state, next => next.final, 100).state
      expect(state.final).equals(true)
      expect(replayCard(state, WORDS).line).equals(
        "That's the ballgame! Valley Pines win, three to two."
      )
    })

    it('snaps to the corrected game when the scorer changes a play', async function () {
      const lastPitch = actions.findLastIndex(action => action.type === 'pitch')
      const before = await timelineOf(scored(actions.slice(0, lastPitch + 1)))
      let state = startReplay('live', before)
      const corrected = extendTimeline(before, await correctedGame(), context)
      expect(corrected.kind).equals('rewrite')
      state = replayReducer(state, { type: 'CHANGED', change: corrected })
      expect(state.changed).equals(true)
      expect(replayCard(state, WORDS).line).match(
        /^Play changed by the scorer\. /
      )
      expect(state.queue).length(0)
    })

    it('shows a fresh count while a decided play waits for the scorer\u2019s close', async function () {
      const close = actions.findIndex(
        (action, i) =>
          i > 0 &&
          action.type === 'gameFlow' &&
          action.kind === 'closePlay' &&
          actions[i - 1].type === 'pitch'
      )
      const state = startReplay(
        'live',
        await timelineOf(scored(actions.slice(0, close)))
      )
      expect(state.scoring.session.pending).not.equals(null)
      expect(replayCard(state, WORDS).detail).match(/^0–0 · /)
    })

    it('stays paused, and over, through a correction', async function () {
      const lastPitch = actions.findLastIndex(action => action.type === 'pitch')
      const before = await timelineOf(scored(actions.slice(0, lastPitch + 1)))
      let state = startReplay('live', before)
      state = replayReducer(state, { type: 'PAUSE', now: 100 })
      state = replayReducer(state, { type: 'GAME_OVER' })
      const corrected = extendTimeline(before, await correctedGame(), context)
      state = replayReducer(state, { type: 'CHANGED', change: corrected })
      expect(state.changed).equals(true)
      expect(state.paused).equals(true)
      expect(state.gameOver).equals(true)
      expect(replayCard(state, WORDS).detail).equals('Paused')
    })

    it('takes a step the game will not apply as a change by the scorer', async function () {
      const timeline = await timelineOf(inProgressGame())
      let state = startReplay('live', timeline)
      state = {
        ...state,
        queue: [
          {
            step: timeline.steps.at(-1)!,
            actions: [{ type: 'gameFlow', kind: 'closePlay' }]
          }
        ]
      }
      state = replayReducer(state, { type: 'TICK', now: 100 })
      expect(state.changed).equals(true)
      expect(state.queue).length(0)
    })

    it('goes to how a finished game ended when the game will not take a step, without blaming the scorer', async function () {
      const timeline = await timelineOf(finalGame())
      let state = atFirstPitch(timeline)
      state = replayReducer(state, { type: 'PAUSE', now: FIRST + 100 })
      state = {
        ...state,
        queue: [
          {
            step: state.queue[0].step,
            actions: [{ type: 'gameFlow', kind: 'closePlay' }]
          },
          ...state.queue.slice(1)
        ]
      }
      state = replayReducer(state, { type: 'PLAY', now: FIRST + 200 })
      state = run(state, next => next.queue.length === 0, FIRST + 200).state
      expect(state.mode).equals('replay')
      expect(state.changed).equals(false)
      expect(state.paused).equals(false)
      expect(state.scoring.session.liveData.linescore.teams).deep.equals(
        timeline.end.liveData.linescore.teams
      )
      state = replayReducer(state, { type: 'TICK', now: 1e9 })
      expect(state.final).equals(true)
      expect(replayCard(state, WORDS).line).equals(
        "That's the ballgame! Valley Pines win, three to two."
      )
    })

    it('ends a game the server calls final though its plays record no end', async function () {
      const actions = replayActions()
      const timeline = replayTimelineOf(
        await scored(actions.slice(0, -1)),
        context
      )
      expect(timeline.end.final).equals(false)
      // Not final: the view waits at the last play.
      const waiting = run(
        startReplay('replay', timeline),
        state => state.queue.length === 0
      )
      expect(
        replayReducer(waiting.state, { type: 'TICK', now: waiting.now + 1e6 })
          .final
      ).equals(false)
      const done = run(
        startReplay('replay', timeline, true),
        state => state.final
      )
      expect(done.state.final).equals(true)
      expect(done.state.queue).length(0)
    })

    it('ends on the final out once the server says the game is over', async function () {
      const timeline = await timelineOf(inProgressGame())
      let state = startReplay('live', timeline)
      state = replayReducer(state, { type: 'TICK', now: 100 })
      expect(state.final).equals(false)
      state = replayReducer(state, { type: 'GAME_OVER' })
      expect(replayReducer(state, { type: 'GAME_OVER' })).equals(state)
      state = replayReducer(state, { type: 'TICK', now: 200 })
      expect(state.final).equals(true)
      // Reading the game again with nothing new leaves it over.
      const again = replayReducer(state, {
        type: 'CHANGED',
        change: extendTimeline(state.timeline, await inProgressGame(), context)
      })
      expect(again.final).equals(true)
      const over = startReplay('live', await timelineOf(finalGame()))
      expect(over.final).equals(true)
    })
  })

  describe('rewind', function () {
    const REWIND = {
      top: 'Rewind to top of %s',
      bottom: 'Rewind to bottom of %s'
    }

    /** The first step index of each half, in order. */
    function halfStarts(timeline: ReplayTimeline): number[] {
      const halves = halvesOf(timeline)
      return halves.flatMap((half, index) =>
        index === 0 ||
        half.inning !== halves[index - 1].inning ||
        half.isTop !== halves[index - 1].isTop
          ? [index]
          : []
      )
    }

    function rewind(state: ReplayState, now: number): ReplayState {
      return replayReducer(state, { type: 'REWIND', now, words: REWIND })
    }

    /** A replay run until the step at `index` is the one shown. */
    function shownAt(
      timeline: ReplayTimeline,
      index: number
    ): { state: ReplayState; now: number } {
      const key = timeline.steps[index].key
      const reached = run(
        startReplay('replay', timeline),
        state => state.shown?.key === key
      )
      return { state: reached.state, now: reached.now }
    }

    it('stands the field where the scoring screen stood at the start of each half', async function () {
      const timeline = await timelineOf(finalGame())
      for (const index of halfStarts(timeline)) {
        let state = initialScoringState(timeline.start, false, {
          watching: true
        })
        for (const step of timeline.steps.slice(0, index))
          state = scoringReducer(state, {
            type: 'REPLAYED',
            actions: step.actions
          })
        const reducer = state.session.liveData.linescore
        const rebuilt = stateBefore(timeline, index).liveData.linescore
        expect(rebuilt.currentInning).equals(reducer.currentInning)
        expect(rebuilt.isTopInning).equals(reducer.isTopInning)
        expect(rebuilt.outs).equals(reducer.outs)
        expect(rebuilt.teams).deep.equals(reducer.teams)
        expect(rebuilt.offense.first ?? null).deep.equals(
          reducer.offense.first ?? null
        )
      }
    })

    it('goes back to the start of the half after two of its steps, and plays on from there', async function () {
      const timeline = await timelineOf(finalGame())
      const top2 = halfStarts(timeline)[2]
      const { state: at, now } = shownAt(timeline, top2 + 1)
      const back = rewind(at, now)
      expect(back.queue[0].step.key).equals(timeline.steps[top2].key)
      expect(back.queue).length(timeline.steps.length - top2)
      expect(Object.keys(back.applied)).length(top2)
      expect(back.applied[timeline.steps[top2].key]).equals(undefined)
      expect(back.shown?.key).equals(timeline.steps[top2 - 1].key)
      const line = back.scoring.session.liveData.linescore
      expect([line.currentInning, line.isTopInning, line.outs]).deep.equals([
        2,
        true,
        0
      ])
      expect(back.scoring.generation).greaterThan(at.scoring.generation)
      expect(back.notice).deep.equals({
        id: 1,
        text: 'Rewind to top of second',
        endsAt: now + REWIND_NOTICE_MS
      })
      expect(replayCard(back, WORDS)).deep.equals({
        line: 'Rewind to top of second',
        detail: '0–0 · 0 outs'
      })
      let next = replayReducer(back, {
        type: 'TICK',
        now: now + REWIND_NOTICE_MS - 100
      })
      expect(next.shown?.key).equals(timeline.steps[top2 - 1].key)
      expect(next.notice).not.equals(null)
      next = replayReducer(next, { type: 'TICK', now: now + REWIND_NOTICE_MS })
      expect(next.shown?.key).equals(timeline.steps[top2].key)
      expect(next.notice).equals(null)
      // The rest of the game plays to the same end.
      const done = run(next, state => state.final, now + REWIND_NOTICE_MS)
      expect(done.state.scoring.session.liveData.linescore.teams).deep.equals(
        timeline.end.liveData.linescore.teams
      )
    })

    it('goes one half further back on a second tap, and to the first pitch from the first half', async function () {
      const timeline = await timelineOf(finalGame())
      const [, bottom1, top2] = halfStarts(timeline)
      const { state: at, now } = shownAt(timeline, top2 + 1)
      const once = rewind(at, now)
      const twice = rewind(once, now + 300)
      expect(twice.notice?.text).equals('Rewind to bottom of first')
      expect(twice.notice?.id).equals(2)
      expect(twice.rewinds).equals(2)
      expect(twice.queue[0].step.key).equals(timeline.steps[bottom1].key)
      const third = rewind(twice, now + 600)
      expect(third.notice?.text).equals('Rewind to top of first')
      expect(third.queue[0].step.key).equals(timeline.steps[0].key)
      expect(third.shown).equals(null)
      const fourth = rewind(third, now + 900)
      expect(fourth.notice?.text).equals('Rewind to top of first')
      expect(fourth.queue).length(timeline.steps.length)
      // The ids never repeat, even after the words have gone.
      const cleared = replayReducer(fourth, {
        type: 'TICK',
        now: now + 900 + REWIND_NOTICE_MS
      })
      expect(cleared.notice).equals(null)
      expect(rewind(cleared, now + 5000).notice?.id).equals(5)
    })

    it('rewinds from "Play ball!" to the first pitch', async function () {
      const timeline = await timelineOf(finalGame())
      const start = startReplay('replay', timeline)
      const back = rewind(start, 50)
      expect(back.notice?.text).equals('Rewind to top of first')
      expect(back.shown).equals(null)
      expect(back.queue).length(timeline.steps.length)
      expect(back.slotEndsAt).equals(50 + REWIND_NOTICE_MS)
    })

    it('stays paused, lets the words fade, and waits again on play', async function () {
      const timeline = await timelineOf(finalGame())
      const top2 = halfStarts(timeline)[2]
      const { state: at, now } = shownAt(timeline, top2 + 2)
      const paused = replayReducer(at, { type: 'PAUSE', now })
      const back = rewind(paused, now + 100)
      expect(back.paused).equals(true)
      expect(back.pausedSlot).equals(REWIND_NOTICE_MS)
      expect(back.slotEndsAt).equals(null)
      expect(replayCard(back, WORDS)).deep.equals({
        line: 'Rewind to top of second',
        detail: 'Paused'
      })
      let next = replayReducer(back, {
        type: 'TICK',
        now: now + 100 + REWIND_NOTICE_MS
      })
      expect(next.notice).equals(null)
      expect(next.shown?.key).equals(timeline.steps[top2 - 1].key)
      expect(replayCard(next, WORDS).detail).equals('Paused')
      const played = now + 10000
      next = replayReducer(next, { type: 'PLAY', now: played })
      next = replayReducer(next, {
        type: 'TICK',
        now: played + REWIND_NOTICE_MS - 100
      })
      expect(next.shown?.key).equals(timeline.steps[top2 - 1].key)
      next = replayReducer(next, {
        type: 'TICK',
        now: played + REWIND_NOTICE_MS
      })
      expect(next.shown?.key).equals(timeline.steps[top2].key)
    })

    it('plays the last half again after the end, and ends again', async function () {
      const timeline = await timelineOf(finalGame())
      const top3 = halfStarts(timeline)[4]
      const done = run(startReplay('replay', timeline), state => state.final)
      const back = rewind(done.state, done.now)
      expect(back.final).equals(false)
      expect(back.gameOver).equals(true)
      expect(back.notice?.text).equals('Rewind to top of third')
      expect(back.queue[0].step.key).equals(timeline.steps[top3].key)
      const paused = replayReducer(back, { type: 'PAUSE', now: done.now })
      expect(paused.paused).equals(true)
      const again = run(
        replayReducer(paused, { type: 'PLAY', now: done.now }),
        state => state.final,
        done.now
      )
      expect(again.state.final).equals(true)
    })

    it('clears the home-run lights and anything drawn', async function () {
      const timeline = await timelineOf(finalGame())
      const lit = run(
        startReplay('replay', timeline),
        state => state.scoring.celebration != null
      )
      const back = rewind(lit.state, lit.now)
      expect(back.scoring.celebration ?? null).equals(null)
      expect(back.scoring.presentation).equals(null)
      expect(back.celebrationEndsAt).equals(null)
    })

    it('does nothing with no steps to go back to', async function () {
      const empty = startReplay('live', await timelineOf(scored([])))
      expect(rewind(empty, 100)).equals(empty)
    })

    it('watches a rewound live game at replay pace, then follows the scorer again', async function () {
      const actions = replayActions()
      // Three pitches into the bottom of the first.
      const cut = firstActionOfHalf(actions, 1, 'bottom') + 3
      const before = await timelineOf(scored(actions.slice(0, cut)))
      let state = startReplay('live', before)
      expect(state.follows).equals(true)
      // A newer copy makes new step objects: the rewind still finds the
      // step shown by its key.
      const same = extendTimeline(
        before,
        await scored(actions.slice(0, cut)),
        context
      )
      state = replayReducer(state, { type: 'CHANGED', change: same })
      const back = rewind(state, 1000)
      expect(back.mode).equals('replay')
      expect(back.follows).equals(true)
      expect(back.notice?.text).equals('Rewind to bottom of first')
      expect(back.queue.length).greaterThan(1)
      expect(catchingUp(back)).equals(false)
      // The scorer goes on meanwhile: the new steps queue after the rest.
      const grown = extendTimeline(
        same.timeline,
        await scored(actions.slice(0, cut + 3)),
        context
      )
      const queued = replayReducer(back, { type: 'CHANGED', change: grown })
      expect(queued.queue.length).greaterThan(back.queue.length)
      const played = run(queued, next => next.queue.length === 0, 1000)
      // Pitches at replay pace, not hurried.
      const starts = [...played.started.values()]
      const gaps = starts.slice(1).map((at, i) => at - starts[i])
      expect(Math.min(...gaps)).greaterThanOrEqual(SLOT_MS.pitch)
      expect(played.state.mode).equals('live')
      // Live again: the next step takes a live slot.
      const more = extendTimeline(
        grown.timeline,
        await scored(actions.slice(0, cut + 4)),
        context
      )
      let live = replayReducer(played.state, { type: 'CHANGED', change: more })
      let at = played.now
      let slot: number | null = null
      while (live.queue.length > 0 && at < played.now + 60000) {
        at += 100
        const queued = live.queue.length
        live = field(replayReducer(live, { type: 'TICK', now: at }))
        if (live.queue.length < queued) slot = live.slotEndsAt! - at
      }
      expect(live.mode).equals('live')
      expect(slot).lessThanOrEqual(LIVE_SLOT_MS.inPlay + LIVE_HALF_MS)
    })

    it('snaps a rewound live view to a corrected game', async function () {
      const actions = replayActions()
      const before = await timelineOf(scored(actions.slice(0, 20)))
      const back = rewind(startReplay('live', before), 1000)
      const corrected = await timelineOf(correctedGame())
      const snapped = replayReducer(back, {
        type: 'CHANGED',
        change: { kind: 'rewrite', timeline: corrected }
      })
      expect(snapped.mode).equals('live')
      expect(snapped.rewinds).equals(1)
      expect(snapped.queue).length(0)
    })
  })

  describe('a ball in play the scorer has yet to place', function () {
    const actions = replayActions()
    const inPlay = actions.findIndex(action => action.type === 'ballInPlay')
    const located = actions[inPlay] as Extract<
      (typeof actions)[number],
      { type: 'ballInPlay' }
    >
    const bare = { type: 'ballInPlay' as const, contact: 'swing' as const }
    const rest = actions.slice(inPlay + 1, inPlay + 3)
    const upTo = actions.slice(0, inPlay)

    /** Where the hit drawn is going, in the field model's ground plane. */
    function aimed(state: ReplayState): number {
      const hit = state.scoring.presentation as
        | { kind: string; arc?: { target: { x: number; z: number } } }
        | null
        | undefined
      expect(hit?.kind).equals('hit')
      return Math.atan2(hit!.arc!.target.x, hit!.arc!.target.z)
    }

    it('draws and says nothing until the scorer places it, then draws it from home plate with its result', async function () {
      const before = await timelineOf(scored(upTo))
      let state = startReplay('live', before)
      const chosen = extendTimeline(
        before,
        await scored([...upTo, bare]),
        context
      )
      state = replayReducer(state, { type: 'CHANGED', change: chosen })
      expect(state.queue).length(1)
      expect(catchingUp(state)).equals(false)
      const shownBefore = state.shown?.key
      // Twenty seconds on, nothing of the ball has been drawn or said.
      for (let at = 100; at <= 20000; at += 100)
        state = field(replayReducer(state, { type: 'TICK', now: at }))
      expect(state.queue).length(1)
      expect(state.shown?.key).equals(shownBefore)
      expect(state.scoring.presentation ?? null).equals(null)
      const placed = extendTimeline(
        chosen.timeline,
        await scored([...upTo, bare, located, ...rest]),
        context
      )
      state = replayReducer(state, { type: 'CHANGED', change: placed })
      expect(state.queue[0].actions.map(action => action.type)).deep.equals([
        'ballInPlay',
        'ballInPlay',
        'result',
        'runnerMovement'
      ])
      state = replayReducer(state, { type: 'TICK', now: 20100 })
      expect(state.shown?.key).equals(placed.timeline.steps.at(-1)!.key)
      // One hit, from the plate to where the scorer put it, not to center.
      expect(aimed(state)).closeTo(
        Math.atan2(located.location!.x, located.location!.z),
        0.05
      )
      expect(replayCard(state, WORDS).line).contains('single')
    })

    it('opens Live, or snaps, just before a ball nobody has placed yet', async function () {
      const chosen = await timelineOf(scored([...upTo, bare]))
      const opened = startReplay('live', chosen)
      const last = chosen.steps.at(-1)!
      expect(opened.queue.map(entry => entry.step.key)).deep.equals([last.key])
      expect(opened.applied[last.key]).equals(undefined)
      expect(opened.shown?.key).equals(chosen.steps.at(-2)!.key)
      expect(
        opened.scoring.session.liveData.plays.currentPlay?.result.eventType ??
          null
      ).not.equals('single')
      const placed = extendTimeline(
        chosen,
        await scored([...upTo, bare, located, ...rest]),
        context
      )
      let state = replayReducer(opened, { type: 'CHANGED', change: placed })
      state = replayReducer(state, { type: 'TICK', now: 100 })
      expect(state.shown?.key).equals(last.key)
      expect(aimed(state)).closeTo(
        Math.atan2(located.location!.x, located.location!.z),
        0.05
      )
      // A corrected game that ends on an unplaced ball snaps to just before it.
      const earlier = await timelineOf(scored(actions.slice(0, inPlay + 3)))
      const snapped = replayReducer(startReplay('live', earlier), {
        type: 'CHANGED',
        change: { kind: 'rewrite', timeline: chosen }
      })
      expect(snapped.queue.map(entry => entry.step.key)).deep.equals([last.key])
      expect(snapped.changed).equals(true)
    })

    it('plays a ball nobody placed once the game is over', async function () {
      const chosen = await timelineOf(scored([...upTo, bare]))
      let state = startReplay('live', chosen)
      expect(state.queue).length(1)
      state = run(state, () => false, 0).state
      expect(state.queue).length(1)
      state = replayReducer(state, { type: 'GAME_OVER' })
      const done = run(state, next => next.final, 400000)
      expect(done.state.final).equals(true)
      expect(done.state.queue).length(0)
      expect(done.state.shown?.key).equals(chosen.steps.at(-1)!.key)
    })

    it('follows the scorer again after a rewind once only an unplaced ball is left', async function () {
      const chosen = await timelineOf(scored([...upTo, bare]))
      const back = replayReducer(startReplay('live', chosen), {
        type: 'REWIND',
        now: 1000,
        words: { top: 'Rewind to top of %s', bottom: 'Rewind to bottom of %s' }
      })
      expect(back.mode).equals('replay')
      const caught = run(back, next => next.queue.length === 1, 1000)
      expect(caught.state.queue[0].step.key).equals(chosen.steps.at(-1)!.key)
      expect(caught.state.mode).equals('live')
    })

    it('ends the view when the game will not take a ball nobody placed', async function () {
      // A finished game with a bare ball after its end: the game refuses it.
      const finished = await timelineOf(finalGame())
      const refused = {
        ...finished,
        steps: [
          ...finished.steps,
          {
            key: '9998-0',
            atBatIndex: 9998,
            actionStart: 0,
            actions: [bare],
            kind: 'inPlay' as const
          }
        ]
      }
      for (const state of [
        replayReducer(startReplay('live', refused), { type: 'GAME_OVER' }),
        replayReducer(startReplay('replay', refused, true), {
          type: 'TICK',
          now: 0
        })
      ]) {
        const done = run(state, next => next.final, 0)
        expect(done.state.final).equals(true)
        expect(done.state.queue).length(0)
      }
    })

    it('leaves a replay of a finished game as it was', async function () {
      const chosen = await timelineOf(scored([...upTo, bare]))
      const replay = startReplay('replay', chosen)
      expect(replay.follows).equals(false)
      const played = run(replay, state => state.queue.length === 0)
      expect(played.state.shown?.key).equals(chosen.steps.at(-1)!.key)
    })
  })
})
