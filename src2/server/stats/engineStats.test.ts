import { expect } from 'chai'
import { describe, it } from 'mocha'

import { DID_BY_TYPE } from '../../common/describePlay'
import {
  MLB_EVENT_TYPES,
  STORED_EVENT_TYPES
} from '../../common/gumbo/reference'
import { gumboViolations } from '../../common/gumbo/validate'
import {
  eventTypeName,
  GUMBO_EXTENSION_EVENT_TYPES
} from '../../common/gumboEventTypes'
import type { GumboPlay } from '../../common/gumboPlay'
import { OUTCOME_BY_TYPE } from '../../common/outcomes'
import {
  type PitchCall,
  PRODUCED_EVENT_TYPES,
  type ScoringAction
} from '../../common/scoring/actions'
import { applyAction } from '../../common/scoring/apply'
import { battingCounts } from '../../common/scoring/credits'
import {
  HIGHLIGHT_CREDITED,
  storedEventType
} from '../../common/scoring/document'
import { foldCurrentPlay, foldPlay } from '../../common/scoring/gumbo'
import { EVENT_CLASS } from '../../common/scoring/hitsAndErrors'
import { freshGame, newSetup } from '../../common/scoring/lineup'
import { nextDecision } from '../../common/scoring/rules'
import { type GameState, setupOf } from '../../common/scoring/state'
import { after, F, TEAMS } from '../../test/scoringGames'
import {
  eventTypeCounts,
  gameStatLines,
  type PlayerGameLine
} from './gumboStats'

/**
 * A game scored in GameStation builds stat lines: the engine's plays, folded
 * into the documents the server stores, go straight into the stats builder.
 * The visitors are users 101-109 batting in order; the home pitcher is 201.
 */
const AWAY = Array.from({ length: 9 }, (_, i) => 101 + i)
const HOME = Array.from({ length: 9 }, (_, i) => 201 + i)
const PITCHER = HOME[0]
const teams = { homeTeamId: TEAMS.home.id, awayTeamId: TEAMS.away.id }
const known = new Set([...AWAY, ...HOME])

function start(): GameState {
  return freshGame(
    'g1',
    TEAMS,
    newSetup(TEAMS, {
      away: AWAY.map((userId, i) => ({ userId, shortName: `Away ${i + 1}` })),
      home: HOME.map((userId, i) => ({ userId, shortName: `Home ${i + 1}` }))
    })
  )
}

/** Scores the actions and returns every completed play as it is stored. */
function scored(...actions: ScoringAction[]): GumboPlay[] {
  const state = after(start(), ...actions)
  return state.liveData.plays.allPlays.map(play =>
    foldPlay(state, play, { setupBefore: setupOf(state), actions })
  )
}

function lines(plays: GumboPlay[]): Map<number, PlayerGameLine> {
  const result = gameStatLines(plays, teams, known)
  if (result.kind !== 'lines') throw new Error(result.detail)
  return new Map(result.lines.map(line => [line.userId, line]))
}

const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
const ball: ScoringAction = { type: 'pitch', call: 'B' }
const strike: ScoringAction = { type: 'pitch', call: 'C' }
const strikeout = [strike, strike, strike, close]
const hit = (eventType: 'single' | 'double'): ScoringAction[] => [
  { type: 'ballInPlay', contact: 'swing', fielder: F.CF },
  { type: 'result', eventType }
]
/** Session id n is the nth visitor; runner 1 is user 101. */
const home = (runner: number, reason?: 'Wild Pitch'): ScoringAction =>
  reason == null
    ? { type: 'runnerMovement', runner, to: 'home' }
    : {
        type: 'batteryEvent',
        kind: 'wild_pitch',
        advances: [{ runner, to: 'home' }]
      }

describe('a game scored in GameStation builds stats (U10)', function () {
  it('a single, a run on a double, and a strikeout', function () {
    const plays = scored(
      ...hit('single'),
      close,
      ...hit('double'),
      home(1),
      close,
      ...strikeout
    )
    const got = lines(plays)
    expect(got.get(101)).includes({ pa: 1, ab: 1, h: 1, singles: 1, r: 1 })
    expect(got.get(102)).includes({ pa: 1, doubles: 1, rbi: 1, r: 0 })
    expect(got.get(103)).includes({ pa: 1, ab: 1, k: 1 })
    expect(got.get(PITCHER)).includes({
      pitch_bf: 3,
      pitch_outs: 1,
      pitch_h: 2,
      pitch_k: 1,
      pitch_r: 1,
      pitch_er: 1
    })
  })

  it('an error, then a run: unearned, and still batted in', function () {
    const plays = scored(
      { type: 'ballInPlay', contact: 'swing', fielder: F.SS },
      { type: 'result', eventType: 'field_error' },
      { type: 'fieldingPlay', fielders: [F.SS], error: F.SS },
      close,
      ...hit('double'),
      home(1),
      close
    )
    const got = lines(plays)
    expect(got.get(101)).includes({ pa: 1, ab: 1, h: 0, r: 1 })
    expect(got.get(102)).includes({ doubles: 1, rbi: 1 })
    expect(got.get(PITCHER)).includes({ pitch_r: 1, pitch_er: 0, pitch_h: 1 })
  })

  it('a walk, a steal, then wild pitches home: a stolen base and an earned run nobody batted in', function () {
    const plays = scored(
      ball,
      ball,
      ball,
      ball,
      close,
      { type: 'baseRunning', kind: 'steal', runner: 1 },
      ball,
      {
        type: 'batteryEvent',
        kind: 'wild_pitch',
        advances: [{ runner: 1, to: '3B' }]
      },
      ball,
      home(1, 'Wild Pitch'),
      ...strikeout
    )
    const got = lines(plays)
    expect(got.get(101)).includes({ pa: 1, ab: 0, bb: 1, sb: 1, r: 1 })
    expect(got.get(102)).includes({ pa: 1, ab: 1, k: 1, rbi: 0 })
    expect(got.get(PITCHER)).includes({
      pitch_bb: 1,
      pitch_k: 1,
      pitch_r: 1,
      pitch_er: 1
    })
  })
  it('a runner caught stealing before a pitching change is an out for the pitcher he was caught off', function () {
    // The shortstop, user 205, takes the mound in the middle of the second
    // plate appearance, after the runner is out.
    const toMound = (player: number, position: 'P' | 'SS'): ScoringAction => ({
      type: 'lineup',
      kind: 'position',
      side: 'home',
      position,
      player
    })
    const plays = scored(
      ...hit('single'),
      close,
      ball,
      {
        type: 'baseRunning',
        kind: 'caught_stealing',
        runner: 1,
        to: '2B',
        fielders: [F.C, F.SS]
      },
      toMound(F.SS, 'P'),
      toMound(F.P, 'SS'),
      ...strikeout,
      ...strikeout
    )
    const got = lines(plays)
    expect(got.get(PITCHER)).includes({ pitch_bf: 1, pitch_outs: 1 })
    expect(got.get(HOME[4])).includes({
      pitch_bf: 2,
      pitch_outs: 2,
      pitch_k: 2
    })
  })

  it('a pitching change by the side at bat is written, and pitches, when it takes the field', function () {
    // After the first strikeout the visitors swap their pitcher and
    // shortstop with one roster change, as Set Defense sends it.
    const first = after(start(), ...strikeout)
    const setup = setupOf(first)
    const defense = setup.sides.away.defense
    ;[defense.P, defense.SS] = [defense.SS, defense.P]
    const plays = scored(
      ...strikeout,
      { type: 'lineup', kind: 'roster', setup },
      ...strikeout,
      ...strikeout,
      ...strikeout
    )
    const changes = plays.map(play =>
      (play.playEvents ?? [])
        .filter(event => event.isSubstitution === true)
        .map(event => `${event.index} ${String(event.details.eventType)}`)
    )
    expect(changes).deep.equals([
      [],
      [],
      [],
      ['0 pitching_substitution', '1 defensive_switch']
    ])
    const got = lines(plays)
    expect(got.get(PITCHER)).includes({ pitch_bf: 3, pitch_outs: 3 })
    // The shortstop the visitors put on the mound bats fifth: session id 5.
    expect(setup.sides.away.defense.P).equals(5)
    expect(got.get(AWAY[4])).includes({ pitch_bf: 1, pitch_outs: 1 })
  })

  it('a relief pitcher who leaves inside the plate appearance he entered in keeps his outs', function () {
    // Two home relievers on the bench, users 210 and 211: session ids 19
    // and 20. 210 relieves in the middle of the second plate appearance,
    // the runner is caught stealing off him, and 211 relieves him before
    // the batter is out (an injury, rule 5.10(g)).
    const setup = newSetup(TEAMS, {
      away: AWAY.map((userId, i) => ({ userId, shortName: `Away ${i + 1}` })),
      home: [...HOME, 210, 211].map((userId, i) => ({
        userId,
        shortName: `Home ${i + 1}`
      }))
    })
    setup.sides.home.battingOrder = setup.sides.home.battingOrder.slice(0, 9)
    const reliever = (player: number, replaces: number): ScoringAction => ({
      type: 'lineup',
      kind: 'substitute',
      side: 'home',
      player,
      replaces
    })
    const actions: ScoringAction[] = [
      ...hit('single'),
      close,
      ball,
      reliever(19, F.P),
      ball,
      {
        type: 'baseRunning',
        kind: 'caught_stealing',
        runner: 1,
        to: '2B',
        fielders: [F.C, F.SS]
      },
      reliever(20, 19),
      ...strikeout,
      ...strikeout
    ]
    const state = after(freshGame('g1', TEAMS, setup), ...actions)
    const result = gameStatLines(
      state.liveData.plays.allPlays.map(play =>
        foldPlay(state, play, { setupBefore: setupOf(state), actions })
      ),
      teams,
      new Set([...known, 210, 211])
    )
    if (result.kind !== 'lines') throw new Error(result.detail)
    const got = new Map(result.lines.map(line => [line.userId, line]))
    expect(got.get(PITCHER)).includes({ pitch_bf: 1, pitch_outs: 0 })
    expect(got.get(210)).includes({ pitch_bf: 0, pitch_outs: 1 })
    expect(got.get(211)).includes({ pitch_bf: 2, pitch_outs: 2 })
  })

  it('a pitcher the side at bat moved to the mound and replaced is never announced, and pitches nothing', function () {
    // Bench pitcher 210 is session id 19. Batting in the bottom of the
    // first, the home side swaps its pitcher and shortstop (Home 5 to the
    // mound), then brings 210 in for Home 5 while Home 2 bats.
    const setup = newSetup(TEAMS, {
      away: AWAY.map((userId, i) => ({ userId, shortName: `Away ${i + 1}` })),
      home: [...HOME, 210].map((userId, i) => ({
        userId,
        shortName: `Home ${i + 1}`
      }))
    })
    setup.sides.home.battingOrder = setup.sides.home.battingOrder.slice(0, 9)
    const batting = after(
      freshGame('g1', TEAMS, setup),
      ...strikeout,
      ...strikeout,
      ...strikeout,
      ball
    )
    const swapped = setupOf(batting)
    const defense = swapped.sides.home.defense
    ;[defense.P, defense.SS] = [defense.SS, defense.P]
    const actions: ScoringAction[] = [
      { type: 'lineup', kind: 'roster', setup: swapped },
      ...strikeout,
      {
        type: 'lineup',
        kind: 'substitute',
        side: 'home',
        player: 19,
        replaces: F.SS
      },
      ...strikeout,
      ...strikeout,
      ...strikeout,
      ...strikeout,
      ...strikeout
    ]
    const state = after(batting, ...actions)
    const plays = state.liveData.plays.allPlays.map(play =>
      foldPlay(state, play, { setupBefore: setupOf(state), actions })
    )
    const changes = plays.map(play =>
      (play.playEvents ?? [])
        .filter(event => event.isSubstitution === true)
        .map(
          event =>
            `${event.index} ${String(event.details.eventType)} ${String((event.player as { id?: number }).id)}`
        )
    )
    // Only the top of the second announces it: 210 pitches, and Home 1
    // plays short.
    expect(changes).deep.equals([
      [],
      [],
      [],
      [],
      [],
      [],
      ['0 pitching_substitution 210', `1 defensive_switch ${PITCHER}`],
      [],
      []
    ])
    const result = gameStatLines(plays, teams, new Set([...known, 210]))
    if (result.kind !== 'lines') throw new Error(result.detail)
    const got = new Map(result.lines.map(line => [line.userId, line]))
    expect(got.get(210)).includes({ pitch_bf: 3, pitch_outs: 3 })
    // Home 5 neither batted nor pitched.
    expect(got.has(HOME[4])).equals(false)
    expect(got.get(PITCHER)).includes({ pitch_bf: 3, pitch_outs: 3 })
  })
})

describe('pitchers without a user id who share a name', function () {
  // Both sides bring eight, so each is topped up with its own "Player 9".
  const eight = (
    first: number,
    missing: string
  ): Array<{
    userId: number
    shortName: string
    positions: string[]
  }> =>
    ['P', 'C', '1B', '2B', 'SS', '3B', 'LF', 'CF', 'RF']
      .filter(position => position !== missing)
      .map((position, i) => ({
        userId: first + i,
        shortName: `${first} ${position}`,
        positions: [position]
      }))
  const short = (awayMissing: string | null): GameState =>
    freshGame(
      'g1',
      TEAMS,
      newSetup(TEAMS, {
        away: eight(101, awayMissing ?? ''),
        home: eight(201, 'RF')
      })
    )
  const swap =
    (
      side: 'away' | 'home',
      a: 'P' | 'SS' | 'RF',
      b: 'P' | 'SS' | 'RF'
    ): ((state: GameState) => ScoringAction) =>
    state => {
      const setup = setupOf(state)
      const defense = setup.sides[side].defense
      ;[defense[a], defense[b]] = [defense[b], defense[a]]
      return { type: 'lineup', kind: 'roster', setup }
    }
  const outsOf = (
    state: GameState,
    ...steps: Array<ScoringAction | ((state: GameState) => ScoringAction)>
  ): Map<number, PlayerGameLine> => {
    let now = state
    const actions: ScoringAction[] = []
    for (const step of steps) {
      const action = typeof step === 'function' ? step(now) : step
      actions.push(action)
      now = after(now, action)
    }
    const plays = now.liveData.plays.allPlays.map(play =>
      foldPlay(now, play, { setupBefore: setupOf(now), actions })
    )
    const result = gameStatLines(plays, teams, new Set([...AWAY, ...HOME]))
    if (result.kind !== 'lines') throw new Error(result.detail)
    return new Map(result.lines.map(line => [line.userId, line]))
  }

  it("a change to the visitors' Player 9 while they bat takes no out from the home pitcher", function () {
    // The home side later pitches its own Player 9, who gets the third out.
    const got = outsOf(
      short('SS'),
      ...strikeout,
      ball,
      swap('away', 'P', 'SS'),
      ...strikeout,
      swap('home', 'P', 'RF'),
      ...strikeout
    )
    expect(got.get(PITCHER)).includes({ pitch_bf: 2, pitch_outs: 2 })
  })

  it('the same with nine visitors, so only the home side has a Player 9', function () {
    const got = outsOf(
      short(null),
      ...strikeout,
      ball,
      swap('away', 'P', 'SS'),
      ...strikeout,
      swap('home', 'P', 'RF'),
      ...strikeout
    )
    expect(got.get(PITCHER)).includes({ pitch_bf: 2, pitch_outs: 2 })
  })

  it("the home side's own Player 9, brought in mid plate appearance, takes the out from its pitcher", function () {
    const got = outsOf(short(null), ball, swap('home', 'P', 'RF'), ...strikeout)
    expect(got.get(PITCHER)?.pitch_outs ?? 0).equals(0)
  })
})

describe('when each lineup change is announced', function () {
  // The rows of the substitution table (QA round 6): who changes the lineup
  // and when, whom the new man replaces, and what he does next. The visitors
  // are 101-109 batting in order, fielding P, C, 1B, 2B, SS, 3B, LF, CF and
  // RF, with 110 and 111 on the bench; the home side is 201-209 the same
  // way, with 210-212 on the bench. Their session ids are 1-11 and 12-23.
  const PLAYERS = {
    away: [...AWAY, 110, 111],
    home: [...HOME, 210, 211, 212]
  }
  const sessionId = (user: number): number =>
    user < 200 ? user - 100 : user - 189
  const begin = (): GameState => {
    const setup = newSetup(TEAMS, {
      away: PLAYERS.away.map(userId => ({ userId, shortName: `${userId}` })),
      home: PLAYERS.home.map(userId => ({ userId, shortName: `${userId}` }))
    })
    for (const side of ['away', 'home'] as const)
      setup.sides[side].battingOrder = setup.sides[side].battingOrder.slice(
        0,
        9
      )
    return freshGame('g1', TEAMS, setup)
  }
  type Step = (state: GameState) => ScoringAction[]
  const settle: Step = state => (nextDecision(state) === 'close' ? [close] : [])
  const pitches =
    (...calls: PitchCall[]): Step =>
    () =>
      calls.map((call): ScoringAction => ({ type: 'pitch', call }))
  const three = pitches('C', 'C', 'C')
  const K: Step[] = [three, settle]
  const out = (times: number): Step[] =>
    Array.from({ length: times }, () => K).flat()
  const walked: Step[] = [pitches('B', 'B', 'B', 'B'), settle]
  const inPlay =
    (eventType: 'single' | 'home_run'): Step =>
    state => [
      { type: 'pitch', call: 'F' },
      {
        type: 'ballInPlay',
        contact: 'swing',
        fielder:
          setupOf(state).sides[
            state.liveData.linescore.isTopInning ? 'home' : 'away'
          ].defense.CF!,
        trajectory: eventType === 'single' ? 'line_drive' : 'fly_ball'
      },
      { type: 'result', eventType }
    ]
  const single: Step[] = [inPlay('single'), settle]
  const homer: Step[] = [inPlay('home_run'), settle]
  const sub =
    (user: number, replaces: number): Step =>
    () => [
      {
        type: 'lineup',
        kind: 'substitute',
        side: user < 200 ? 'away' : 'home',
        player: sessionId(user),
        replaces: sessionId(replaces)
      }
    ]
  const swap =
    (side: 'away' | 'home'): Step =>
    state => {
      const setup = setupOf(state)
      const defense = setup.sides[side].defense
      ;[defense.P, defense.SS] = [defense.SS, defense.P]
      return [{ type: 'lineup', kind: 'roster', setup }]
    }
  /** The visitors bat 111 in their pitcher's place, as a DH. */
  const designated: Step = state => {
    const setup = setupOf(state)
    setup.sides.away.battingOrder[0] = sessionId(111)
    return [{ type: 'lineup', kind: 'roster', setup }]
  }
  const place =
    (user: number): Step =>
    () => [
      {
        type: 'gameFlow',
        kind: 'placeRunner',
        runner: sessionId(user),
        base: '2B'
      }
    ]
  const play =
    (user: number, position: 'P' | 'C' | '1B' | 'LF' | 'CF'): Step =>
    () => [
      {
        type: 'lineup',
        kind: 'position',
        side: 'away',
        position,
        player: sessionId(user)
      }
    ]
  /** The visitors trade two men's places in their batting order. */
  const reorder =
    (a: number, b: number): Step =>
    state => {
      const order = [...setupOf(state).sides.away.battingOrder]
      const [i, j] = [order.indexOf(sessionId(a)), order.indexOf(sessionId(b))]
      ;[order[i], order[j]] = [order[j], order[i]]
      return [{ type: 'lineup', kind: 'battingOrder', side: 'away', order }]
    }
  /** A ground ball to short: `lead` forced at second, `batter` safe at first. */
  const choice =
    (lead: number, batter: number): Step =>
    state => {
      const fielders = setupOf(state).sides.home.defense
      return [
        { type: 'pitch', call: 'F' },
        {
          type: 'ballInPlay',
          contact: 'swing',
          fielder: fielders.SS!,
          trajectory: 'ground_ball'
        },
        { type: 'result', eventType: 'fielders_choice' },
        {
          type: 'runnerMovement',
          runner: sessionId(lead),
          to: '2B',
          out: true,
          fielders: [fielders.SS!, fielders['2B']!]
        },
        { type: 'runnerMovement', runner: sessionId(batter), to: '1B' }
      ]
    }
  /** A new player, Zed Z, added to the visitors' roster and sent in for `user`. */
  const zed =
    (user: number): Step =>
    state => {
      const added = after(state, {
        type: 'lineup',
        kind: 'addPlayer',
        side: 'away',
        name: 'Zed Z',
        jersey: '99'
      })
      return [
        {
          type: 'lineup',
          kind: 'addPlayer',
          side: 'away',
          name: 'Zed Z',
          jersey: '99'
        },
        {
          type: 'lineup',
          kind: 'substitute',
          side: 'away',
          player: setupOf(added).sides.away.players.at(-1)!,
          replaces: sessionId(user)
        }
      ]
    }
  /** 110 sent in for the DH, 111, while 103 bats with two out; the side fields first. */
  const forTheDesignated: Step[] = [
    designated,
    ...out(2),
    pitches('B'),
    sub(110, 111),
    three,
    settle,
    ...out(3)
  ]
  /** Top 3: 107 out, 108 on, 111 sent in for 101 while 109 bats, then bats. */
  const forThePitcher: Step[] = [
    ...out(13),
    ...single,
    pitches('B'),
    sub(111, 101),
    three,
    settle,
    ...K
  ]

  interface Row {
    /** The row of the table, and the variant. */
    row: string
    steps: Step[]
    /** Every stored substitution: play[index] type player position order replaced count. */
    announced: string[]
    /** Each stored substitution's description, when the row is about its words. */
    said?: string[]
    /** Each pitcher's batters faced and outs. */
    pitchers?: Record<number, [number, number]>
    endGame?: 'allowed' | 'refused'
  }
  const check = (rows: Row[]): void => {
    for (const { row, steps, announced, said, pitchers, endGame } of rows) {
      let state = begin()
      const actions: ScoringAction[] = []
      for (const step of steps)
        for (const action of step(state)) {
          actions.push(action)
          state = after(state, action)
        }
      if (endGame != null) {
        const ended = applyAction(state, {
          type: 'gameFlow',
          kind: 'endGame'
        })
        expect(ended.problems.length > 0, row).equals(endGame === 'refused')
        state = ended.state
      }
      const stamp = { setupBefore: setupOf(state), actions }
      const plays = state.liveData.plays.allPlays.map(play =>
        foldPlay(state, play, stamp)
      )
      const open = state.final
        ? []
        : [foldCurrentPlay(state, state.liveData.plays.currentPlay, stamp)]
      const substitutions = [...plays, ...open].flatMap(play =>
        (play.playEvents ?? [])
          .filter(event => event.isSubstitution === true)
          .map(event => ({ play, event }))
      )
      const written = substitutions.map(({ play, event }) => {
        const { balls, strikes, outs } = event.count as Record<string, number>
        const id = (person: unknown): string =>
          String((person as { id?: number } | undefined)?.id ?? '-')
        return [
          `#${play.about.atBatIndex}[${String(event.index)}]`,
          event.details.eventType,
          id(event.player),
          (event.position as { abbreviation?: string } | undefined)
            ?.abbreviation ?? '-',
          event.battingOrder ?? '-',
          id(event.replacedPlayer),
          `c=${balls}-${strikes}-${outs}`
        ].join(' ')
      })
      expect(written, row).deep.equals(announced)
      if (said != null)
        expect(
          substitutions.map(({ event }) => event.details.description),
          row
        ).deep.equals(said)
      for (const play of [...plays, ...open])
        expect(gumboViolations(play), row).deep.equals([])
      const result = gameStatLines(
        plays,
        teams,
        new Set([...PLAYERS.away, ...PLAYERS.home])
      )
      if (result.kind !== 'lines') throw new Error(result.detail)
      const lines = Object.fromEntries(
        result.lines
          .filter(line => line.pitch_bf > 0 || line.pitch_outs > 0)
          .map(line => [line.userId, [line.pitch_bf, line.pitch_outs]])
      )
      if (pitchers != null) expect(lines, row).deep.equals(pitchers)
    }
  }

  it('announces a pinch hitter or runner for the batter or a man on base where he comes in', function () {
    check([
      {
        row: 'B1/B2 for the batter, mid plate appearance, then fields',
        steps: [...K, pitches('B'), sub(111, 102), three, settle, ...out(4)],
        announced: [
          '#1[1] offensive_substitution 111 PH 201 102 c=1-0-1',
          '#3[0] defensive_switch 111 C 201 102 c=0-0-0'
        ],
        pitchers: { 201: [3, 3], 101: [3, 3] }
      },
      {
        row: 'B1/B2 for the batter, between plays',
        steps: [...K, sub(111, 102), ...out(5)],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-1',
          '#3[0] defensive_switch 111 C 201 102 c=0-0-0'
        ]
      },
      {
        row: 'B1/B2 for the batter at the break, after the side in the field changes pitcher (F3)',
        steps: [...out(6), sub(210, 201), sub(111, 104), ...out(6)],
        announced: [
          '#6[0] pitching_substitution 210 P - - c=0-0-0',
          '#6[1] offensive_substitution 111 PH 401 104 c=0-0-0',
          '#9[0] defensive_switch 111 2B 401 104 c=0-0-0'
        ],
        pitchers: { 201: [3, 3], 210: [3, 3], 101: [6, 6] }
      },
      {
        row: 'B3 for the batter, then the game ends',
        steps: [...K, pitches('B'), sub(111, 102), three, settle],
        announced: ['#1[1] offensive_substitution 111 PH 201 102 c=1-0-1'],
        endGame: 'allowed'
      },
      {
        row: 'B5/B7 for a man on base, who then fields',
        steps: [
          ...K,
          ...single,
          pitches('B'),
          sub(111, 102),
          three,
          settle,
          ...out(4)
        ],
        announced: [
          '#2[1] offensive_substitution 111 PR 201 102 c=1-0-1',
          '#4[0] defensive_switch 111 C 201 102 c=0-0-0'
        ]
      },
      {
        row: 'B6 for a man on base, who bats later in the half',
        steps: [
          ...single,
          pitches('B'),
          sub(111, 101),
          ...homer,
          ...Array.from({ length: 7 }, () => walked).flat(),
          ...out(6)
        ],
        announced: [
          '#1[1] offensive_substitution 111 PR 101 101 c=1-0-0',
          '#12[0] pitching_substitution 111 P - - c=0-0-0'
        ]
      }
    ])
  })

  it('announces a pinch hitter sent in before his turn when he comes to bat', function () {
    check([
      {
        row: 'B8/B10 for the man on deck, mid plate appearance (P3)',
        steps: [pitches('B'), sub(111, 102), three, settle, ...out(5)],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-1',
          '#3[0] defensive_switch 111 C 201 102 c=0-0-0'
        ]
      },
      {
        row: 'B8/B10 for the man on deck, between plays',
        steps: [...K, sub(111, 103), ...out(5)],
        announced: [
          '#2[0] offensive_substitution 111 PH 301 103 c=0-0-2',
          '#3[0] defensive_switch 111 1B 301 103 c=0-0-0'
        ]
      },
      {
        row: 'B8/B10 for the man on deck, at the break',
        steps: [...out(6), sub(111, 105), ...out(6)],
        announced: [
          '#7[0] offensive_substitution 111 PH 501 105 c=0-0-1',
          '#9[0] defensive_switch 111 SS 501 105 c=0-0-0'
        ]
      },
      {
        row: 'B8 for a later slot',
        steps: [
          pitches('B'),
          sub(111, 104),
          pitches('B', 'B', 'B'),
          settle,
          ...walked,
          ...out(6)
        ],
        announced: [
          '#3[0] offensive_substitution 111 PH 401 104 c=0-0-1',
          '#5[0] defensive_switch 111 2B 401 104 c=0-0-0'
        ]
      },
      {
        row: 'B8 with his plate appearance open and no pitch yet',
        steps: [...K, pitches('B'), sub(111, 103), three, settle],
        announced: ['#2[0] offensive_substitution 111 PH 301 103 c=0-0-2']
      },
      {
        row: 'B11 for the man on deck, and the game ends before he bats',
        steps: [...K, pitches('B'), sub(111, 103), three, settle],
        announced: [],
        endGame: 'allowed'
      },
      {
        row: 'B13 replaced again in the same play: the one who bats replaces the man who left',
        steps: [
          pitches('B'),
          sub(111, 103),
          sub(110, 111),
          three,
          settle,
          ...out(5)
        ],
        announced: [
          '#2[0] offensive_substitution 110 PH 301 103 c=0-0-2',
          '#3[0] defensive_switch 110 1B 301 103 c=0-0-0'
        ]
      },
      {
        row: 'B13 replaced again a play later',
        steps: [
          pitches('B'),
          sub(111, 103),
          three,
          settle,
          pitches('B'),
          sub(110, 111),
          three,
          settle,
          ...out(4)
        ],
        announced: [
          '#2[0] offensive_substitution 110 PH 301 103 c=0-0-2',
          '#3[0] defensive_switch 110 1B 301 103 c=0-0-0'
        ]
      },
      {
        row: 'B14 for the pitcher, who bats, and a reliever at the break (P4)',
        steps: [...forThePitcher, sub(110, 111), ...out(3)],
        announced: [
          '#15[0] offensive_substitution 111 PH 101 101 c=0-0-2',
          '#16[0] pitching_substitution 110 P - - c=0-0-0'
        ],
        pitchers: { 101: [6, 6], 110: [3, 3], 201: [10, 9] }
      },
      {
        row: 'B14 for the pitcher, who bats and stays in to pitch',
        steps: [...forThePitcher, ...out(3)],
        announced: [
          '#15[0] offensive_substitution 111 PH 101 101 c=0-0-2',
          '#16[0] pitching_substitution 111 P - - c=0-0-0'
        ],
        pitchers: { 101: [6, 6], 111: [3, 3], 201: [10, 9] }
      }
    ])
  })

  it('announces a man the side at bat sends in who does not bat before it fields as the fielder he is', function () {
    check([
      {
        row: 'B9 for the man on deck; the side fields first, and he leads off the next half',
        steps: [
          ...out(2),
          pitches('B'),
          sub(111, 104),
          three,
          settle,
          ...out(6)
        ],
        announced: ['#3[0] defensive_substitution 111 2B - - c=0-0-0']
      },
      {
        row: 'B15 for the pitcher, not due',
        steps: [...K, pitches('B'), sub(110, 101), three, settle, ...out(4)],
        announced: ['#3[0] pitching_substitution 110 P - - c=0-0-0'],
        pitchers: { 110: [3, 3], 201: [3, 3] }
      },
      {
        row: 'B16 for a pitcher outside the order',
        steps: [
          designated,
          ...K,
          pitches('B'),
          sub(110, 101),
          three,
          settle,
          ...out(4)
        ],
        announced: ['#3[0] pitching_substitution 110 P - - c=0-0-0'],
        pitchers: { 110: [3, 3], 201: [3, 3] }
      },
      {
        row: 'B17 a switch',
        steps: [pitches('B'), swap('away'), ...out(6)],
        announced: [
          '#3[0] pitching_substitution 105 P - - c=0-0-0',
          '#3[1] defensive_switch 101 SS 100 105 c=0-0-0'
        ],
        pitchers: { 105: [3, 3], 201: [3, 3] }
      },
      {
        row: 'B17 a switch made and undone before the side fields',
        steps: [pitches('B'), swap('away'), ...K, swap('away'), ...out(5)],
        announced: [],
        pitchers: { 101: [3, 3], 201: [3, 3] }
      }
    ])
  })

  it('announces a man put in the order where he first appears, in whatever half', function () {
    check([
      {
        row: 'R1 sent in for a man not on base, then placed as the extra-inning runner',
        steps: [...out(6), sub(111, 103), place(111), ...single, ...out(6)],
        announced: [
          '#6[1] offensive_substitution 111 PR 301 103 c=0-0-0',
          '#10[0] defensive_switch 111 1B 301 103 c=0-0-0'
        ]
      },
      {
        row: 'R1 placed, then a pinch runner for him',
        steps: [...out(6), place(103), sub(111, 103), ...single, ...out(6)],
        announced: [
          '#6[1] offensive_substitution 111 PR 301 103 c=0-0-0',
          '#10[0] defensive_switch 111 1B 301 103 c=0-0-0'
        ]
      },
      {
        row: 'R1 placed, then bats later in the half',
        steps: [
          ...out(6),
          sub(111, 103),
          place(111),
          ...Array.from({ length: 6 }, () => walked).flat(),
          ...out(6)
        ],
        announced: [
          '#6[1] offensive_substitution 111 PR 301 103 c=0-0-0',
          '#15[0] defensive_switch 111 1B 301 103 c=0-0-0'
        ]
      },
      {
        row: 'R2 a DH entrant waiting across halves, placed as the extra-inning runner',
        steps: [...forTheDesignated, place(110), ...out(6)],
        announced: ['#6[1] offensive_substitution 110 PR 101 111 c=0-0-0']
      },
      {
        row: 'R3 a DH entrant whose side fields first bats in a later half',
        steps: [...forTheDesignated, ...out(15)],
        announced: ['#18[0] offensive_substitution 110 PH 101 111 c=0-0-0']
      },
      {
        row: 'R3 a pinch hitter for the DH at his turn',
        steps: [
          designated,
          ...out(18),
          sub(110, 111),
          pitches('B'),
          three,
          settle,
          ...out(5)
        ],
        announced: ['#18[0] offensive_substitution 110 PH 101 111 c=0-0-0']
      },
      {
        row: 'R3 the side in the field replaces its DH, who bats when it next bats',
        steps: [
          designated,
          ...out(4),
          pitches('B'),
          sub(110, 111),
          three,
          settle,
          ...out(19)
        ],
        announced: ['#18[0] offensive_substitution 110 PH 101 111 c=0-0-0']
      },
      {
        row: 'R5 a DH entrant waiting across halves, moved to a position while his side bats',
        steps: [
          ...forTheDesignated,
          pitches('B'),
          play(110, 'LF'),
          three,
          settle,
          ...out(14)
        ],
        announced: ['#9[0] defensive_substitution 110 LF - - c=0-0-0']
      },
      {
        row: 'R5 the side in the field replaces its DH, then plays him',
        steps: [
          designated,
          ...out(4),
          sub(110, 111),
          pitches('B'),
          play(110, 'LF'),
          three,
          settle,
          ...out(16)
        ],
        announced: ['#4[1] defensive_substitution 110 LF - - c=1-0-1']
      }
    ])
  })

  it('announces nobody who leaves before he appears, and each man in turn as replacing the last who appeared', function () {
    check([
      {
        row: 'R4 the starter put back for his own waiting pinch hitter',
        steps: [
          pitches('B'),
          sub(111, 102),
          sub(102, 111),
          three,
          settle,
          ...out(5)
        ],
        announced: []
      },
      {
        row: 'R4 a DH entrant waiting across halves, and the DH put back',
        steps: [...forTheDesignated, sub(111, 110), ...out(15)],
        announced: []
      },
      {
        row: 'R6 a DH entrant waiting when the game ends',
        steps: forTheDesignated,
        announced: [],
        endGame: 'allowed'
      },
      {
        row: 'R7 a starter re-entering for the pinch hitter who batted for him, who fields first',
        steps: [...K, sub(111, 102), ...out(5), sub(102, 111), ...out(6)],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-1',
          '#3[0] defensive_switch 111 C 201 102 c=0-0-0',
          '#9[0] defensive_substitution 102 C - - c=0-0-0'
        ]
      },
      {
        row: 'B8 two sent in at once, each announced when he bats',
        steps: [
          pitches('B'),
          sub(111, 102),
          sub(110, 103),
          three,
          settle,
          ...out(5)
        ],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-1',
          '#2[0] offensive_substitution 110 PH 301 103 c=0-0-2',
          '#3[0] defensive_switch 111 C 201 102 c=0-0-0',
          '#3[1] defensive_switch 110 1B 301 103 c=0-0-0'
        ]
      },
      {
        row: 'B8/B9 two sent in at once, and the half ends after the first bats',
        steps: [
          ...K,
          pitches('B'),
          sub(111, 103),
          sub(110, 104),
          three,
          settle,
          ...out(4)
        ],
        announced: [
          '#2[0] offensive_substitution 111 PH 301 103 c=0-0-2',
          '#3[0] defensive_switch 111 1B 301 103 c=0-0-0',
          '#3[1] defensive_substitution 110 2B - - c=0-0-0'
        ]
      },
      {
        row: 'B1 a pinch hitter for an announced pinch hitter at his turn, before a pitch',
        steps: [
          pitches('B'),
          sub(111, 102),
          three,
          settle,
          sub(110, 111),
          ...out(5)
        ],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-1',
          '#1[1] offensive_substitution 110 PH 202 111 c=0-0-1',
          '#3[0] defensive_switch 110 C 202 102 c=0-0-0'
        ]
      },
      {
        row: 'B1 the same after a pitch',
        steps: [
          pitches('B'),
          sub(111, 102),
          three,
          settle,
          pitches('C'),
          sub(110, 111),
          pitches('C', 'C'),
          settle,
          ...out(4)
        ],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-1',
          '#1[2] offensive_substitution 110 PH 202 111 c=0-1-1',
          '#3[0] defensive_switch 110 C 202 102 c=0-0-0'
        ]
      }
    ])
  })

  it('announces the side in the field where it changes, or with its net change before its first pitch', function () {
    check([
      {
        row: 'F1/F6 a new pitcher mid plate appearance, who later bats',
        steps: [...K, pitches('B'), sub(210, 201), three, settle, ...out(4)],
        announced: ['#1[1] pitching_substitution 210 P - - c=1-0-1'],
        pitchers: { 201: [1, 1], 210: [2, 2], 101: [3, 3] }
      },
      {
        row: "F1 after the game's first pitch",
        steps: [pitches('B'), sub(210, 201), ...out(6)],
        announced: ['#0[1] pitching_substitution 210 P - - c=1-0-0'],
        pitchers: { 210: [3, 3], 101: [3, 3] }
      },
      {
        row: 'F1 after the first pitch of its half',
        steps: [
          ...out(3),
          pitches('B'),
          sub(110, 101),
          three,
          settle,
          ...out(2)
        ],
        announced: ['#3[1] pitching_substitution 110 P - - c=1-0-0'],
        pitchers: { 110: [3, 3], 201: [3, 3] }
      },
      {
        row: 'F2 a new fielder mid plate appearance',
        steps: [...K, pitches('B'), sub(212, 205), three, settle, ...out(4)],
        announced: ['#1[1] defensive_substitution 212 SS - - c=1-0-1']
      },
      {
        row: 'F2 a switch between plays',
        steps: [...K, swap('home'), ...out(5)],
        announced: [
          '#1[0] pitching_substitution 205 P - - c=0-0-1',
          '#1[1] defensive_switch 201 SS 100 205 c=0-0-1'
        ],
        pitchers: { 201: [1, 1], 205: [2, 2], 101: [3, 3] }
      },
      {
        row: 'F3 at the break',
        steps: [...out(3), sub(110, 101), ...out(3)],
        announced: ['#3[0] pitching_substitution 110 P - - c=0-0-0'],
        pitchers: { 110: [3, 3], 201: [3, 3] }
      },
      {
        row: 'F4 at the break, then End Game',
        steps: [...out(3), sub(110, 101)],
        announced: ['#3[0] pitching_substitution 110 P - - c=0-0-0'],
        endGame: 'refused'
      },
      {
        row: 'F7 before the game',
        steps: [sub(210, 201), sub(111, 102), ...out(6)],
        announced: [],
        pitchers: { 210: [3, 3], 101: [3, 3] }
      }
    ])
  })

  it('names the man a fielder coming in at the break replaces as the last who appeared in that place', function () {
    check([
      {
        row: 'R9 a new man for a pinch runner who ran for a pinch hitter',
        steps: [
          ...K,
          sub(111, 102),
          ...single,
          sub(110, 111),
          ...K,
          ...K,
          zed(110),
          ...out(6)
        ],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-1',
          '#2[0] offensive_substitution 110 PR 202 111 c=0-0-1',
          '#4[0] defensive_substitution - C - - c=0-0-0'
        ],
        said: [
          'Offensive Substitution: Pinch-hitter 111 replaces 102.',
          'Offensive Substitution: Pinch-runner 110 replaces 111.',
          'Defensive Substitution: Zed Z replaces pinch-runner 110, playing catcher.'
        ]
      },
      {
        row: 'R9 a new man for a pinch hitter who batted',
        steps: [
          ...K,
          sub(111, 102),
          ...single,
          ...K,
          ...K,
          sub(110, 111),
          ...out(6)
        ],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-1',
          '#4[0] defensive_substitution 110 C - - c=0-0-0'
        ],
        said: [
          'Offensive Substitution: Pinch-hitter 111 replaces 102.',
          'Defensive Substitution: 110 replaces pinch-hitter 111, playing catcher.'
        ]
      },
      {
        row: 'R9 a pinch hitter re-entering for his own pinch runner',
        steps: [
          ...K,
          sub(111, 102),
          ...single,
          sub(110, 111),
          ...K,
          ...K,
          sub(111, 110),
          ...out(6)
        ],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-1',
          '#2[0] offensive_substitution 110 PR 202 111 c=0-0-1',
          '#4[0] defensive_substitution 111 C - - c=0-0-0'
        ],
        said: [
          'Offensive Substitution: Pinch-hitter 111 replaces 102.',
          'Offensive Substitution: Pinch-runner 110 replaces 111.',
          'Defensive Substitution: 111 replaces pinch-runner 110, playing catcher.'
        ]
      },
      {
        row: 'R9 a double switch: the pinch hitter stays in at first, and the new catcher replaces the first baseman',
        steps: [
          ...K,
          sub(111, 102),
          ...single,
          ...K,
          ...K,
          sub(110, 103),
          play(110, 'C'),
          play(111, '1B'),
          ...out(6)
        ],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-1',
          '#4[0] defensive_substitution 110 C - - c=0-0-0',
          '#4[1] defensive_switch 111 1B 201 103 c=0-0-0'
        ],
        said: [
          'Offensive Substitution: Pinch-hitter 111 replaces 102.',
          'Defensive Substitution: 110 replaces 103, playing catcher.',
          '111 remains in the game as the first baseman.'
        ]
      },
      {
        row: 'R9 a man sent in while his side bats, for a pinch hitter who has fielded since',
        steps: [
          ...K,
          sub(111, 102),
          ...single,
          ...K,
          ...K,
          ...out(9),
          sub(110, 111),
          ...out(3)
        ],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-1',
          '#4[0] defensive_switch 111 C 201 102 c=0-0-0',
          '#16[0] defensive_substitution 110 C - - c=0-0-0'
        ],
        said: [
          'Offensive Substitution: Pinch-hitter 111 replaces 102.',
          '111 remains in the game as the catcher.',
          'Defensive Substitution: 110 replaces 111, playing catcher.'
        ]
      },
      {
        row: 'R7 the starter back for a waiting man who replaced the pinch hitter who fielded',
        steps: [
          ...K,
          sub(111, 102),
          ...out(5),
          pitches('B'),
          sub(110, 111),
          sub(102, 110),
          three,
          settle,
          ...out(8)
        ],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-1',
          '#3[0] defensive_switch 111 C 201 102 c=0-0-0',
          '#9[0] defensive_substitution 102 C - - c=0-0-0'
        ],
        said: [
          'Offensive Substitution: Pinch-hitter 111 replaces 102.',
          '111 remains in the game as the catcher.',
          'Defensive Substitution: 102 replaces 111, playing catcher.'
        ]
      },
      {
        row: 'B15/F3 a waiting man for the pitcher, in a double switch at the break',
        steps: [
          ...out(7),
          pitches('B'),
          sub(111, 101),
          three,
          settle,
          ...K,
          sub(110, 108),
          play(110, 'P'),
          play(111, 'CF'),
          ...out(6)
        ],
        announced: [
          '#9[0] pitching_substitution 110 P - - c=0-0-0',
          '#9[1] defensive_substitution 111 CF - - c=0-0-0'
        ],
        said: [
          'Pitching Change: 110 replaces 101.',
          'Defensive Substitution: 111 replaces 108, playing center field.'
        ],
        pitchers: { 101: [3, 3], 110: [3, 3], 201: [9, 9] }
      }
    ])
  })

  it('leaves a man who has not appeared out of a change of batting order', function () {
    check([
      {
        row: 'R8 a waiting man moved down, who then fields first',
        steps: [
          pitches('B'),
          sub(111, 105),
          reorder(111, 106),
          three,
          settle,
          ...out(8)
        ],
        announced: [
          '#0[1] gs_batting_order 106 - - - c=1-0-0',
          '#3[0] defensive_substitution 111 SS - - c=0-0-0'
        ],
        said: [
          'Batting order change: 106 bats 5th.',
          'Defensive Substitution: 111 replaces 105, playing shortstop.'
        ]
      },
      {
        row: 'R8 a waiting man moved to a place already past',
        steps: [
          ...out(2),
          pitches('B'),
          sub(111, 105),
          reorder(111, 102),
          three,
          settle,
          ...out(9)
        ],
        announced: [
          '#2[1] gs_batting_order 102 - - - c=1-0-2',
          '#3[0] defensive_substitution 111 SS - - c=0-0-0'
        ],
        said: [
          'Batting order change: 102 bats 5th.',
          'Defensive Substitution: 111 replaces 105, playing shortstop.'
        ]
      },
      {
        row: 'R8 a waiting man moved up, who bats',
        steps: [
          pitches('B'),
          sub(111, 105),
          reorder(111, 103),
          three,
          settle,
          ...out(8)
        ],
        announced: [
          '#0[1] gs_batting_order 103 - - - c=1-0-0',
          '#2[0] offensive_substitution 111 PH 301 105 c=0-0-2',
          '#3[0] defensive_switch 111 SS 301 105 c=0-0-0'
        ],
        said: [
          'Batting order change: 103 bats 5th.',
          'Offensive Substitution: Pinch-hitter 111 replaces 105.',
          '111 remains in the game as the shortstop.'
        ]
      },
      {
        row: 'R8 a DH entrant waiting across halves, moved at a later break',
        steps: [...forTheDesignated, reorder(110, 104), ...out(6)],
        announced: [
          '#6[0] gs_batting_order 104 - - - c=0-0-0',
          '#12[0] offensive_substitution 110 PH 401 111 c=0-0-0'
        ],
        said: [
          'Batting order change: 104 bats 1st.',
          'Offensive Substitution: Pinch-hitter 110 replaces 111.'
        ]
      },
      {
        row: 'R8 a change of order that moves only waiting men is not written',
        steps: [
          pitches('B'),
          sub(111, 104),
          sub(110, 105),
          reorder(111, 110),
          three,
          settle,
          ...out(8)
        ],
        announced: [
          '#3[0] defensive_substitution 111 2B - - c=0-0-0',
          '#3[1] defensive_substitution 110 SS - - c=0-0-0'
        ]
      },
      {
        row: 'R8 a man who has appeared is named',
        steps: [
          ...out(2),
          pitches('B'),
          sub(110, 109),
          three,
          settle,
          ...out(3),
          reorder(110, 104),
          ...out(3)
        ],
        announced: [
          '#3[0] defensive_substitution 110 RF - - c=0-0-0',
          '#6[0] gs_batting_order 110 - - - c=0-0-0'
        ],
        said: [
          'Defensive Substitution: 110 replaces 109, playing right field.',
          'Batting order change: 110 bats 4th, 104 bats 9th.'
        ]
      }
    ])
  })

  it("announces each of QA round 8's other probes where the man first appears", function () {
    check([
      {
        row: "B8 a waiting pinch hitter reaches on a fielder's choice",
        steps: [
          pitches('B'),
          sub(111, 102),
          ...single,
          choice(101, 111),
          settle,
          ...out(5)
        ],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-0',
          '#4[0] defensive_switch 111 C 201 102 c=0-0-0'
        ],
        pitchers: { 101: [3, 3], 201: [4, 3] }
      },
      {
        row: "B1 a pinch hitter after a ball reaches on a fielder's choice, and a pinch runner for him",
        steps: [
          ...single,
          pitches('B'),
          sub(111, 102),
          choice(101, 111),
          settle,
          sub(110, 111),
          ...out(5)
        ],
        announced: [
          '#1[1] offensive_substitution 111 PH 201 102 c=1-0-0',
          '#2[0] offensive_substitution 110 PR 202 111 c=0-0-1',
          '#4[0] defensive_switch 110 C 202 102 c=0-0-0'
        ]
      },
      {
        row: "B8 a waiting pinch hitter reaches on a fielder's choice and is forced out on the next",
        steps: [
          pitches('B'),
          sub(111, 102),
          ...single,
          choice(101, 111),
          settle,
          choice(111, 103),
          settle,
          ...out(4)
        ],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-0',
          '#4[0] defensive_switch 111 C 201 102 c=0-0-0'
        ]
      },
      {
        row: 'B15 then F1 the waiting man pitches, and is relieved after one ball',
        steps: [
          ...out(7),
          pitches('B'),
          sub(111, 101),
          three,
          settle,
          ...K,
          pitches('B'),
          sub(110, 111),
          three,
          settle,
          ...out(5)
        ],
        announced: [
          '#9[0] pitching_substitution 111 P - - c=0-0-0',
          '#9[2] pitching_substitution 110 P - - c=1-0-0'
        ],
        pitchers: { 101: [3, 3], 110: [3, 3], 201: [9, 9] }
      },
      {
        row: 'R4 the pitcher put back before either appears',
        steps: [
          ...out(7),
          pitches('B'),
          sub(111, 101),
          three,
          settle,
          ...K,
          sub(101, 111),
          ...out(6)
        ],
        announced: [],
        pitchers: { 101: [6, 6], 201: [9, 9] }
      },
      {
        row: 'B13/B15 a second waiting man for the pitcher',
        steps: [
          ...out(7),
          pitches('B'),
          sub(111, 101),
          three,
          settle,
          ...K,
          sub(110, 111),
          ...out(6)
        ],
        announced: ['#9[0] pitching_substitution 110 P - - c=0-0-0'],
        pitchers: { 101: [3, 3], 110: [3, 3], 201: [9, 9] }
      },
      {
        row: 'F1 two pitching changes by the side in the field mid-half',
        steps: [
          ...out(6),
          pitches('B'),
          sub(211, 201),
          sub(210, 211),
          three,
          settle,
          ...out(5)
        ],
        announced: [
          '#6[1] pitching_substitution 211 P - - c=1-0-0',
          '#6[2] pitching_substitution 210 P - - c=1-0-0'
        ],
        pitchers: { 101: [6, 6], 201: [3, 3], 210: [3, 3] }
      },
      {
        row: 'B13 a five-step waiting chain in one place',
        steps: [
          pitches('B'),
          sub(111, 102),
          sub(110, 111),
          sub(111, 110),
          sub(110, 111),
          sub(111, 110),
          three,
          settle,
          ...out(5)
        ],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-1',
          '#3[0] defensive_switch 111 C 201 102 c=0-0-0'
        ]
      },
      {
        row: 'B9 a waiting man for a pinch hitter who fielded replaces him in the field',
        steps: [
          pitches('B'),
          sub(111, 102),
          ...out(6),
          pitches('B'),
          sub(110, 111),
          three,
          settle,
          ...out(8)
        ],
        announced: [
          '#1[0] offensive_substitution 111 PH 201 102 c=0-0-1',
          '#3[0] defensive_switch 111 C 201 102 c=0-0-0',
          '#9[0] defensive_substitution 110 C - - c=0-0-0'
        ],
        said: [
          'Offensive Substitution: Pinch-hitter 111 replaces 102.',
          '111 remains in the game as the catcher.',
          'Defensive Substitution: 110 replaces 111, playing catcher.'
        ]
      }
    ])
  })

  it('announces a pinch runner where he takes the base, names him after, and charges his run as the man he ran for (U24)', function () {
    // 101 reaches on an error off 201; 210 relieves; 111 runs for 101,
    // steals second and scores on 102's home run.
    const errorPlay: Step = state => {
      const shortstop = setupOf(state).sides.home.defense.SS!
      return [
        { type: 'pitch', call: 'F' },
        { type: 'ballInPlay', contact: 'swing', fielder: shortstop },
        { type: 'result', eventType: 'field_error' },
        { type: 'fieldingPlay', fielders: [shortstop], error: shortstop }
      ]
    }
    const steps: Step[] = [
      errorPlay,
      settle,
      sub(210, 201),
      () => [
        {
          type: 'lineup',
          kind: 'pinchRunner',
          side: 'away',
          base: '1B',
          player: sessionId(111)
        }
      ],
      () => [
        {
          type: 'baseRunning',
          kind: 'steal',
          runner: sessionId(111),
          to: '2B'
        }
      ],
      ...homer
    ]
    let state = begin()
    const actions: ScoringAction[] = []
    for (const step of steps)
      for (const action of step(state)) {
        actions.push(action)
        state = after(state, action)
      }
    const stamp = { setupBefore: setupOf(state), actions }
    const plays = state.liveData.plays.allPlays.map(play =>
      foldPlay(state, play, stamp)
    )
    const [, second] = plays
    const events = (second.playEvents ?? []).map(event => {
      const who = (event.player as { id?: number } | undefined)?.id
      return `${String(event.index)} ${String(event.details.eventType)} ${String(who)}`
    })
    expect(events).deep.equals([
      '0 pitching_substitution 210',
      '1 offensive_substitution 111',
      '2 stolen_base_2b 111',
      '3 undefined 210',
      '4 undefined 210'
    ])
    expect(second.playEvents![1]).deep.include({
      battingOrder: '101',
      replacedPlayer: { id: 101, fullName: '101' }
    })
    expect(second.playEvents![1].details.description).equals(
      'Offensive Substitution: Pinch-runner 111 replaces 101.'
    )
    const runners = (second.runners ?? []) as unknown as Array<{
      movement: { start: string | null; end: string | null }
      details: {
        runner: { id: number }
        eventType: string
        responsiblePitcher: { id: number } | null
        earned: boolean
      }
    }>
    expect(
      runners.map(
        runner =>
          `${runner.details.runner.id} ${String(runner.movement.start)}>${String(runner.movement.end)} ${runner.details.eventType}`
      )
    ).deep.equals([
      '111 1B>2B stolen_base_2b',
      '111 2B>score home_run',
      '102 null>score home_run'
    ])
    expect(runners[1].details).deep.include({
      responsiblePitcher: { id: 201 },
      earned: false
    })
    expect(runners[2].details).deep.include({
      responsiblePitcher: { id: 210 },
      earned: true
    })
    for (const play of plays) expect(gumboViolations(play)).deep.equals([])
    const result = gameStatLines(
      plays,
      teams,
      new Set([...PLAYERS.away, ...PLAYERS.home])
    )
    if (result.kind !== 'lines') throw new Error(result.detail)
    const line = (user: number): PlayerGameLine | undefined =>
      result.lines.find(entry => entry.userId === user)
    expect(line(111)).includes({ r: 1, sb: 1, pa: 0 })
    expect(line(101)).includes({ r: 0, sb: 0, pa: 1, ab: 1 })
    expect(line(102)).includes({ r: 1, rbi: 2, hr: 1 })
    expect(line(201)).includes({ pitch_r: 1, pitch_er: 0 })
    expect(line(210)).includes({ pitch_r: 1, pitch_er: 1 })
  })
})

describe('every set keyed by event type covers what the engine produces (U15)', function () {
  it('names, classifies and counts each produced type, after translation', function () {
    // The engine's own names, then what each is stored as; a batter's own
    // "Batter Out — Other" is stored apart from a runner's out.
    const produced = [
      ...new Set([
        ...PRODUCED_EVENT_TYPES.map(type => storedEventType(type)),
        storedEventType('other_out', 'Batter Out — Other')
      ])
    ]
    const extensions: readonly string[] = GUMBO_EXTENSION_EVENT_TYPES
    // Neither a plate appearance nor a runner's play: the stats builder skips it.
    const skipped = new Set([
      'runner_placed',
      'pitching_substitution',
      'offensive_substitution',
      'defensive_substitution',
      'defensive_switch',
      'gs_batting_order',
      'final_score'
    ])
    for (const type of produced) {
      expect(STORED_EVENT_TYPES.has(type), type).equals(true)
      expect(
        MLB_EVENT_TYPES.has(type) || extensions.includes(type),
        type
      ).equals(true)
      expect(eventTypeName(type), type).not.equals('Play')
      expect(Object.hasOwn(DID_BY_TYPE, type), type).equals(true)
      expect(Object.hasOwn(OUTCOME_BY_TYPE, type), type).equals(true)
      expect(Object.hasOwn(EVENT_CLASS, type), type).equals(true)
      const roles = Object.entries(HIGHLIGHT_CREDITED)
        .filter(([, types]) => types.has(type))
        .map(([role]) => role)
      expect(roles, type).length(1)
      const counts = eventTypeCounts(type)
      if (skipped.has(type)) expect(counts, type).equals(null)
      else expect(counts, type).not.equals(null)
      // The engine's own lines count a play as the stats builder does.
      expect(battingCounts(type), type).deep.equals(
        counts ?? { pa: false, ab: false, k: false }
      )
    }
    expect(produced).to.include.members([
      'force_out',
      'fielders_choice_out',
      'fielders_choice',
      'sac_bunt',
      'sac_bunt_double_play',
      'double_play',
      'caught_stealing_2b',
      'stolen_base_home',
      'catcher_interf',
      'gs_batter_out',
      'runner_placed'
    ])
    expect(eventTypeName('catcher_interf')).equals("Catcher's interference")
  })
})
