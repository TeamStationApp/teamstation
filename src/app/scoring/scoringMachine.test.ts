import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asRosterEntry } from '../../common/api'
import { allocatePlayer, createIdentityMap } from '../../common/scoring/rules'
import { applyAction } from '../../common/scoring/session'
import { asSessionId } from '../../common/scoring/state'
import { completeMotions, singleCorrection } from '../../test/scoringHelpers'
import { advancePlayer } from '../field/fieldModel'
import {
  addDevelopmentPlayer,
  createDevelopmentSession
} from './developmentSession'
import { fieldPlayersFor } from './fieldAdapter'
import { gameFixture } from './isUnscoredGame.test'
import { asScoringPlay } from './scoringContract'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { scoringPreferenceStore } from './scoringPreferenceStore'
import {
  baseIds,
  canSwitchBatter,
  playerRef,
  scoreboardFor
} from './scoringSelectors'
import { DevelopmentScoringSource } from './scoringSource'
import { CORRECTION_WINDOW_MS, type ScoringState } from './scoringTypes'

const roster = [
  asRosterEntry({
    userId: 102,
    shortName: 'Jordan K.',
    jersey: '00',
    positions: ['P'],
    isPlayer: true,
    role: 'member',
    bats: 'switch',
    throws: 'left'
  })
]
function initial(): ScoringState {
  return initialScoringState(createDevelopmentSession(gameFixture, roster, []))
}
function pitch(
  state: ScoringState,
  kind: 'ball' | 'called' | 'swing' | 'foul',
  times = 1
): ScoringState {
  let next = state
  for (let i = 0; i < times; i++)
    next = scoringReducer(next, { type: 'PITCH', kind })
  return completeMotions(next)
}
function frozen<T>(value: T): T {
  if (value != null && typeof value === 'object') {
    Object.freeze(value)
    for (const child of Object.values(value)) frozen(child)
  }
  return value
}
describe('local scoring sessions', function () {
  it('retains real teams, exact ids, string jerseys, preferences and deterministic fallback players', function () {
    const session = initial().session
    expect(session).deep.equals(initial().session)
    expect(session.gameData.teams).deep.equals({
      away: { id: 'away', name: 'Owls', logoUrl: null },
      home: { id: 'home', name: 'Hawks', logoUrl: null }
    })
    expect(session.gameData.players[1]).includes({
      userId: 102,
      fullName: 'Jordan K.',
      jersey: '00',
      bats: 'switch'
    })
    expect(session.liveData.boxscore.teams.away.defense.P).equals(1)
    expect(session.liveData.boxscore.teams.away.battingOrder).has.length(9)
    expect(baseIds(session)).deep.equals([null, null, null])
    expect(scoreboardFor(session)).includes({
      awayTeam: 'Owls',
      homeTeam: 'Hawks',
      pitchCount: 0,
      balls: 0,
      strikes: 0,
      outs: 0
    })
    expect(session.liveData.plays.currentPlay?.matchup.batSide.code).equals('R')
    const ignored = asRosterEntry({
      ...roster[0],
      userId: 104,
      isPlayer: false
    })
    expect(
      createDevelopmentSession(gameFixture, [ignored], []).gameData.players[1]
        .local
    ).equals(true)
    const local = addDevelopmentPlayer(session, 'away', '  Casey  ')
    expect(session.gameData.players[local]).includes({
      fullName: 'Casey',
      userId: null,
      jersey: '',
      local: true
    })
  })
  it('allocates local identities without parsing or conflating persisted ids', function () {
    const map = createIdentityMap()
    const ids = ['123', 123, 'usr_one', null, null].map(id =>
      allocatePlayer(map, id)
    )
    expect(new Set(ids).size).equals(5)
    expect(allocatePlayer(map, '123')).equals(ids[0])
    expect(map.sessionToSource[ids[0]]).equals('123')
    expect(map.sessionToSource[ids[1]]).equals(123)
    map.nextId = ids[0]
    expect(allocatePlayer(map, null)).equals(6)
    map.nextId = Number.MAX_SAFE_INTEGER + 1
    expect(() => allocatePlayer(map, null)).throws()
    for (const invalid of [-1, 1.5, Infinity, '2', Number.MAX_SAFE_INTEGER + 1])
      expect(() => asSessionId(invalid)).throws()
    expect(() =>
      createDevelopmentSession(gameFixture, [roster[0], roster[0]], [])
    ).throws('more than once')
  })
  it('counts every pitch, caps fouls, and rewinds every accepted pitch', function () {
    const original = frozen(initial())
    let state = pitch(original, 'ball')
    state = pitch(state, 'called')
    state = pitch(state, 'foul', 4)
    expect(scoreboardFor(state.session)).includes({
      balls: 1,
      strikes: 2,
      pitchCount: 6
    })
    expect(state.session.liveData.plays.currentPlay?.playEvents).has.length(6)
    asScoringPlay(state.session.liveData.plays.currentPlay)
    for (let index = 0; index < 6; index++)
      state = scoringReducer(state, { type: 'UNDO' })
    expect(state.session).deep.equals(original.session)
    expect(scoringReducer(state, { type: 'UNDO' })).equals(state)
  })
  it('permits switch hitting only before a pitch and mirrors the owned render copy', function () {
    let state = initial()
    expect(canSwitchBatter(state.session)).equals(true)
    state = scoringReducer(state, { type: 'SWITCH_SIDE', side: 'L' })
    expect(
      state.session.liveData.plays.currentPlay?.matchup.batSide.code
    ).equals('L')
    expect(scoringReducer(state, { type: 'SWITCH_SIDE', side: 'L' })).equals(
      state
    )
    const players = fieldPlayersFor(frozen(state.session))
    const batter = players.find(player => player.batting === true)
    expect(batter?.position.x).equals(4)
    expect(batter?.jersey).equals('00')
    if (batter != null) {
      batter.target.x = 25
      advancePlayer(batter, 1)
    }
    expect(state.session.liveData.linescore.offense.batter?.id).equals(1)
    state = pitch(state, 'foul')
    expect(canSwitchBatter(state.session)).equals(false)
    expect(scoringReducer(state, { type: 'SWITCH_SIDE', side: 'R' })).equals(
      state
    )
    const left = createDevelopmentSession(
      gameFixture,
      [{ ...roster[0], bats: 'left', jersey: null }],
      []
    )
    expect(left.liveData.plays.currentPlay?.matchup.batSide.code).equals('L')
    expect(
      fieldPlayersFor(left).find(player => player.batting === true)?.jersey
    ).equals('')
  })
  it('walks forced runners, scores awarded runs safely and completes the appearance', function () {
    for (let mask = 0; mask < 8; mask++) {
      let state = initial()
      const offense = state.session.liveData.linescore.offense
      for (const [index, key] of (
        ['first', 'second', 'third'] as const
      ).entries())
        offense[key] =
          (mask & (1 << index)) !== 0
            ? playerRef(state.session, index + 2)
            : null
      state = pitch(state, 'ball', 4)
      const bases = baseIds(state.session)
      expect(bases[0]).equals(1)
      expect(bases.filter(id => id != null)).has.length(
        new Set(bases.filter(id => id != null)).size
      )
      expect(state.session.liveData.linescore.teams.away.runs).equals(
        mask === 7 ? 1 : 0
      )
      expect(state.session.homeQueue).has.length(0)
      expect(state.phase).oneOf(['ready', 'awaitingBatter'])
      const closed = scoringReducer(state, { type: 'CLOSE_PLAY' })
      expect(closed).equals(state)
      expect(closed.session.liveData.plays.allPlays).has.length(1)
      expect(
        fieldPlayersFor(state.session).filter(player => player.playerId === 1)
      ).has.length(1)
    }
  })
  it('accepts runner release decisions only for this generation and the next base', function () {
    const state = singleCorrection(initial())
    const drop = {
      type: 'RUNNER_DROP' as const,
      id: 1,
      to: 2,
      decision: 'safe' as const,
      generation: state.generation
    }
    expect(
      scoringReducer(state, { ...drop, generation: state.generation + 1 })
    ).equals(state)
    expect(scoringReducer(state, { ...drop, to: 3 })).equals(state)
    expect(scoringReducer(state, { ...drop, id: 9876 })).equals(state)
    const moved = scoringReducer(state, drop)
    expect(moved).not.equals(state)
    expect(moved.session.liveData.linescore.offense.second?.id).equals(1)
  })

  it('retreats an auto-advanced unforced runner on a single without Safe/Out', function () {
    let session = createDevelopmentSession(gameFixture, roster, [])
    for (const action of [
      { type: 'ballInPlay' as const, contact: 'swing' as const },
      { type: 'result' as const, eventType: 'single' as const },
      { type: 'gameFlow' as const, kind: 'closePlay' as const },
      { type: 'baseRunning' as const, kind: 'steal' as const, runner: 1 },
      { type: 'ballInPlay' as const, contact: 'swing' as const },
      { type: 'result' as const, eventType: 'single' as const }
    ])
      session = applyAction(session, action).state
    // Resume into the correction window with motions already settled.
    const state: ScoringState = {
      ...initialScoringState(session),
      phase: 'correctionWindow',
      presentation: null,
      motions: [],
      correctionWindow: {
        remainingMs: 10000,
        revision: session.meta.sequence
      }
    }
    expect(baseIds(state.session)).deep.equals([2, null, 1])
    const retreated = scoringReducer(state, {
      type: 'RUNNER_DROP',
      id: 1,
      to: 2,
      decision: 'safe',
      generation: state.generation
    })
    expect(baseIds(retreated.session)).deep.equals([2, 1, null])
    expect(
      retreated.session.liveData.plays
        .currentPlay!.runners.filter(r => r.details.movementReason === 'Single')
        .map(r => r.details.runner.id)
    ).deep.equals([2])
  })

  it('puts a hit-offer re-take out instead of forcing safe', function () {
    let state = initialScoringState(
      createDevelopmentSession(gameFixture, roster, [])
    )
    for (const [base, id] of [
      ['second', 3],
      ['third', 4]
    ] as const)
      state.session.liveData.linescore.offense[base] = playerRef(
        state.session,
        id
      )
    state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Single' })
    state = scoringReducer(state, {
      type: 'FIELDER',
      id: 10,
      point: { x: 10, z: -40 },
      generation: state.generation
    })
    state = completeMotions(
      scoringReducer(state, {
        type: 'TRAJECTORY',
        angle: 25,
        generation: state.generation
      })
    )
    state = completeMotions(
      scoringReducer(state, {
        type: 'RUNNER_DROP',
        id: 3,
        to: 2,
        decision: 'safe',
        generation: state.generation
      })
    )
    expect(baseIds(state.session)).deep.equals([1, 3, null])
    const outed = scoringReducer(state, {
      type: 'RUNNER_DROP',
      id: 3,
      to: 3,
      decision: 'out',
      generation: state.generation
    })
    expect(outed.phase).equals('chooseDefender')
    expect(outed.runnerAction?.decision).equals('out')
    expect(baseIds(outed.session)).deep.equals([1, 3, null])
  })

  it('waits out trailer retreat motion before homeDecision and allows re-take', function () {
    // Second and third occupied (unforced trailer on a single).
    let state = initialScoringState(
      createDevelopmentSession(gameFixture, roster, [])
    )
    for (const [base, id] of [
      ['second', 3],
      ['third', 4]
    ] as const)
      state.session.liveData.linescore.offense[base] = playerRef(
        state.session,
        id
      )
    state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Single' })
    state = scoringReducer(state, {
      type: 'FIELDER',
      id: 10,
      point: { x: 10, z: -40 },
      generation: state.generation
    })
    state = completeMotions(
      scoringReducer(state, {
        type: 'TRAJECTORY',
        angle: 25,
        generation: state.generation
      })
    )
    expect(state.phase).equals('homeDecision')
    expect(state.session.homeQueue).deep.equals([4])
    expect(baseIds(state.session)).deep.equals([1, null, 3])
    const retreated = scoringReducer(state, {
      type: 'RUNNER_DROP',
      id: 3,
      to: 2,
      decision: 'safe',
      generation: state.generation
    })
    expect(baseIds(retreated.session)).deep.equals([1, 3, null])
    expect(retreated.phase).equals('runnerMovement')
    expect(retreated.motions.some(m => !m.complete)).equals(true)
    expect(
      scoringReducer(retreated, { type: 'HOME', decision: 'safe' })
    ).equals(retreated)
    const settled = completeMotions(retreated)
    expect(settled.phase).equals('homeDecision')
    const retaken = scoringReducer(settled, {
      type: 'RUNNER_DROP',
      id: 3,
      to: 3,
      decision: 'safe',
      generation: settled.generation
    })
    expect(baseIds(retaken.session)).deep.equals([1, null, 3])
    expect(completeMotions(retaken).phase).equals('homeDecision')
  })
  it('guards Done by play identity, generation and timer revision and races expiry once', function () {
    const state = singleCorrection(initial())
    const done = {
      type: 'CLOSE_PLAY' as const,
      generation: state.generation,
      sequence: state.session.meta.sequence,
      revision: state.correctionWindow!.revision
    }
    for (const key of ['generation', 'sequence', 'revision'] as const)
      expect(scoringReducer(state, { ...done, [key]: done[key] + 1 })).equals(
        state
      )
    const closed = scoringReducer(state, done)
    expect(closed.session.liveData.plays.allPlays).has.length(1)
    expect(closed.past).deep.equals(state.past)
    expect(scoringReducer(closed, done)).equals(closed)
    expect(
      scoringReducer(closed, {
        type: 'TIMER_TICK',
        generation: done.generation,
        revision: done.revision,
        elapsedMs: CORRECTION_WINDOW_MS
      })
    ).equals(closed)
    const expired = scoringReducer(state, {
      type: 'TIMER_TICK',
      generation: done.generation,
      revision: done.revision,
      elapsedMs: CORRECTION_WINDOW_MS
    })
    expect(scoringReducer(expired, done)).equals(expired)
    expect(
      scoringReducer(closed, { type: 'UNDO' }).session.liveData.linescore.balls
    ).equals(0)
    expect(
      scoringReducer(
        { ...state, session: { ...state.session, homeQueue: [1] } },
        done
      ).phase
    ).equals('correctionWindow')
    const moving = {
      ...state,
      motions: [
        {
          id: 'pending',
          generation: state.generation,
          playerId: 1,
          waypoints: [],
          complete: false
        }
      ]
    }
    expect(scoringReducer(moving, done)).equals(moving)
  })
  it('closes once, advances a batter once, and turns over after the third strikeout', function () {
    let state = initial()
    for (let out = 0; out < 3; out++) {
      state = pitch(state, out % 2 === 0 ? 'called' : 'swing', 3)
      expect(state.phase).equals('ready')
      expect(state.correctionWindow).equals(null)
      state = scoringReducer(state, { type: 'CLOSE_PLAY' })
      expect(scoringReducer(state, { type: 'CLOSE_PLAY' })).equals(state)
    }
    expect(state.session.liveData.linescore).includes({
      isTopInning: false,
      balls: 0,
      strikes: 0,
      outs: 0
    })
    expect(state.session.liveData.plays.allPlays).has.length(3)
    expect(state.session.liveData.boxscore.teams.away.battingIndex).equals(3)
    state = scoringReducer(state, { type: 'UNDO' })
    expect(state.session.liveData.linescore).includes({
      isTopInning: true,
      strikes: 2,
      outs: 2
    })
    for (const play of state.session.liveData.plays.allPlays)
      asScoringPlay(play)
    state = scoringReducer(initial(), { type: 'END_HALF' })
    state = scoringReducer(state, { type: 'END_HALF' })
    expect(state.session.liveData.linescore.currentInningOrdinal).equals('2nd')
    expect(
      scoringReducer(state, { type: 'UNDO' }).session.liveData.linescore
        .inningState
    ).equals('Bottom')
  })
  it('waits when the due batter is on base, keeps the pointer, and renders no duplicate batter', function () {
    let state = initial()
    state.session.liveData.boxscore.teams.away.battingOrder = [1]
    state = pitch(state, 'ball', 4)
    state = scoringReducer(state, { type: 'CLOSE_PLAY' })
    expect(state.phase).equals('awaitingBatter')
    expect(state.session.awaitingBatter?.dueIndex).equals(0)
    expect(state.session.liveData.linescore.offense.batter).equals(null)
    expect(state.session.liveData.plays.currentPlay).equals(null)
    expect(
      fieldPlayersFor(state.session).filter(player => player.playerId === 1)
    ).has.length(1)
    expect(canSwitchBatter(state.session)).equals(false)
    expect(scoringReducer(state, { type: 'PITCH', kind: 'ball' })).equals(state)
    expect(initialScoringState(state.session).phase).equals('awaitingBatter')
    expect(
      scoringReducer(state, { type: 'UNDO' }).session.liveData.linescore.balls
    ).equals(3)
    const broken = initial().session
    expect(() => playerRef(broken, 900)).throws('Unknown')
  })
  it('keeps a local game in memory and picks it up again without any transport', async function () {
    const source = new DevelopmentScoringSource()
    const game = await source.open(gameFixture, roster, [])
    game.apply({ type: 'pitch', call: 'B' })
    await game.flush()
    expect(game.pending).equals(0)
    const again = await source.open(gameFixture, roster, [])
    expect(again.state.liveData.linescore.balls).equals(1)
    expect(again.state.gameData.players[1].userId).equals(102)
  })
  it('stores per-user help, bounds counts, handles unavailable storage and resets', async function () {
    const items = new Map<string, string>()
    const preferences = scoringPreferenceStore({
      getItem: async key => items.get(key) ?? null,
      setItem: async (key, value) => {
        items.set(key, value)
      }
    })
    expect(await preferences.read('one')).deep.equals({ help: true, shown: 0 })
    await preferences.write('one', { help: false, shown: 3 })
    expect(await preferences.read('one')).deep.equals({ help: false, shown: 3 })
    expect(await preferences.read('two')).deep.equals({ help: true, shown: 0 })
    await preferences.write('one', { help: true, shown: 0 })
    expect((await preferences.read('one')).shown).equals(0)
    for (const bad of [
      '{',
      'null',
      '{}',
      '{"help":true,"shown":-4}',
      '{"help":true,"shown":"bad"}'
    ]) {
      items.set('gamestation:scoring:one:switch-hitter', bad)
      expect((await preferences.read('one')).shown).equals(0)
    }
    const unavailable = scoringPreferenceStore({
      getItem: async () => {
        throw new Error('denied')
      },
      setItem: async () => {
        throw new Error('denied')
      }
    })
    expect(await unavailable.read('one')).deep.equals({ help: true, shown: 0 })
    await unavailable.write('one', { help: false, shown: 3 })
    // A dictation model is kept only when it is one this app knows.
    await preferences.write('one', {
      help: true,
      shown: 0,
      dictationModel: 'gpt-6-sol'
    })
    expect((await preferences.read('one')).dictationModel).equals('gpt-6-sol')
    items.set(
      'gamestation:scoring:one:switch-hitter',
      '{"help":true,"shown":0,"dictationModel":"gpt-4"}'
    )
    expect(await preferences.read('one')).deep.equals({ help: true, shown: 0 })
  })
})

describe('the screen and the actions it logs', function () {
  it('makes the same game from the taps as from the actions they logged', function () {
    let state = initial()
    const tap = (event: Parameters<typeof scoringReducer>[1]): void => {
      state = completeMotions(scoringReducer(state, event))
    }
    tap({ type: 'PITCH', kind: 'ball' })
    tap({ type: 'PITCH', kind: 'swing' })
    tap({ type: 'OUTCOME', outcome: 'Double' })
    tap({ type: 'FIELDER', id: 16, point: { x: -40, z: -70 }, generation: 0 })
    tap({ type: 'TRAJECTORY', angle: 18, generation: 0 })
    tap({ type: 'CLOSE_PLAY', generation: state.generation })
    tap({ type: 'PITCH', kind: 'ball' })
    tap({ type: 'PITCH', kind: 'ball' })
    tap({ type: 'PITCH', kind: 'ball' })
    tap({ type: 'PITCH', kind: 'ball' })
    expect(state.session.liveData.plays.allPlays).length(2)
    let replayed = initial().session
    for (const action of state.log) {
      const applied = applyAction(replayed, action)
      expect(applied.problems, JSON.stringify(action)).deep.equals([])
      replayed = applied.state
    }
    expect(replayed).deep.equals(state.session)
  })
})

describe('a decided play picked up by the screen', function () {
  function decided(): ScoringState {
    let session = createDevelopmentSession(gameFixture, roster, [])
    for (const action of [
      { type: 'ballInPlay', contact: 'swing' },
      { type: 'result', eventType: 'single' }
    ] as const)
      session = applyAction(session, action).state
    return initialScoringState(session)
  }

  it('waits for the scorer with no countdown, and closes on Done', function () {
    const state = decided()
    expect(state.phase).equals('correctionWindow')
    expect(state.correctionWindow).equals(null)
    const ticked = scoringReducer(state, {
      type: 'TIMER_TICK',
      generation: state.generation,
      revision: 0,
      elapsedMs: 60000
    })
    expect(ticked).equals(state)
    const closed = scoringReducer(state, {
      type: 'CLOSE_PLAY',
      generation: state.generation
    })
    expect(closed.phase).equals('ready')
    expect(closed.log.at(-1)).deep.equals({
      type: 'gameFlow',
      kind: 'closePlay'
    })
  })

  it('stays as it is when read-only, and does not throw', function () {
    const state = decided()
    const refused = scoringReducer(state, {
      type: 'RESET',
      session: state.session,
      log: state.log,
      readOnly: true
    })
    const closed = scoringReducer(refused, {
      type: 'CLOSE_PLAY',
      generation: refused.generation
    })
    expect(closed.phase).equals('correctionWindow')
    expect(closed.log).deep.equals(refused.log)
  })
})

describe('a read-only screen', function () {
  it('changes the game for nothing it is sent, and undoes nothing', function () {
    const scored = pitch(initial(), 'ball')
    const refused = scoringReducer(scored, {
      type: 'RESET',
      session: scored.session,
      log: scored.log,
      readOnly: true
    })
    expect(refused.readOnly).equals(true)
    const pitched = pitch({ ...refused, past: scored.past }, 'called')
    expect(pitched.log).deep.equals(scored.log)
    expect(pitched.session).deep.equals(scored.session)
    for (const event of [
      { type: 'END_HALF' },
      { type: 'END_GAME' },
      { type: 'OUTCOME', outcome: 'Single', contactKind: 'swing' },
      { type: 'UNDO' }
    ] as const) {
      const next = scoringReducer({ ...refused, past: scored.past }, event)
      expect(next.log, event.type).deep.equals(scored.log)
      expect(next.session, event.type).deep.equals(scored.session)
    }
  })
})

describe('the play animation setting', function () {
  it('keeps the setting with the other preferences and turns animation on and off', async function () {
    const items = new Map<string, string>()
    const preferences = scoringPreferenceStore({
      getItem: async key => items.get(key) ?? null,
      setItem: async (key, value) => {
        items.set(key, value)
      }
    })
    await preferences.write('one', { help: true, shown: 0, animations: false })
    expect(await preferences.read('one')).deep.equals({
      help: true,
      shown: 0,
      animations: false
    })
    const state = initial()
    const off = scoringReducer(state, { type: 'PRESENTATION', enabled: false })
    expect(off.presentationEnabled).equals(false)
    expect(
      scoringReducer(off, { type: 'PRESENTATION', enabled: false })
    ).equals(off)
    const pitched = scoringReducer(off, { type: 'PITCH', kind: 'ball' })
    expect(pitched.presentation).equals(null)
    expect(
      scoringReducer(
        scoringReducer(off, { type: 'PRESENTATION', enabled: true }),
        { type: 'PITCH', kind: 'ball' }
      ).presentation?.kind
    ).equals('pitch')
  })

  it('resumes a game picked up in the middle of a play at that play’s step', function () {
    let state = initial()
    state = scoringReducer(state, {
      type: 'MORE',
      input: { action: 'Hit by Pitch' }
    })
    state = completeMotions(state)
    let session = state.session
    session = applyAction(session, { type: 'pitch', call: 'B' }).state
    session = applyAction(session, {
      type: 'result',
      eventType: 'single'
    }).state
    const resumed = initialScoringState(session, false)
    expect(resumed.phase).equals('correctionWindow')
    expect(resumed.pendingPlay?.outcome).equals('Single')
  })
})
