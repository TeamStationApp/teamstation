import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  extendTimeline,
  type ReplayTimeline,
  replayTimelineOf
} from '../../common/replay/replayTimeline'
import { allowedAngle } from '../../common/scoring/rules'
import {
  correctedGame,
  finalGame,
  inProgressGame,
  replayActions,
  replayContext,
  scored
} from '../../test/replayGameFixture'
import {
  CATCH_UP_MS,
  CELEBRATION_MS,
  HALF_MS,
  IN_PLAY_TAIL_MS,
  replayCard,
  replayIdle,
  replayReducer,
  type ReplayState,
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
    let state = startReplay('replay', timeline)
    state = replayReducer(state, { type: 'TICK', now: 100 })
    expect(state.shown?.key).equals('0-0')
    state = replayReducer(state, { type: 'PAUSE', now: 1100 })
    expect(state.paused).equals(true)
    expect(replayCard(state, WORDS).detail).equals('Paused')
    expect(replayReducer(state, { type: 'PAUSE', now: 1200 })).equals(state)
    const held = run(state, () => false, 1100)
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
    let state = replayReducer(startReplay('replay', timeline), {
      type: 'TICK',
      now: 100
    })
    state = replayReducer(state, { type: 'SPEAKING', speaking: true })
    expect(replayReducer(state, { type: 'SPEAKING', speaking: true })).equals(
      state
    )
    const held = run(state, () => false, 100)
    expect(held.state.shown?.key).equals('0-0')
    state = replayReducer(held.state, { type: 'SPEAKING', speaking: false })
    expect(
      run(state, next => next.shown?.key === '0-1', held.now).state.shown?.key
    ).equals('0-1')
  })

  it('goes to how a finished game ended when the game will not take a step, without blaming the scorer', async function () {
    const timeline = await timelineOf(finalGame())
    let state = run(
      startReplay('replay', timeline),
      next => next.shown != null
    ).state
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
    state = run(state, next => next.queue.length === 0, 1e6).state
    expect(state.mode).equals('replay')
    expect(state.changed).equals(false)
    expect(state.scoring.session.liveData.linescore.teams).deep.equals(
      timeline.end.liveData.linescore.teams
    )
    state = replayReducer(state, { type: 'TICK', now: 1e9 })
    expect(state.final).equals(true)
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
      const caught = run(state, next => next.queue.length === 0, 100)
      expect(caught.now).lessThan(9 * SLOT_MS.pitch)
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

    it('ends on the final out once the server says the game is over', async function () {
      const timeline = await timelineOf(inProgressGame())
      let state = startReplay('live', timeline)
      state = replayReducer(state, { type: 'TICK', now: 100 })
      expect(state.final).equals(false)
      state = replayReducer(state, { type: 'GAME_OVER' })
      expect(replayReducer(state, { type: 'GAME_OVER' })).equals(state)
      state = replayReducer(state, { type: 'TICK', now: 200 })
      expect(state.final).equals(true)
      const over = startReplay('live', await timelineOf(finalGame()))
      expect(over.final).equals(true)
    })
  })
})
