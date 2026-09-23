import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asRosterEntry } from '../../common/api'
import { advancePlayer } from '../field/fieldModel'
import { asSessionId } from './contracts/estimatedGumbo'
import {
  addDevelopmentPlayer,
  createDevelopmentSession
} from './developmentSession'
import { fieldPlayersFor } from './fieldAdapter'
import { gameFixture } from './isUnscoredGame.test'
import { allocatePlayer, createIdentityMap } from './playerIdentity'
import { asScoringPlay } from './scoringContract'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { scoringPreferenceStore } from './scoringPreferenceStore'
import {
  baseIds,
  canSwitchBatter,
  playerRef,
  scoreboardFor,
  startAppearance
} from './scoringSelectors'
import { DevelopmentScoringStateSource } from './scoringStateSource'
import type { ScoringState } from './scoringTypes'

const roster = [
  asRosterEntry({
    userId: 'usr_real-player',
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
  return next
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
      away: { id: 'away', name: 'Owls' },
      home: { id: 'home', name: 'Hawks' }
    })
    expect(session.gameData.players[1]).includes({
      sourceUserId: 'usr_real-player',
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
      userId: 'coach',
      isPlayer: false
    })
    expect(
      createDevelopmentSession(gameFixture, [ignored], []).gameData.players[1]
        .local
    ).equals(true)
    const local = addDevelopmentPlayer(session, 'away', '  Casey  ')
    expect(session.gameData.players[local]).includes({
      fullName: 'Casey',
      sourceUserId: null,
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
  it('walks only forced runners and leaves home runs undecided until the scorer acts', function () {
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
      expect(state.session.liveData.linescore.teams.away.runs).equals(0)
      expect(state.homeQueue).has.length(mask === 7 ? 1 : 0)
      expect(state.phase).equals(
        mask === 7 ? 'homeDecision' : 'correctionWindow'
      )
      const closed = scoringReducer(state, { type: 'CLOSE_PLAY' })
      if (mask === 7) expect(closed).equals(state)
      else expect(closed.session.liveData.plays.allPlays).has.length(1)
      expect(
        fieldPlayersFor(state.session).filter(player => player.playerId === 1)
      ).has.length(1)
    }
  })
  it('closes once, advances a batter once, and turns over after the third strikeout', function () {
    let state = initial()
    for (let out = 0; out < 3; out++) {
      state = pitch(state, out % 2 === 0 ? 'called' : 'swing', 3)
      expect(state.phase).equals('correctionWindow')
      expect(scoringReducer(state, { type: 'PITCH', kind: 'ball' })).equals(
        state
      )
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
    expect(state.awaitingBatter?.dueIndex).equals(0)
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
    broken.liveData.boxscore.teams.away.battingOrder = []
    expect(() => startAppearance(broken)).throws('lineup')
    expect(() => playerRef(broken, 900)).throws('Unknown')
  })
  it('loads and saves local state without invoking any transport', async function () {
    const source = new DevelopmentScoringStateSource()
    const session = await source.load(gameFixture, roster, [])
    await source.save(session)
    expect(session.meta.source).equals('local-development')
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
  })
})
