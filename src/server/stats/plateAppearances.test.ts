import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { GumboPlay } from '../../common/gumboPlay'
import type { ScoringAction } from '../../common/scoring/actions'
import { foldPlay } from '../../common/scoring/gumbo'
import { freshGame, newSetup } from '../../common/scoring/lineup'
import { type GameState, setupOf } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { after, TEAMS } from '../../test/scoringGames'
import { expandedGameStatLines } from './expandedStats'
import { type ChargedPlay, gameStatLines } from './gumboStats'
import {
  basesAfter,
  type PlateAppearance,
  plateAppearances,
  rowsOf
} from './plateAppearances'

/**
 * Plate appearances from games scored in TeamStation: the engine's plays,
 * folded into the documents the server stores. The visitors are users
 * 101-109 batting in order; the home pitcher is 201.
 */
const AWAY = Array.from({ length: 9 }, (_, i) => 101 + i)
const HOME = Array.from({ length: 9 }, (_, i) => 201 + i)
const PITCHER = HOME[0]
const CENTER = 208
const teams = { homeTeamId: TEAMS.home.id, awayTeamId: TEAMS.away.id }
const known = new Set([...AWAY, ...HOME])

function start(): GameState {
  const side = (
    ids: number[],
    name: string
  ): Array<{ userId: string; gumboId: number; shortName: string }> =>
    ids.map((userId, i) => ({
      userId: userIdOfGumbo(userId),
      gumboId: userId,
      shortName: `${name} ${i + 1}`
    }))
  return freshGame(
    'g1',
    TEAMS,
    newSetup(TEAMS, { away: side(AWAY, 'Away'), home: side(HOME, 'Home') })
  )
}

function scored(...actions: ScoringAction[]): GumboPlay[] {
  const state = after(start(), ...actions)
  return state.liveData.plays.allPlays.map(play =>
    foldPlay(state, play, { setupBefore: setupOf(state), actions })
  )
}

const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
const ball: ScoringAction = { type: 'pitch', call: 'B' }
const strike: ScoringAction = { type: 'pitch', call: 'C' }
const hit = (eventType: 'single' | 'double'): ScoringAction[] => [
  { type: 'ballInPlay', contact: 'swing', fielder: CENTER },
  { type: 'result', eventType }
]

/** What a test looks at of one plate appearance. */
const state = (
  pa: PlateAppearance
): Pick<
  PlateAppearance,
  | 'batterGumboId'
  | 'outsBefore'
  | 'onFirst'
  | 'onSecond'
  | 'onThird'
  | 'firstPitch'
> => ({
  batterGumboId: pa.batterGumboId,
  outsBefore: pa.outsBefore,
  onFirst: pa.onFirst,
  onSecond: pa.onSecond,
  onThird: pa.onThird,
  firstPitch: pa.firstPitch
})

describe('plate appearances and the state each began in', function () {
  const plays = scored(
    // 101 singles on the first pitch.
    ...hit('single'),
    close,
    // 102 takes a ball, then doubles 101 home.
    ball,
    ...hit('double'),
    { type: 'runnerMovement', runner: 101, to: 'home' },
    close,
    // 103 strikes out with 102 on second.
    strike,
    strike,
    strike,
    close,
    // 104 walks with one out.
    ball,
    ball,
    ball,
    ball,
    close,
    // While 105 bats, a wild pitch moves both runners up; 105 strikes out.
    strike,
    {
      type: 'batteryEvent',
      kind: 'wild_pitch',
      advances: [
        { runner: 102, to: '3B' },
        { runner: 104, to: '2B' }
      ]
    },
    strike,
    strike,
    close
  )
  const pas = plateAppearances(plays, teams, known)

  it('records the outs, the runners and the first pitch each began with', function () {
    expect(pas.map(state)).deep.equals([
      {
        batterGumboId: 101,
        outsBefore: 0,
        onFirst: false,
        onSecond: false,
        onThird: false,
        firstPitch: 'inPlay'
      },
      {
        batterGumboId: 102,
        outsBefore: 0,
        onFirst: true,
        onSecond: false,
        onThird: false,
        firstPitch: 'ball'
      },
      {
        batterGumboId: 103,
        outsBefore: 0,
        onFirst: false,
        onSecond: true,
        onThird: false,
        firstPitch: 'strike'
      },
      {
        batterGumboId: 104,
        outsBefore: 1,
        onFirst: false,
        onSecond: true,
        onThird: false,
        firstPitch: 'ball'
      },
      {
        batterGumboId: 105,
        outsBefore: 1,
        onFirst: true,
        onSecond: true,
        onThird: false,
        firstPitch: 'strike'
      }
    ])
    expect(pas.every(pa => pa.pitcherGumboId === PITCHER)).equals(true)
    expect(pas.every(pa => pa.battingTeamId === TEAMS.away.id)).equals(true)
    expect(pas.every(pa => pa.pitchingTeamId === TEAMS.home.id)).equals(true)
    expect(pas.map(pa => pa.pitches)).deep.equals([1, 2, 3, 4, 3])
  })

  it('counts each one as the game’s lines do, so their sums are the lines', function () {
    const result = gameStatLines(plays, teams, known)
    if (result.kind !== 'lines') throw new Error(result.detail)
    for (const line of result.lines) {
      const mine = pas.filter(pa => pa.batterGumboId === line.gumboId)
      const sum = (key: keyof PlateAppearance): number =>
        mine.reduce((total, pa) => total + Number(pa[key]), 0)
      expect(
        {
          pa: mine.length,
          ab: sum('ab'),
          h: sum('h'),
          singles: sum('singles'),
          doubles: sum('doubles'),
          bb: sum('bb'),
          k: sum('k'),
          rbi: sum('rbi')
        },
        String(line.gumboId)
      ).deep.equals({
        pa: line.pa,
        ab: line.ab,
        h: line.h,
        singles: line.singles,
        doubles: line.doubles,
        bb: line.bb,
        k: line.k,
        rbi: line.rbi
      })
    }
    const pitched = pas.filter(pa => pa.pitcherGumboId === PITCHER)
    const pitcher = result.lines.find(line => line.gumboId === PITCHER)
    expect(pitched.length).equals(pitcher?.pitch_bf)
    expect(pitched.reduce((n, pa) => n + pa.k, 0)).equals(pitcher?.pitch_k)
  })

  it('gives each pitcher his outs, a runner caught stealing and a change mid plate appearance included, as his line does', function () {
    const toMound = (player: number, position: 'P' | 'SS'): ScoringAction => ({
      type: 'lineup',
      kind: 'position',
      side: 'home',
      position,
      player
    })
    const strikeout = [strike, strike, strike, close]
    const changed = scored(
      ...hit('single'),
      close,
      ball,
      {
        type: 'baseRunning',
        kind: 'caught_stealing',
        runner: 101,
        to: '2B',
        fielders: [202, 205]
      },
      toMound(205, 'P'),
      toMound(201, 'SS'),
      ...strikeout,
      ...strikeout
    )
    const rows = plateAppearances(changed, teams, known)
    const result = gameStatLines(changed, teams, known)
    if (result.kind !== 'lines') throw new Error(result.detail)
    for (const line of result.lines) {
      const pitched = rows.filter(row => row.pitcherGumboId === line.gumboId)
      const batted = rows.filter(row => row.batterGumboId === line.gumboId)
      const sum = (
        mine: PlateAppearance[],
        key: keyof PlateAppearance
      ): number => mine.reduce((total, row) => total + Number(row[key]), 0)
      expect(
        {
          bf: pitched.filter(row => row.isPa).length,
          outs: sum(pitched, 'outsMade'),
          k: sum(pitched, 'k'),
          bb: sum(pitched, 'bb'),
          pa: batted.length,
          ab: sum(batted, 'ab'),
          h: sum(batted, 'h')
        },
        String(line.gumboId)
      ).deep.equals({
        bf: line.pitch_bf,
        outs: line.pitch_outs,
        k: line.pitch_k,
        bb: line.pitch_bb,
        pa: line.pa,
        ab: line.ab,
        h: line.h
      })
    }
    // The caught stealing is a row of outs alone, the starter's, made with
    // nobody out and the runner on first.
    expect(
      rows
        .filter(row => !row.isPa && row.outsMade > 0)
        .map(row => [
          row.pitcherGumboId,
          row.outsMade,
          row.outsBefore,
          row.onFirst
        ])
    ).deep.equals([[201, 1, 0, true]])
  })

  it('gives each pitcher the pitches of an inning ended by a caught stealing mid-count, as his line does', function () {
    const strikeout = [strike, strike, strike, close]
    const ended = scored(
      ...strikeout,
      ...strikeout,
      ...hit('single'),
      close,
      ball,
      strike,
      {
        type: 'baseRunning',
        kind: 'caught_stealing',
        runner: 103,
        to: '2B',
        fielders: [202, 205]
      }
    )
    const rows = plateAppearances(ended, teams, known)
    const result = expandedGameStatLines(ended, teams, known)
    if (result.kind !== 'lines') throw new Error(result.detail)
    const pitcher = result.lines.find(line => line.gumboId === PITCHER)
    expect(pitcher?.extra.pitches).equals(9)
    expect(
      rows
        .filter(row => row.pitcherGumboId === PITCHER)
        .reduce((total, row) => total + row.pitchesThrown, 0)
    ).equals(pitcher?.extra.pitches)
    // The caught stealing's pitches are the pitcher's, on no plate
    // appearance: neither the batter's pitches nor a first pitch.
    expect(
      rows
        .filter(row => !row.isPa && row.pitchesThrown > 0)
        .map(row => [
          row.pitcherGumboId,
          row.batterGumboId,
          row.pitches,
          row.pitchesThrown,
          row.firstPitchThrown
        ])
    ).deep.equals([[PITCHER, null, 0, 2, null]])
  })

  it('gives a pinch hitter’s run batted in to him, and the strikeout to the man he replaced', function () {
    const [play] = scored(...hit('single'), close)
    const rows = rowsOf(
      [play],
      [
        {
          playIndex: 0,
          atBatIndex: 0,
          inning: 1,
          halfInning: 'top',
          outsBefore: 1,
          battingTeamId: TEAMS.away.id,
          pitchingTeamId: TEAMS.home.id,
          eventType: 'strikeout',
          isPa: true,
          isAb: true,
          batterId: 103,
          hitterId: 110,
          pitcherId: PITCHER,
          outs: [{ pitcherId: PITCHER, outs: 1 }],
          rbi: 1,
          pitcherAt: () => PITCHER
        }
      ]
    )
    expect(
      rows.map(row => [
        row.isPa,
        row.batterGumboId,
        row.k,
        row.rbi,
        row.outsMade
      ])
    ).deep.equals([
      [true, 103, 1, 0, 1],
      [false, 110, 0, 1, 0]
    ])
  })

  it('puts a placed runner on base before the plate appearance, and gives each pitch to its thrower', function () {
    const [play] = scored(...hit('single'), close)
    const runner = (
      id: number,
      start: string | null,
      end: string
    ): Record<string, unknown> => ({
      movement: { start, end, isOut: false },
      details: { runner: { id } }
    })
    const tiebreak: GumboPlay = {
      ...play,
      matchup: { ...play.matchup, batter: { id: 104 } },
      runners: [runner(109, null, '2B'), runner(104, null, '1B')],
      playEvents: [
        { index: 0, isPitch: true, details: { isBall: true } },
        { index: 1, isPitch: true, details: { isStrike: true } },
        { index: 2, isPitch: true, details: { isInPlay: true } }
      ]
    }
    const charge: ChargedPlay = {
      playIndex: 0,
      atBatIndex: 0,
      inning: 7,
      halfInning: 'top',
      outsBefore: 0,
      battingTeamId: TEAMS.away.id,
      pitchingTeamId: TEAMS.home.id,
      eventType: 'single',
      isPa: true,
      isAb: true,
      batterId: 104,
      hitterId: 104,
      pitcherId: 205,
      outs: [],
      rbi: 0,
      // The starter threw the first two pitches; the reliever, the third.
      pitcherAt: index => (index < 2 ? PITCHER : 205)
    }
    const rows = rowsOf([tiebreak], [charge])
    expect(
      rows.map(row => [
        row.isPa,
        row.pitcherGumboId,
        row.onSecond,
        row.firstPitch,
        row.pitches,
        row.firstPitchThrown,
        row.pitchesThrown
      ])
    ).deep.equals([
      [true, 205, true, 'ball', 3, null, 1],
      [false, PITCHER, true, null, 0, 'ball', 2]
    ])
    // Recorded plays that begin part way into the game: who was on base in
    // that half is not known, nor how many were out.
    const late = rowsOf(
      [{ ...tiebreak, about: { ...tiebreak.about, atBatIndex: 5 } }],
      [charge]
    )
    expect([
      late[0].outsBefore,
      late[0].onFirst,
      late[0].onSecond,
      late[0].onThird
    ]).deep.equals([null, null, null, null])
  })

  it('follows a runner with no id or name who moves twice in one play', function () {
    const anonymous = (
      start: string | null,
      end: string | null
    ): Record<string, unknown> => ({
      movement: { start, end, isOut: false },
      details: { runner: {} }
    })
    const after = basesAfter(new Map([['1B', 'entry:0']]), {
      runners: [anonymous('1B', '2B'), anonymous('2B', '3B')]
    } as unknown as GumboPlay)
    expect([...after.keys()]).deep.equals(['3B'])
  })

  it('starts each half with nobody on and nobody out', function () {
    const next = plateAppearances(
      scored(
        ...hit('single'),
        close,
        strike,
        strike,
        strike,
        close,
        strike,
        strike,
        strike,
        close,
        strike,
        strike,
        strike,
        close,
        // The home side's first batter, to the visitors' center fielder.
        { type: 'ballInPlay', contact: 'swing', fielder: 108 },
        { type: 'result', eventType: 'single' },
        close
      ),
      teams,
      known
    )
    const last = next.at(-1)!
    expect(state(last)).deep.equals({
      batterGumboId: 201,
      outsBefore: 0,
      onFirst: false,
      onSecond: false,
      onThird: false,
      firstPitch: 'inPlay'
    })
    expect(last.battingTeamId).equals(TEAMS.home.id)
    expect(last.pitchingTeamId).equals(TEAMS.away.id)
  })

  it('leaves out a play with no half, and knows a pitch it cannot read as other', function () {
    const [first] = scored(...hit('single'), close)
    const unread: GumboPlay = {
      ...first,
      playEvents: [{ isPitch: true, details: {} }]
    }
    const nowhere: GumboPlay = {
      ...first,
      about: { ...first.about, inning: null }
    }
    const pitchless: GumboPlay = { ...first, playEvents: undefined }
    expect(
      plateAppearances([unread], teams, known).map(pa => pa.firstPitch)
    ).deep.equals(['other'])
    expect(plateAppearances([nowhere], teams, known)).deep.equals([])
    expect(
      plateAppearances([pitchless], teams, known).map(pa => [
        pa.firstPitch,
        pa.pitches
      ])
    ).deep.equals([[null, 0]])
    // A game whose plays name somebody TeamStation does not know builds no
    // lines, and so no plate appearances either.
    expect(plateAppearances([first], teams, new Set())).deep.equals([])
  })
})
