import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { after, F, game, TEAMS } from '../../test/scoringGames'
import { asCurrentPlay, asGumboPlay, type GumboPlay } from '../gumboPlay'
import type { ScoringAction } from './actions'
import { applyAction } from './apply'
import { comparablePlay } from './comparable'
import {
  FINAL_INDEX,
  foldCurrentPlay,
  foldFinal,
  foldPlay,
  recordOf,
  replayPlays,
  type Segment,
  segmentAfter
} from './gumbo'
import {
  halfOutcomes,
  leftOnBase,
  lineScore,
  ordinal,
  withHalfOuts
} from './linescore'
import { newSetup } from './lineup'
import { copyState, type GameState, setupOf } from './state'

/**
 * Scores a list of actions the way a session does: each completed play is
 * folded with the setup before its first action and the actions that made
 * it, and whatever is left is the current play.
 */
function score(
  start: GameState,
  actions: ScoringAction[]
): {
  state: GameState
  plays: GumboPlay[]
  current: ReturnType<typeof foldCurrentPlay>
} {
  let state = start
  let segment: Segment = { setupBefore: setupOf(start), actions: [] }
  const plays: GumboPlay[] = []
  for (const action of actions) {
    const applied = applyAction(state, action)
    expect(applied.problems, JSON.stringify(action)).deep.equals([])
    const split = segmentAfter(state, action, applied, segment)
    for (const { play, segment: done } of split.finished)
      plays.push(
        foldPlay(applied.state, play, {
          ...done,
          startTime: '2026-09-25T10:00:00Z'
        })
      )
    segment = split.current
    if (applied.state.final) {
      plays.push(foldFinal(applied.state, segment))
      segment = { setupBefore: setupOf(applied.state), actions: [] }
    }
    state = applied.state
  }
  return {
    state,
    plays,
    current: foldCurrentPlay(state, state.liveData.plays.currentPlay, segment)
  }
}

interface Credited {
  eventType: string
  label: string
}
function credited(play: GumboPlay): Credited[] {
  return (play.credits ?? []) as unknown as Credited[]
}
function labels(play: GumboPlay): string[] {
  return credited(play).map(credit => credit.label)
}

const context = { gamePk: 'g1', teams: TEAMS, setup: setupOf(game()) }

function rostered(): GameState {
  const setup = newSetup(TEAMS, {
    away: Array.from({ length: 9 }, (_, i) => ({
      userId: 5000 + i,
      shortName: `Away ${i + 1}`
    })),
    home: Array.from({ length: 8 }, (_, i) => ({
      userId: 6000 + i,
      shortName: `Home ${i + 1}`
    }))
  })
  return after(game(), { type: 'lineup', kind: 'roster', setup })
}

const inning: ScoringAction[] = [
  { type: 'pitch', call: 'B' },
  {
    type: 'ballInPlay',
    contact: 'swing',
    fielder: 14,
    launchAngle: 12,
    location: { x: 3, z: -50 }
  },
  { type: 'result', eventType: 'single' },
  { type: 'lineup', kind: 'batterSide', batSide: 'L' },
  { type: 'pitch', call: 'C' },
  { type: 'ballInPlay', contact: 'swing', fielder: 14 },
  { type: 'result', eventType: 'field_out' },
  {
    type: 'runnerMovement',
    runner: 2,
    to: '1B',
    out: true,
    fielders: [14, 12]
  },
  {
    type: 'runnerMovement',
    runner: 1,
    to: '2B',
    out: true,
    fielders: [14, 13]
  },
  { type: 'pitch', call: 'S' },
  { type: 'pitch', call: 'S' },
  { type: 'pitch', call: 'S' },
  { type: 'gameFlow', kind: 'closePlay' }
]

describe('folding a play for the server', function () {
  it('names every player by user id, and one made up at the field by name alone', function () {
    const start = rostered()
    const scored = score(start, inning.slice(0, 3))
    const current = scored.current as unknown as {
      about: unknown
      matchup: {
        batter: { id?: number; fullName: string }
        pitcher: { id?: number }
      }
      runners: Array<{
        details: { runner: { id?: number } }
        credits: Array<{ player: { id?: number } }>
      }>
    }
    expect(current.about).includes({ isComplete: false, atBatIndex: 0 })
    expect(current).not.to.have.property('result')
    expect(current.matchup.batter).deep.equals({ id: 5000, fullName: 'Away 1' })
    expect(current.matchup.pitcher).deep.equals({
      id: 6000,
      fullName: 'Home 1'
    })
    // The home side had eight: the ninth, playing right field, was made up.
    const madeUp = start.liveData.boxscore.teams.home.defense.RF!
    expect(start.gameData.players[madeUp].userId).equals(null)
    const folded = foldCurrentPlay(
      start,
      {
        ...copyState(start.liveData.plays.currentPlay!),
        matchup: {
          ...start.liveData.plays.currentPlay!.matchup,
          pitcher: { id: madeUp, fullName: 'Player 9' }
        }
      },
      { setupBefore: setupOf(start), actions: [] }
    )
    expect(
      (folded as unknown as { matchup: { pitcher: unknown } }).matchup.pitcher
    ).deep.equals({ fullName: 'Player 9' })
    expect(asCurrentPlay(scored.current)).deep.equals(scored.current)
  })

  it('folds a completed play Gumbo accepts, with its setup, its actions and its credits', function () {
    const scored = score(rostered(), [
      ...inning.slice(0, 3),
      { type: 'pitch', call: 'B' }
    ])
    const [single] = scored.plays
    expect(asGumboPlay(copyState(single))).deep.equals(single)
    expect(single.about).includes({
      atBatIndex: 0,
      isComplete: true,
      startTime: '2026-09-25T10:00:00Z'
    })
    expect(single.result).includes({ eventType: 'single', event: 'Single' })
    const record = recordOf(single)!
    expect(record.actions).deep.equals(inning.slice(0, 3))
    expect(record.setupBefore.sides.away.battingIndex).equals(0)
    expect(single.credits).deep.equals([
      {
        eventType: 'single',
        label: 'Single: Away 1',
        teamId: 'away',
        creditUserId: 5000,
        credit: { name: 'Away 1', role: 'batter', position: null }
      }
    ])
    const runner = (
      single.runners as unknown as Array<{ credits: unknown[] }>
    )[0]
    expect(runner.credits).deep.equals([
      {
        player: { id: 6004, fullName: 'Home 5' },
        position: {
          code: '6',
          name: 'Shortstop',
          type: 'Infielder',
          abbreviation: 'SS'
        },
        credit: 'f_fielded_ball'
      }
    ])
  })

  it('credits the fielders on an out, the pitcher on a strikeout, and a runner who scored', function () {
    const scored = score(game(), inning)
    const [, dp, k] = scored.plays
    expect(dp.result.eventType).equals('grounded_into_double_play')
    expect(labels(dp)).deep.equals([
      'Out at 1st: Player 3 (1B) from Player 5 (SS)',
      'Out at 2nd: Player 4 (2B) from Player 5 (SS)'
    ])
    expect(labels(k)).deep.equals(['Strikeout: Player 1'])
    const hr = score(game(), [
      { type: 'result', eventType: 'home_run' },
      { type: 'gameFlow', kind: 'closePlay' }
    ]).plays[0]
    expect(credited(hr).map(c => c.eventType)).deep.equals(['home_run', 'run'])
    expect(hr.about.isScoringPlay).equals(true)
    const steal = score(game(), [
      { type: 'result', eventType: 'single' },
      { type: 'pitch', call: 'B' },
      { type: 'baseRunning', kind: 'steal', runner: 1 },
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' },
      { type: 'gameFlow', kind: 'closePlay' }
    ]).plays[1]
    expect(labels(steal)).deep.equals([
      'Walk: Player 2',
      'Stolen base: Player 1'
    ])
  })

  it('ends the game with its final score at index 9999', function () {
    const scored = score(game(), [
      { type: 'result', eventType: 'home_run' },
      { type: 'gameFlow', kind: 'endGame' }
    ])
    const final = scored.plays.at(-1)!
    expect(final.about.atBatIndex).equals(FINAL_INDEX)
    expect(final.result).includes({
      eventType: 'final_score',
      awayScore: 1,
      homeScore: 0
    })
    expect(recordOf(final)!.actions).deep.equals([
      { type: 'gameFlow', kind: 'endGame' }
    ])
  })

  it('folds the place of an appearance whose batter is on base', function () {
    const state = game()
    state.liveData.plays.currentPlay = null
    const folded = foldCurrentPlay(state, null, {
      setupBefore: setupOf(state),
      actions: []
    })
    expect(folded.about).deep.equals({
      atBatIndex: 0,
      inning: 1,
      halfInning: 'top',
      isTopInning: true,
      isComplete: false,
      hasOut: false,
      hasReview: false
    })
  })
})

describe('reading a game back', function () {
  it('rebuilds the state the actions made, including the at-bat in progress', function () {
    const actions = [
      ...inning.slice(0, 9),
      { type: 'pitch', call: 'B' } as const
    ]
    const scored = score(game(), actions)
    const replayed = replayPlays(
      { plays: scored.plays, currentPlay: scored.current },
      context
    )
    expect(replayed.problems).deep.equals([])
    expect(replayed.state).deep.equals(scored.state)
    expect(replayed.derived).equals(0)
    expect(replayed.segments.map(s => s.actions.length)).deep.equals([3, 6, 1])
  })

  it('applies a substitution once, and keeps the order where the game left it', function () {
    let state = game()
    const actions: ScoringAction[] = []
    const push = (...more: ScoringAction[]): void => {
      actions.push(...more)
    }
    push(
      { type: 'result', eventType: 'single' },
      { type: 'result', eventType: 'single' }
    )
    push(
      { type: 'lineup', kind: 'addPlayer', side: 'away', name: 'Pinch' },
      {
        type: 'lineup',
        kind: 'substitute',
        side: 'away',
        player: 19,
        replaces: 3
      },
      { type: 'result', eventType: 'single' },
      { type: 'pitch', call: 'C' }
    )
    const scored = score(state, actions)
    state = scored.state
    const replayed = replayPlays(
      { plays: scored.plays, currentPlay: scored.current },
      context
    )
    expect(replayed.state).deep.equals(state)
    const away = replayed.state.liveData.boxscore.teams.away
    expect(away.battingOrder.filter(id => id === 19)).length(1)
    expect(away.battingOrder).not.to.include(3)
    expect(replayed.state.liveData.linescore.offense.batter!.id).equals(4)
  })

  it('rebuilds a lineup set before the first pitch from the current play alone', function () {
    const scored = score(game(), [
      {
        type: 'lineup',
        kind: 'battingOrder',
        side: 'away',
        order: [9, 8, 7, 6, 5, 4, 3, 2, 1]
      },
      {
        type: 'lineup',
        kind: 'battingOrder',
        side: 'away',
        order: [2, 1, 3, 4, 5, 6, 7, 8, 9]
      }
    ])
    expect(scored.plays).length(0)
    const replayed = replayPlays(
      { plays: [], currentPlay: scored.current },
      context
    )
    expect(replayed.state.liveData.boxscore.teams.away.battingOrder[0]).equals(
      2
    )
  })

  it('takes what the server writes on a play in its stride', function () {
    const scored = score(game(), inning)
    const stored = withHalfOuts(scored.plays).map(play => {
      const copy = copyState(play) as GumboPlay & { source?: unknown }
      copy.credits = copy.credits?.map(credit => ({
        ...credit,
        teamId: 'team-away'
      }))
      delete copy.source
      return copy
    })
    expect(stored.at(-1)!.about.halfOuts).equals(3)
    const replayed = replayPlays(
      { plays: stored, currentPlay: scored.current },
      context
    )
    expect(replayed.state).deep.equals(scored.state)
    expect(stored.map(comparablePlay)).deep.equals(
      scored.plays.map(comparablePlay)
    )
  })

  it('reopens a play an undo took back, from the current play', function () {
    const scored = score(game(), [
      { type: 'pitch', call: 'B' },
      { type: 'result', eventType: 'double' },
      { type: 'pitch', call: 'B' }
    ])
    // Undo back into play 0: its completed row stays until it closes again.
    const reopened = score(game(), [
      { type: 'pitch', call: 'B' },
      { type: 'result', eventType: 'double' }
    ])
    const replayed = replayPlays(
      { plays: scored.plays, currentPlay: reopened.current },
      context
    )
    expect(replayed.state.liveData.plays.allPlays).length(0)
    expect(replayed.state.pending?.outcome).equals('Double')
    expect(replayed.segments).deep.equals([
      {
        atBatIndex: 0,
        actions: [
          { type: 'pitch', call: 'B' },
          { type: 'result', eventType: 'double' }
        ]
      }
    ])
  })

  it('rebuilds plays scored elsewhere from their documents, and marks the game derived', function () {
    const setup = newSetup(TEAMS, {
      away: Array.from({ length: 9 }, (_, i) => ({
        userId: 7000 + i,
        shortName: `A${i}`
      })),
      home: Array.from({ length: 9 }, (_, i) => ({
        userId: 8000 + i,
        shortName: `H${i}`
      }))
    })
    // A GameStation document whose record cannot be replayed still lists
    // every runner, with Gumbo's bases or the numbers older ones stored.
    const documents = (gameStation: boolean): GumboPlay[] => {
      const doc = (
        atBatIndex: number,
        batter: number,
        eventType: string,
        outs: number,
        runners: Array<{ id: number; end: string | number; isOut?: boolean }>,
        away = 0
      ): GumboPlay =>
        asGumboPlay({
          about: { atBatIndex, inning: 1, halfInning: 'top' },
          result: { eventType, awayScore: away, homeScore: 0 },
          count: { outs },
          matchup: { batter: { id: batter } },
          runners: runners.map(runner => ({
            details: { runner: { id: runner.id } },
            movement: { end: runner.end, isOut: runner.isOut ?? false }
          })),
          ...(gameStation ? { gameStation: { version: 1 } } : {})
        })
      return [
        doc(0, 7000, 'single', 0, [{ id: 7000, end: '1B' }]),
        doc(1, 7001, 'double', 0, [
          { id: 7000, end: '3B' },
          { id: 7001, end: 2 }
        ]),
        doc(3, 7002, 'field_out', 1, [{ id: 7002, end: '1B', isOut: true }], 1)
      ]
    }
    const context = { gamePk: 'g1', teams: TEAMS, setup }
    const plays = documents(true)
    const replayed = replayPlays({ plays, currentPlay: null }, context)
    const state = replayed.state
    expect(replayed.derived).equals(3)
    expect(state.meta.derived).equals(true)
    expect(state.liveData.linescore.outs).equals(1)
    expect(state.liveData.linescore.teams.away.runs).equals(1)
    expect(state.liveData.linescore.offense.first).equals(null)
    expect(state.liveData.linescore.offense.second!.id).equals(2)
    expect(state.liveData.linescore.offense.third!.id).equals(1)
    expect(state.liveData.linescore.offense.batter!.id).equals(4)
    expect(state.liveData.plays.currentPlay!.about.atBatIndex).equals(4)

    // An imported game gives the score, the outs and the next batter, and
    // leaves the bases for the scorer to set.
    const imported = replayPlays(
      { plays: documents(false), currentPlay: null },
      context
    ).state.liveData.linescore
    expect([imported.outs, imported.teams.away.runs]).deep.equals([1, 1])
    const offense = imported.offense
    expect([offense.first, offense.second, offense.third]).deep.equals([
      null,
      null,
      null
    ])
    expect(imported.offense.batter!.id).equals(4)

    // Scoring carries on from there with the lineup the first scored play kept.
    const next = score(state, [{ type: 'pitch', call: 'B' }])
    const carried = replayPlays({ plays, currentPlay: next.current }, context)
    expect(carried.derived).equals(3)
    expect(carried.state.liveData.linescore.balls).equals(1)
  })

  it('moves to the next half after an imported third out', function () {
    const setup = setupOf(game())
    const plays = [0, 1, 2].map(i =>
      asGumboPlay({
        about: {
          atBatIndex: i,
          inning: 1,
          halfInning: 'top',
          halfOuts: i === 2 ? 3 : undefined
        },
        result: { eventType: 'strikeout' },
        count: { outs: i + 1 }
      })
    )
    const replayed = replayPlays(
      { plays, currentPlay: null },
      { gamePk: 'g1', teams: TEAMS, setup }
    )
    expect(replayed.state.liveData.linescore.isTopInning).equals(false)
    const bottom = replayPlays(
      {
        plays: [
          ...plays,
          ...[3, 4, 5].map(i =>
            asGumboPlay({
              about: { atBatIndex: i, inning: 1, halfInning: 'bottom' },
              result: { eventType: 'strikeout' },
              count: { outs: i - 2 }
            })
          )
        ],
        currentPlay: null
      },
      { gamePk: 'g1', teams: TEAMS, setup }
    )
    expect(bottom.state.liveData.linescore.currentInning).equals(2)
  })

  it('stops at an action that no longer applies', function () {
    const scored = score(game(), [{ type: 'pitch', call: 'B' }])
    const broken = copyState(scored.current) as unknown as {
      gameStation: { actions: unknown[] }
    }
    broken.gameStation.actions.push({
      type: 'fieldingPlay',
      fielders: [F.SS],
      error: F.SS
    })
    const replayed = replayPlays(
      { plays: [], currentPlay: asCurrentPlay(broken) },
      context
    )
    expect(replayed.problems[0].message).equals(
      'No error is waiting to be charged'
    )
    expect(replayed.segments[0].actions).length(1)
  })

  it('ignores a record it cannot read', function () {
    expect(recordOf(null)).equals(null)
    expect(recordOf({})).equals(null)
    expect(recordOf({ gameStation: { version: 2 } })).equals(null)
    expect(
      recordOf({
        gameStation: {
          version: 1,
          setupBefore: setupOf(game()),
          actions: [{ type: 'nope' }]
        }
      })
    ).equals(null)
  })
})

describe('the line score from documents', function () {
  it('counts halves, hits and errors from completed plays', function () {
    const scored = score(game(), [
      { type: 'result', eventType: 'home_run' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' },
      { type: 'result', eventType: 'double' },
      { type: 'pitch', call: 'B' }
    ])
    const plays = withHalfOuts(scored.plays)
    const halves = halfOutcomes(plays)
    expect(halves).deep.equals([
      { inning: 1, half: 'top', awayScore: 1, homeScore: 0, outs: 3, runs: 1 },
      {
        inning: 1,
        half: 'bottom',
        awayScore: 1,
        homeScore: 0,
        outs: 0,
        runs: 0
      }
    ])
    const line = lineScore(plays, halves, 1, 0)
    expect(line.away).deep.equals({
      runs: [1],
      r: 1,
      h: 1,
      e: 0,
      bb: 0,
      k: 3,
      hr: 1,
      hbp: 0
    })
    expect(line.home).includes({ r: 0, h: 1 })
  })

  describe("Gumbo's innings and teams (U20)", function () {
    const walk: ScoringAction[] = [
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'B' }
    ]
    const strikeout: ScoringAction[] = [
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'C' }
    ]
    // Top 1st: two walks, then three strikeouts leave two on. Bottom 1st: a
    // home run, a single, three strikeouts.
    // Top 2nd: an override puts a runner on third, a home run, three
    // strikeouts.
    const actions: ScoringAction[] = [
      ...walk,
      ...walk,
      ...strikeout,
      ...strikeout,
      ...strikeout,
      { type: 'result', eventType: 'home_run' },
      { type: 'result', eventType: 'single' },
      ...strikeout,
      ...strikeout,
      ...strikeout,
      { type: 'gameFlow', kind: 'override', bases: [null, null, 1] },
      { type: 'result', eventType: 'home_run' },
      ...strikeout,
      ...strikeout,
      ...strikeout,
      // Opens the bottom of the 2nd, so the third strikeout is a completed play.
      { type: 'pitch', call: 'B' }
    ]
    const scored = (list = actions): GumboPlay[] =>
      withHalfOuts(score(game(), list).plays)
    const lineOf = (plays: GumboPlay[]): ReturnType<typeof lineScore> => {
      const last = plays[plays.length - 1]
      return lineScore(
        plays,
        halfOutcomes(plays),
        last.result.awayScore ?? null,
        last.result.homeScore ?? null
      )
    }

    it('sums its innings to the totals, beside the old fields unchanged', function () {
      const line = lineOf(scored())
      expect(line.away).deep.equals({
        runs: [0, 2],
        r: 2,
        h: 1,
        e: 0,
        bb: 2,
        k: 6,
        hr: 1,
        hbp: 0
      })
      expect(line.home).deep.equals({
        runs: [1],
        r: 1,
        h: 2,
        e: 0,
        bb: 0,
        k: 3,
        hr: 1,
        hbp: 0
      })
      expect(line.innings).deep.equals([
        {
          num: 1,
          ordinalNum: '1st',
          home: { runs: 1, hits: 2, errors: 0, leftOnBase: 1 },
          away: { runs: 0, hits: 0, errors: 0, leftOnBase: 2 }
        },
        {
          num: 2,
          ordinalNum: '2nd',
          // The bottom of the 2nd was never played: no runs, as MLB has it.
          home: { hits: 0, errors: 0, leftOnBase: 0 },
          away: { runs: 2, hits: 1, errors: 0, leftOnBase: null }
        }
      ])
      for (const which of ['away', 'home'] as const) {
        const sum = (key: 'runs' | 'hits' | 'errors'): number =>
          line.innings.reduce(
            (total, inning) => total + (inning[which][key] ?? 0),
            0
          )
        expect(sum('runs')).equals(line.teams[which].runs)
        expect(sum('hits')).equals(line.teams[which].hits)
        expect(sum('errors')).equals(line.teams[which].errors)
        expect(line.teams[which].runs).equals(line[which].r)
        expect(line.teams[which].hits).equals(line[which].h)
        expect(line.teams[which].errors).equals(line[which].e)
      }
      // A half with an override leaves the side's total unknown too.
      expect(line.teams).deep.equals({
        home: { runs: 1, hits: 2, errors: 0, leftOnBase: 1 },
        away: { runs: 2, hits: 1, errors: 0, leftOnBase: null }
      })
    })

    it("has the feed's keys and value types", function () {
      const feed = JSON.parse(
        readFileSync('src2/common/gumbo/reference/feed776258.json', 'utf8')
      ) as {
        liveData: {
          linescore: {
            innings: Array<Record<string, unknown>>
            teams: Record<string, Record<string, unknown>>
          }
        }
      }
      const shape = (value: unknown): unknown =>
        value != null && typeof value === 'object'
          ? Object.fromEntries(
              Object.entries(value)
                .map(([key, item]) => [key, shape(item)])
                .sort(([a], [b]) => String(a).localeCompare(String(b)))
            )
          : typeof value
      // The 1st inning alone, which has no override.
      const line = lineOf(
        scored([...actions.slice(0, 28), { type: 'pitch', call: 'B' }])
      )
      expect(line.innings).to.have.length(1)
      expect(shape(line.innings[0])).deep.equals(
        shape(feed.liveData.linescore.innings[0])
      )
      expect(shape(line.teams)).deep.equals(
        shape(feed.liveData.linescore.teams)
      )
    })

    it('counts runners left only on halves GameStation scored whole', function () {
      const plays = scored()
      // The top of the 1st as an import sends it: no record.
      const imported = plays.map(play =>
        play.about.inning === 1 && play.about.halfInning === 'top'
          ? (({ gameStation: _, ...rest }) => rest)(play)
          : play
      )
      const line = lineOf(imported)
      expect(line.innings[0].away.leftOnBase).equals(null)
      expect(line.innings[0].home.leftOnBase).equals(1)
      expect(line.teams.away.leftOnBase).equals(null)
      // The unplayed bottom of the 2nd is unknown once any play is imported.
      expect(line.innings[1].home.leftOnBase).equals(null)
      expect(line.teams.home.leftOnBase).equals(null)
      expect(leftOnBase([])).equals(0)
    })

    // Imported plays as an import sends them: no record.
    const imported = (
      atBatIndex: number,
      eventType: string,
      about: { inning: number | null; halfInning: 'top' | 'bottom' | null },
      awayScore: number,
      homeScore: number
    ): GumboPlay =>
      asGumboPlay({
        about: { atBatIndex, ...about },
        result: { eventType, awayScore, homeScore },
        runners: []
      })

    it('has no innings and no runners left for a game with only its final score', function () {
      const plays = [
        imported(0, 'final_score', { inning: null, halfInning: null }, 18, 9)
      ]
      const line = lineScore(plays, halfOutcomes(plays), 18, 9)
      expect(line.innings).deep.equals([])
      expect(line.teams).deep.equals({
        home: { runs: 9, hits: null, errors: null, leftOnBase: null },
        away: { runs: 18, hits: null, errors: null, leftOnBase: null }
      })
      expect(line.away.runs).deep.equals([18])
      expect(line.home.runs).deep.equals([9])
    })

    it("keeps a partial game's totals from its score and its innings from the halves it has", function () {
      // Only the top of the 1st was recorded, and it scored 4 of 13.
      const top = { inning: 1, halfInning: 'top' as const }
      const plays = [
        imported(0, 'walk', top, 0, 0),
        imported(1, 'single', top, 4, 0),
        imported(2, 'strikeout', top, 4, 0)
      ]
      const line = lineScore(plays, halfOutcomes(plays), 13, 4)
      expect(line.teams.away.runs).equals(13)
      expect(line.teams.home.runs).equals(4)
      expect(line.innings).deep.equals([
        {
          num: 1,
          ordinalNum: '1st',
          home: { hits: 0, errors: 0, leftOnBase: null },
          away: { runs: 13, hits: 1, errors: 0, leftOnBase: null }
        }
      ])
      expect(line.teams.away.leftOnBase).equals(null)
      expect(line.teams.home.leftOnBase).equals(null)
    })

    it('names innings as MLB does', function () {
      expect(
        [1, 2, 3, 4, 9, 10, 11, 12, 13, 21, 22, 23, 101, 111].map(ordinal)
      ).deep.equals([
        '1st',
        '2nd',
        '3rd',
        '4th',
        '9th',
        '10th',
        '11th',
        '12th',
        '13th',
        '21st',
        '22nd',
        '23rd',
        '101st',
        '111th'
      ])
    })
  })
})
