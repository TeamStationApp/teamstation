import { readFileSync } from 'node:fs'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asGumboPlay, type GumboPlay } from '../gumboPlay'
import { recordOf, replayPlays, type TeamStationRecord } from './gumbo'
import {
  type ImportedContext,
  importedRecords,
  importedSetup
} from './importedRecord'
import type { RosterPlayer } from './lineup'
import type { GameState, Side } from './state'

/**
 * Invented games, written as an outside scorer posts them: Gumbo plays with
 * timed events and runners, and no record. The visitors are 1–9, batting in
 * that order; the hosts are 11–19, and 10 and 20 pitch. 21 and 22 come off
 * the visitors' bench, 23 off the hosts'.
 */
const TEAMS = {
  away: { id: 'team-away', name: 'Visitors', logoUrl: null },
  home: { id: 'team-home', name: 'Hosts', logoUrl: null }
}
const AWAY_PITCHER = 20
const HOME_PITCHER = 10

function roster(ids: number[]): RosterPlayer[] {
  return ids.map(id => ({
    gumboId: id,
    shortName: `Player ${id}`,
    jersey: String(id)
  }))
}
const ROSTERS: Record<Side, RosterPlayer[]> = {
  away: roster([1, 2, 3, 4, 5, 6, 7, 8, 9, 20, 21, 22]),
  home: roster([11, 12, 13, 14, 15, 16, 17, 18, 19, 10, 23, 24])
}

let clock = Date.parse('2026-05-02T18:00:00.000Z')
function at(): string {
  clock += 10_000
  return new Date(clock).toISOString()
}

type Event = Record<string, unknown>

function eventsOf(item: GumboPlay): Event[] {
  const events: unknown = item.playEvents
  return Array.isArray(events) ? (events as Event[]) : []
}

/** A pitch as the importer writes one: its code, its call, and its flags. */
function pitch(code: string, extra: Event = {}): Event {
  const strike = ['C', 'S', 'F', 'T', 'L', 'M', 'W'].includes(code)
  return {
    isPitch: true,
    type: 'pitch',
    startTime: at(),
    details: {
      code,
      call: { code },
      isStrike: strike,
      isBall: ['B', 'I', 'V', 'H'].includes(code),
      isInPlay: ['X', 'D', 'E'].includes(code)
    },
    ...extra
  }
}

/** A pitch as earlier imports stored one: only its codes. */
function legacy(code: string): Event {
  return {
    isPitch: true,
    type: 'pitch',
    startTime: at(),
    details: { code, call: { code } }
  }
}

function action(details: Event, extra: Event = {}): Event {
  return { isPitch: false, type: 'action', startTime: at(), details, ...extra }
}

interface Runner {
  id: number
  start?: string | null
  end?: string | null
  out?: boolean
  outBase?: string | null
  event?: string
  credits?: Array<{ player: number; position: string }>
}

function runner(spec: Runner): Event {
  return {
    movement: {
      start: spec.start ?? null,
      end: spec.out === true ? null : (spec.end ?? null),
      isOut: spec.out === true,
      outBase: spec.out === true ? (spec.outBase ?? '1B') : null
    },
    details: {
      runner: { id: spec.id },
      eventType: spec.event ?? 'single'
    },
    credits: (spec.credits ?? []).map(credit => ({
      player: { id: credit.player },
      position: { abbreviation: credit.position }
    }))
  }
}

interface PlaySpec {
  index: number
  inning?: number
  half?: 'top' | 'bottom'
  batter: number
  pitcher?: number
  eventType: string
  outs: number
  away?: number
  home?: number
  events: Event[]
  runners?: Event[]
  balls?: number
  strikes?: number
}

function play(spec: PlaySpec): GumboPlay {
  const half = spec.half ?? 'top'
  return asGumboPlay({
    about: {
      atBatIndex: spec.index,
      inning: spec.inning ?? 1,
      halfInning: half,
      isComplete: true,
      startTime: (spec.events[0]?.startTime as string | undefined) ?? at()
    },
    result: {
      eventType: spec.eventType,
      event: spec.eventType,
      awayScore: spec.away ?? 0,
      homeScore: spec.home ?? 0,
      rbi: 0
    },
    count: {
      balls: spec.balls ?? 0,
      strikes: spec.strikes ?? 0,
      outs: spec.outs
    },
    matchup: {
      batter: { id: spec.batter },
      pitcher: {
        id: spec.pitcher ?? (half === 'top' ? HOME_PITCHER : AWAY_PITCHER)
      }
    },
    runners: spec.runners ?? [],
    playEvents: spec.events.map((event, index) => ({ index, ...event }))
  })
}

function context(plays: GumboPlay[], final = false): ImportedContext {
  return {
    gamePk: 'gam_invented',
    teams: TEAMS,
    setup: importedSetup(plays, ROSTERS, TEAMS),
    final
  }
}

interface Converted {
  records: Map<number, TeamStationRecord>
  corrections: Array<{ atBatIndex: number; notes: string[] }>
  state: GameState
  stored: GumboPlay[]
}

/**
 * Converts the plays, stores each record on its play, and replays the game
 * as the scoring screen and the server do.
 */
function convert(plays: GumboPlay[], final = false): Converted {
  const ctx = context(plays, final)
  const out = importedRecords({ plays, currentPlay: null }, ctx)
  const stored = plays.map(item => ({
    ...item,
    teamStation: out.records.get(item.about.atBatIndex) ?? item.teamStation
  })) as GumboPlay[]
  const replayed = replayPlays({ plays: stored, currentPlay: null }, ctx)
  expect(replayed.problems, 'replay problems').deep.equals([])
  expect(replayed.derived, 'derived plays').equals(0)
  return { ...out, state: replayed.state, stored }
}

/** Every stored play's score, outs, batter and pitcher, replayed. */
function expectReproduced(plays: GumboPlay[], state: GameState): void {
  const all = state.liveData.plays.allPlays
  for (const item of plays) {
    const replayed = all[item.about.atBatIndex]
    const label = `play ${item.about.atBatIndex}`
    expect(replayed, label).not.equals(undefined)
    expect(
      {
        away: replayed.result.awayScore,
        home: replayed.result.homeScore,
        outs: replayed.count.outs,
        batter: replayed.matchup.batter.id,
        pitcher: replayed.matchup.pitcher.id
      },
      label
    ).deep.equals({
      away: item.result.awayScore,
      home: item.result.homeScore,
      outs: item.count?.outs,
      batter: item.matchup?.batter?.id,
      pitcher: item.matchup?.pitcher?.id
    })
  }
}

function pitchesOf(state: GameState): Record<string, number> {
  return {
    ...state.liveData.boxscore.teams.away.pitchCounts,
    ...state.liveData.boxscore.teams.home.pitchCounts
  }
}

/** The pitches each pitcher threw, counted from the stored events. */
function storedPitches(plays: GumboPlay[]): Record<string, number> {
  const out: Record<string, number> = {}
  for (const item of plays)
    for (const event of eventsOf(item)) {
      if (event.isPitch !== true) continue
      const id = String(item.matchup?.pitcher?.id)
      out[id] = (out[id] ?? 0) + 1
    }
  return out
}

const out1B = (id: number, position = 'SS'): Event =>
  runner({
    id,
    out: true,
    outBase: '1B',
    event: 'field_out',
    credits: [
      { player: position === 'SS' ? 16 : 12, position },
      { player: 13, position: '1B' }
    ]
  })

/** Three up, three down: a walk, a strikeout and two outs on the ground. */
function halfInning(): GumboPlay[] {
  return [
    play({
      index: 0,
      batter: 1,
      eventType: 'walk',
      outs: 0,
      balls: 4,
      events: [
        pitch('B'),
        pitch('C'),
        pitch('B'),
        pitch('S'),
        pitch('B'),
        pitch('B')
      ],
      runners: [runner({ id: 1, end: '1B', event: 'walk' })]
    }),
    play({
      index: 1,
      batter: 2,
      eventType: 'strikeout',
      outs: 1,
      strikes: 3,
      events: [pitch('C'), pitch('F'), pitch('F'), pitch('F'), pitch('S')],
      runners: [runner({ id: 2, out: true, event: 'strikeout' })]
    }),
    play({
      index: 2,
      batter: 3,
      eventType: 'force_out',
      outs: 2,
      events: [
        pitch('B'),
        pitch('X', { hitData: { trajectory: 'ground_ball' } })
      ],
      runners: [
        runner({
          id: 1,
          start: '1B',
          out: true,
          outBase: '2B',
          event: 'force_out',
          credits: [
            { player: 16, position: 'SS' },
            { player: 14, position: '2B' }
          ]
        }),
        runner({ id: 3, end: '1B', event: 'force_out' })
      ]
    }),
    play({
      index: 3,
      batter: 4,
      eventType: 'field_out',
      outs: 3,
      events: [pitch('X', { hitData: { trajectory: 'ground_ball' } })],
      runners: [out1B(4)]
    })
  ]
}

describe('records for imported plays', function () {
  it('converts a half inning that replays to every stored play', function () {
    const plays = halfInning()
    const converted = convert(plays)
    expect(converted.records.size).equals(4)
    expect(converted.corrections).deep.equals([])
    expectReproduced(plays, converted.state)
    expect(pitchesOf(converted.state)).deep.equals(storedPitches(plays))
    const state = converted.state
    expect(state.liveData.linescore.isTopInning).equals(false)
    // The visitors bat the four they have, and come round to the first.
    expect(state.liveData.boxscore.teams.away.battingIndex).equals(0)
  })

  it('reads a legacy event with codes and no flags as the flagged one', function () {
    const flagged = halfInning()
    const bare = halfInning().map(item => ({
      ...item,
      playEvents: eventsOf(item).map(event => {
        const { details, ...rest } = event
        const { code } = details as { code: string }
        return { ...rest, details: { code, call: { code } } }
      })
    })) as GumboPlay[]
    const a = convert(flagged)
    const b = convert(bare)
    expect([...b.records.values()].map(r => r.actions)).deep.equals(
      [...a.records.values()].map(r => r.actions)
    )
    expect(pitchesOf(b.state)).deep.equals(storedPitches(bare))
  })

  it('keeps two-strike fouls at two, and ends at a foul tip or foul bunt', function () {
    const plays = [
      play({
        index: 0,
        batter: 1,
        eventType: 'strikeout',
        outs: 1,
        events: [
          pitch('C'),
          pitch('S'),
          pitch('F'),
          pitch('F'),
          pitch('R'),
          pitch('T')
        ],
        runners: [runner({ id: 1, out: true, event: 'strikeout' })]
      }),
      play({
        index: 1,
        batter: 2,
        eventType: 'strikeout',
        outs: 2,
        events: [pitch('C'), pitch('C'), pitch('L')],
        runners: [runner({ id: 2, out: true, event: 'strikeout' })]
      }),
      play({
        index: 2,
        batter: 3,
        eventType: 'strikeout',
        outs: 3,
        events: [legacy('S'), legacy('W'), legacy('O')],
        runners: [runner({ id: 3, out: true, event: 'strikeout' })]
      })
    ]
    const converted = convert(plays)
    expect(converted.corrections).deep.equals([])
    expectReproduced(plays, converted.state)
    const calls = converted.records
      .get(0)
      ?.actions.flatMap(a => (a.type === 'pitch' ? [a.call] : []))
    expect(calls).deep.equals(['C', 'S', 'F', 'F', 'F', 'T'])
    expect(pitchesOf(converted.state)).deep.equals(storedPitches(plays))
  })

  it('awards first for a hit batter, an intentional walk and interference', function () {
    const plays = [
      play({
        index: 0,
        batter: 1,
        eventType: 'hit_by_pitch',
        outs: 0,
        events: [pitch('B'), pitch('H')],
        runners: [runner({ id: 1, end: '1B', event: 'hit_by_pitch' })]
      }),
      play({
        index: 1,
        batter: 2,
        eventType: 'intent_walk',
        outs: 0,
        events: [],
        runners: [
          runner({ id: 2, end: '1B', event: 'intent_walk' }),
          runner({ id: 1, start: '1B', end: '2B', event: 'intent_walk' })
        ]
      }),
      play({
        index: 2,
        batter: 3,
        eventType: 'catcher_interf',
        outs: 0,
        events: [pitch('B')],
        runners: [
          runner({ id: 3, end: '1B', event: 'catcher_interf' }),
          runner({ id: 2, start: '1B', end: '2B', event: 'catcher_interf' }),
          runner({ id: 1, start: '2B', end: '3B', event: 'catcher_interf' })
        ]
      })
    ]
    const converted = convert(plays)
    expectReproduced(plays, converted.state)
    expect(converted.state.liveData.linescore.offense.third?.id).equals(1)
    const results = [...converted.records.values()].flatMap(r =>
      r.actions.flatMap(a => (a.type === 'result' ? [a.eventType] : []))
    )
    expect(results).deep.equals([
      'hit_by_pitch',
      'intent_walk',
      'catcher_interference'
    ])
  })

  it('moves runners on hits, outs, errors and home runs as stored', function () {
    const plays = [
      play({
        index: 0,
        batter: 1,
        eventType: 'single',
        outs: 0,
        events: [pitch('X', { hitData: { trajectory: 'line_drive' } })],
        runners: [
          runner({
            id: 1,
            end: '1B',
            credits: [{ player: 18, position: 'CF' }]
          })
        ]
      }),
      play({
        index: 1,
        batter: 2,
        eventType: 'double',
        outs: 0,
        away: 1,
        events: [
          pitch('B'),
          pitch('D', { hitData: { trajectory: 'fly_ball' } })
        ],
        runners: [
          runner({ id: 2, end: '2B', event: 'double' }),
          runner({ id: 1, start: '1B', end: 'score', event: 'double' })
        ]
      }),
      play({
        index: 2,
        batter: 3,
        eventType: 'field_error',
        outs: 0,
        away: 1,
        events: [pitch('X', { hitData: { trajectory: 'ground_ball' } })],
        runners: [
          runner({
            id: 3,
            end: '1B',
            event: 'field_error',
            credits: [{ player: 16, position: 'SS' }]
          }),
          runner({ id: 2, start: '2B', end: '3B', event: 'field_error' })
        ]
      }),
      play({
        index: 3,
        batter: 4,
        eventType: 'fielders_choice_out',
        outs: 1,
        away: 1,
        events: [pitch('X', { hitData: { trajectory: 'ground_ball' } })],
        runners: [
          runner({
            id: 3,
            start: '1B',
            out: true,
            outBase: '2B',
            event: 'fielders_choice_out',
            credits: [
              { player: 15, position: '3B' },
              { player: 14, position: '2B' }
            ]
          }),
          runner({ id: 4, end: '1B', event: 'fielders_choice_out' })
        ]
      }),
      play({
        index: 4,
        batter: 5,
        eventType: 'home_run',
        outs: 1,
        away: 4,
        events: [pitch('E', { hitData: { trajectory: 'fly_ball' } })],
        runners: [
          runner({ id: 5, end: 'score', event: 'home_run' }),
          runner({ id: 4, start: '1B', end: 'score', event: 'home_run' }),
          runner({ id: 2, start: '3B', end: 'score', event: 'home_run' })
        ]
      }),
      play({
        index: 5,
        batter: 6,
        eventType: 'grounded_into_double_play',
        outs: 3,
        away: 4,
        events: [
          pitch('S'),
          pitch('X', { hitData: { trajectory: 'ground_ball' } })
        ],
        runners: []
      })
    ]
    // A double play needs a runner: the sixth batter comes up with one on.
    plays[5] = play({
      index: 5,
      batter: 6,
      eventType: 'single',
      outs: 1,
      away: 4,
      events: [pitch('X', { hitData: { trajectory: 'ground_ball' } })],
      runners: [runner({ id: 6, end: '1B' })]
    })
    plays.push(
      play({
        index: 6,
        batter: 7,
        eventType: 'grounded_into_double_play',
        outs: 3,
        away: 4,
        events: [pitch('X', { hitData: { trajectory: 'ground_ball' } })],
        runners: [
          runner({
            id: 6,
            start: '1B',
            out: true,
            outBase: '2B',
            event: 'grounded_into_double_play',
            credits: [
              { player: 16, position: 'SS' },
              { player: 14, position: '2B' }
            ]
          }),
          runner({
            id: 7,
            out: true,
            outBase: '1B',
            event: 'grounded_into_double_play',
            credits: [
              { player: 14, position: '2B' },
              { player: 13, position: '1B' }
            ]
          })
        ]
      })
    )
    const converted = convert(plays)
    expectReproduced(plays, converted.state)
    expect(converted.state.liveData.linescore.teams.away.runs).equals(4)
    expect(pitchesOf(converted.state)).deep.equals(storedPitches(plays))
  })

  it('takes steals, pickoffs, wild pitches and balks between pitches', function () {
    const plays = [
      play({
        index: 0,
        batter: 1,
        eventType: 'single',
        outs: 0,
        events: [pitch('X', { hitData: { trajectory: 'line_drive' } })],
        runners: [runner({ id: 1, end: '1B' })]
      }),
      play({
        index: 1,
        batter: 2,
        eventType: 'strikeout',
        outs: 1,
        events: [
          pitch('B'),
          action(
            { code: 'stolen_base', eventType: 'stolen_base_2b' },
            { index: 1, isBaseRunningPlay: true }
          ),
          pitch('C'),
          pitch('B'),
          action(
            { code: 'wild_pitch', eventType: 'wild_pitch' },
            { index: 4, isBaseRunningPlay: true }
          ),
          pitch('S'),
          pitch('S')
        ].map((event, index) => ({ ...event, index })),
        runners: [
          {
            ...runner({
              id: 1,
              start: '1B',
              end: '2B',
              event: 'stolen_base_2b'
            }),
            details: {
              runner: { id: 1 },
              eventType: 'stolen_base_2b',
              playIndex: 1
            }
          },
          {
            ...runner({ id: 1, start: '2B', end: '3B', event: 'wild_pitch' }),
            details: {
              runner: { id: 1 },
              eventType: 'wild_pitch',
              playIndex: 4
            }
          },
          runner({ id: 2, out: true, event: 'strikeout' })
        ]
      }),
      play({
        index: 2,
        batter: 3,
        eventType: 'walk',
        outs: 1,
        away: 1,
        events: [
          action(
            { code: 'balk', eventType: 'balk' },
            { index: 0, isBaseRunningPlay: true }
          ),
          pitch('B'),
          pitch('B'),
          pitch('B'),
          pitch('B')
        ].map((event, index) => ({ ...event, index })),
        runners: [
          {
            ...runner({ id: 1, start: '3B', end: 'score', event: 'balk' }),
            details: { runner: { id: 1 }, eventType: 'balk', playIndex: 0 }
          },
          runner({ id: 3, end: '1B', event: 'walk' })
        ]
      }),
      play({
        index: 3,
        batter: 4,
        eventType: 'strikeout',
        outs: 3,
        away: 1,
        events: [
          action(
            { code: 'pickoff_1b', eventType: 'pickoff_1b' },
            { index: 0, isBaseRunningPlay: true }
          ),
          pitch('C'),
          pitch('C'),
          pitch('C')
        ].map((event, index) => ({ ...event, index })),
        runners: [
          {
            ...runner({
              id: 3,
              start: '1B',
              out: true,
              outBase: '1B',
              event: 'pickoff_1b',
              credits: [
                { player: 10, position: 'P' },
                { player: 13, position: '1B' }
              ]
            }),
            details: {
              runner: { id: 3 },
              eventType: 'pickoff_1b',
              playIndex: 0
            }
          },
          runner({ id: 4, out: true, event: 'strikeout' })
        ]
      })
    ]
    const converted = convert(plays)
    expectReproduced(plays, converted.state)
    expect(converted.corrections).deep.equals([])
    const kinds = [...converted.records.values()].flatMap(r =>
      r.actions.flatMap(a =>
        a.type === 'baseRunning' || a.type === 'batteryEvent' ? [a.kind] : []
      )
    )
    expect(kinds).deep.equals(['steal', 'wild_pitch', 'balk', 'pickoff'])
  })

  it('changes pitchers, pinch hitters and pinch runners', function () {
    const plays = [
      play({
        index: 0,
        batter: 1,
        eventType: 'single',
        outs: 0,
        events: [pitch('X', { hitData: { trajectory: 'line_drive' } })],
        runners: [runner({ id: 1, end: '1B' })]
      }),
      play({
        index: 1,
        batter: 21,
        pitcher: 23,
        eventType: 'strikeout',
        outs: 1,
        events: [
          action(
            {
              code: 'pitching_substitution',
              eventType: 'pitching_substitution'
            },
            {
              isSubstitution: true,
              player: { id: 23 },
              replacedPlayer: { id: 10 },
              position: { abbreviation: 'P' }
            }
          ),
          action(
            {
              code: 'offensive_substitution',
              eventType: 'offensive_substitution'
            },
            {
              isSubstitution: true,
              player: { id: 21 },
              replacedPlayer: { id: 2 }
            }
          ),
          action(
            {
              code: 'offensive_substitution',
              eventType: 'offensive_substitution'
            },
            {
              isSubstitution: true,
              player: { id: 22 },
              replacedPlayer: { id: 1 }
            }
          ),
          pitch('C'),
          pitch('C'),
          pitch('C')
        ],
        runners: [runner({ id: 21, out: true, event: 'strikeout' })]
      }),
      play({
        index: 2,
        batter: 3,
        pitcher: 23,
        eventType: 'single',
        outs: 1,
        events: [pitch('X', { hitData: { trajectory: 'line_drive' } })],
        runners: [
          runner({ id: 3, end: '1B' }),
          runner({ id: 22, start: '1B', end: '2B' })
        ]
      })
    ]
    const converted = convert(plays)
    expectReproduced(plays, converted.state)
    expect(converted.corrections).deep.equals([])
    const home = converted.state.liveData.boxscore.teams.home
    expect(home.defense.P).equals(23)
    expect(
      converted.state.liveData.boxscore.teams.away.battingOrder.slice(0, 2)
    ).deep.equals([22, 21])
    expect(converted.state.liveData.linescore.offense.second?.id).equals(22)
  })

  it('takes the scorer’s overrides and halves ended by hand', function () {
    const plays = [
      play({
        index: 0,
        batter: 1,
        eventType: 'strikeout',
        outs: 2,
        events: [
          action({ code: 'override', eventType: 'game_advisory', outs: 1 }),
          pitch('C'),
          pitch('C'),
          pitch('C')
        ],
        runners: [runner({ id: 1, out: true, event: 'strikeout' })]
      }),
      play({
        index: 1,
        batter: 2,
        eventType: 'single',
        outs: 2,
        events: [
          pitch('X', { hitData: { trajectory: 'line_drive' } }),
          action({ code: 'end_half', eventType: 'game_advisory' })
        ],
        runners: [runner({ id: 2, end: '1B' })]
      }),
      play({
        index: 2,
        half: 'bottom',
        batter: 11,
        eventType: 'single',
        outs: 0,
        events: [pitch('X', { hitData: { trajectory: 'line_drive' } })],
        runners: [runner({ id: 11, end: '1B' })]
      })
    ]
    const converted = convert(plays)
    expectReproduced(plays, converted.state)
    const flows = [...converted.records.values()].flatMap(r =>
      r.actions.flatMap(a => (a.type === 'gameFlow' ? [a.kind] : []))
    )
    expect(flows).to.include('override')
  })

  it('corrects a play the engine cannot reproduce, and reports it', function () {
    const plays = [
      play({
        index: 0,
        batter: 1,
        eventType: 'single',
        outs: 0,
        events: [pitch('X', { hitData: { trajectory: 'line_drive' } })],
        runners: [runner({ id: 1, end: '1B' })]
      }),
      play({
        index: 1,
        batter: 2,
        eventType: 'strikeout',
        outs: 1,
        events: [pitch('C'), pitch('C'), pitch('C')],
        // A runner on second nobody put there.
        runners: [
          runner({ id: 2, out: true, event: 'strikeout' }),
          runner({ id: 7, start: '2B', end: '2B', event: 'strikeout' })
        ]
      }),
      play({
        index: 2,
        batter: 3,
        eventType: 'strikeout',
        outs: 2,
        events: [pitch('C'), pitch('C'), pitch('C')],
        runners: [runner({ id: 3, out: true, event: 'strikeout' })]
      })
    ]
    const converted = convert(plays)
    expectReproduced(plays, converted.state)
    expect(converted.state.liveData.linescore.offense.second?.id).equals(7)
    expect(converted.corrections).deep.equals([
      { atBatIndex: 1, notes: ['after: bases'] }
    ])
  })

  it('finishes a play whose own actions are refused, and keeps the game going', function () {
    const plays = [
      play({
        index: 0,
        batter: 1,
        eventType: 'batter_interference',
        outs: 1,
        events: [
          pitch('B'),
          pitch('X', { hitData: { trajectory: 'ground_ball' } })
        ],
        runners: [out1B(1)]
      }),
      play({
        index: 1,
        batter: 2,
        eventType: 'strikeout',
        outs: 2,
        events: [pitch('C'), pitch('C'), pitch('C')],
        runners: [runner({ id: 2, out: true, event: 'strikeout' })]
      })
    ]
    const converted = convert(plays)
    expect(converted.corrections[0].atBatIndex).equals(0)
    expect(converted.corrections[0].notes.join()).to.match(
      /result batter_interference/
    )
    expect(converted.state.liveData.linescore.outs).equals(2)
  })

  it('times each action from its event, and the rest from the one before', function () {
    const plays = halfInning()
    const converted = convert(plays)
    const first = converted.records.get(0)
    expect(first?.actionTimes).to.have.length(first?.actions.length ?? -1)
    expect(first?.actionTimes?.[0]).equals(eventsOf(plays[0])[0].startTime)
    const untimed = halfInning().map(item => ({
      ...item,
      about: { ...item.about, startTime: undefined },
      playEvents: eventsOf(item).map(event => {
        const { startTime: _gone, ...rest } = event
        return rest
      })
    })) as unknown as GumboPlay[]
    const bare = convert(untimed)
    expect(bare.records.get(0)?.actionTimes).equals(undefined)
  })

  it('ends a final game with its last converted play', function () {
    const converted = convert(halfInning(), true)
    expect(converted.records.get(3)?.actions.at(-1)).deep.equals({
      type: 'gameFlow',
      kind: 'endGame'
    })
    expect(converted.state.final).equals(true)
  })

  it('continues from recorded plays, and leaves their records as they are', function () {
    const plays = halfInning()
    const first = convert(plays.slice(0, 2))
    const stored = [...first.stored, ...plays.slice(2)]
    const ctx = context(plays)
    const again = importedRecords({ plays: stored, currentPlay: null }, ctx)
    expect([...again.records.keys()]).deep.equals([2, 3])
    const whole = [
      ...first.stored,
      ...plays.slice(2).map(item => ({
        ...item,
        teamStation: again.records.get(item.about.atBatIndex)
      }))
    ] as GumboPlay[]
    const replayed = replayPlays({ plays: whole, currentPlay: null }, ctx)
    expect(replayed.problems).deep.equals([])
    expectReproduced(plays, replayed.state)
    // Converting the same plays again writes the same records.
    const twice = importedRecords({ plays: stored, currentPlay: null }, ctx)
    expect([...twice.records]).deep.equals([...again.records])
    // A game whose plays all hold records gets none.
    expect(
      importedRecords({ plays: whole, currentPlay: null }, ctx).records.size
    ).equals(0)
  })

  it('joins a converted prefix to the scored record after it', function () {
    const plays = halfInning()
    const converted = convert(plays)
    // The scorer took over at the hosts' half with his own lineup.
    const scoredSetup = structuredClone(converted.state.liveData.boxscore.teams)
    scoredSetup.home.battingOrder = [12, 11, 13, 14, 15, 16, 17, 18, 19]
    scoredSetup.home.battingIndex = 0
    scoredSetup.away.defense.P = AWAY_PITCHER
    const setup = {
      players: structuredClone(converted.state.gameData.players),
      sides: scoredSetup,
      tagOrder: [...converted.state.meta.tagOrder]
    }
    const scored = asGumboPlay({
      ...play({
        index: 4,
        half: 'bottom',
        batter: 12,
        eventType: 'strikeout',
        outs: 1,
        events: [],
        runners: []
      }),
      teamStation: {
        version: 2,
        setupBefore: setup,
        actions: [
          { type: 'pitch', call: 'C' },
          { type: 'pitch', call: 'C' },
          { type: 'pitch', call: 'C' },
          { type: 'gameFlow', kind: 'closePlay' }
        ]
      }
    })
    const ctx = context(plays)
    const out = importedRecords(
      { plays: [...plays, scored], currentPlay: null },
      ctx
    )
    const last = out.records.get(3)
    expect(
      last?.actions.slice(-2).map(a => `${a.type} ${'kind' in a ? a.kind : ''}`)
    ).deep.equals(['lineup roster', 'gameFlow override'])
    const whole = [
      ...plays.map(item => ({
        ...item,
        teamStation: out.records.get(item.about.atBatIndex)
      })),
      scored
    ] as GumboPlay[]
    const replayed = replayPlays({ plays: whole, currentPlay: null }, ctx)
    expect(replayed.problems).deep.equals([])
    expect(replayed.state.liveData.plays.allPlays[4].matchup.batter.id).equals(
      12
    )
    expect(recordOf(scored, TEAMS)).not.equals(null)
  })

  it('names nobody it was not told about, and writes a placeholder play as itself', function () {
    const plays = [
      ...halfInning(),
      asGumboPlay({
        about: {
          atBatIndex: 4,
          inning: 1,
          halfInning: 'bottom',
          isComplete: true
        },
        result: {
          eventType: 'score_correction',
          event: '',
          awayScore: 0,
          homeScore: 0,
          rbi: 0
        },
        count: { balls: 0, strikes: 0, outs: 0 },
        runners: [],
        playEvents: []
      })
    ]
    const ctx = context(plays)
    const out = importedRecords({ plays, currentPlay: null }, ctx)
    expect(out.corrections.at(-1)?.notes).to.include('no batter')
    expect(out.records.has(4)).equals(true)
  })
})

describe('the setup an imported game starts from', function () {
  it('bats each side in the order its batters first came up', function () {
    const plays = halfInning()
    const setup = importedSetup(plays, ROSTERS, TEAMS)
    expect(setup.sides.away.battingOrder).deep.equals([1, 2, 3, 4])
    expect(setup.sides.home.defense.P).equals(HOME_PITCHER)
    expect(setup.sides.home.defense.SS).equals(16)
    expect(setup.sides.away.players).to.include(21)
  })

  it('stops the order at nine, and slots a substitute in for his man', function () {
    const plays = Array.from({ length: 11 }, (_, index) =>
      play({
        index,
        batter: index < 9 ? index + 1 : 21,
        eventType: 'strikeout',
        outs: (index % 3) + 1,
        inning: Math.floor(index / 3) + 1,
        events: [],
        runners: []
      })
    )
    expect(
      importedSetup(plays, ROSTERS, TEAMS).sides.away.battingOrder
    ).deep.equals([1, 2, 3, 4, 5, 6, 7, 8, 9])
    const subbed = [
      play({
        index: 0,
        batter: 1,
        eventType: 'strikeout',
        outs: 1,
        events: []
      }),
      play({
        index: 1,
        batter: 21,
        eventType: 'strikeout',
        outs: 2,
        events: [
          action(
            { eventType: 'offensive_substitution' },
            {
              isSubstitution: true,
              player: { id: 21 },
              replacedPlayer: { id: 2 }
            }
          )
        ]
      }),
      play({ index: 2, batter: 3, eventType: 'strikeout', outs: 3, events: [] })
    ]
    expect(
      importedSetup(subbed, ROSTERS, TEAMS).sides.away.battingOrder
    ).deep.equals([1, 2, 3])
  })

  it('makes a player of everyone a play names, rosters or none', function () {
    const plays = [
      play({
        index: 0,
        batter: 91,
        pitcher: 92,
        eventType: 'strikeout',
        outs: 1,
        events: []
      })
    ]
    const setup = importedSetup(plays, { away: [], home: [] }, TEAMS)
    expect(setup.sides.away.players).deep.equals([91])
    expect(setup.sides.home.players).deep.equals([92])
    expect(setup.sides.home.defense.P).equals(92)
    expect(setup.players[91].teamId).equals('team-away')
  })
})

describe('an outside feed', function () {
  it('converts every play of the MLB reference feed to its stored score and outs', function () {
    const feed = JSON.parse(
      readFileSync('src/common/gumbo/reference/feed776258.json', 'utf8')
    ) as { liveData: { plays: { allPlays: unknown[] } } }
    const plays = feed.liveData.plays.allPlays.map(raw => asGumboPlay(raw))
    const ctx = {
      gamePk: 'gam_feed',
      teams: TEAMS,
      setup: importedSetup(plays, { away: [], home: [] }, TEAMS),
      final: true
    }
    const out = importedRecords({ plays, currentPlay: null }, ctx)
    expect(out.records.size).equals(77)
    const stored = plays.map(item => ({
      ...item,
      teamStation: out.records.get(item.about.atBatIndex)
    })) as GumboPlay[]
    const replayed = replayPlays({ plays: stored, currentPlay: null }, ctx)
    expect(replayed.problems).deep.equals([])
    expectReproduced(plays, replayed.state)
    expect(pitchesOf(replayed.state)).deep.equals(storedPitches(plays))
    expect(out.corrections.length).lessThan(4)
  })

  it('converts the importer’s invented game as GameChanger posts it', function () {
    const raw = JSON.parse(
      readFileSync(
        'src/common/scoring/fixtures/imported/inventedGame.json',
        'utf8'
      )
    ) as unknown[]
    const plays = raw.map(item => asGumboPlay(item))
    const converted = convert(plays, true)
    expect(converted.corrections).deep.equals([])
    expectReproduced(plays, converted.state)
    expect(pitchesOf(converted.state)).deep.equals(storedPitches(plays))
  })
})
