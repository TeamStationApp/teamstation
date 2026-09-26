import { expect } from 'chai'
import { readFileSync } from 'fs'
import { describe, it } from 'mocha'
import { join } from 'path'

import { eventTypeName, isGumboEventType } from '../../common/gumboEventTypes'
import type { GumboPlay } from '../../common/gumboPlay'
import { namedPlayerIds } from '../statsBuilder/builder'
import { gameStatLines, type PlayerGameLine } from './gumboStats'

const teams = { homeTeamId: 'home', awayTeamId: 'away' }
const known = new Set([
  1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 19
])

const scorebook = JSON.parse(
  readFileSync(join(__dirname, 'fixtures/scorebookGame.json'), 'utf8')
) as {
  plays: GumboPlay[]
  expected: PlayerGameLine[]
  finalScore: { away: number; home: number }
}

function emptyFigures(): Omit<PlayerGameLine, 'userId' | 'teamId'> {
  return {
    pa: 0,
    ab: 0,
    h: 0,
    singles: 0,
    doubles: 0,
    triples: 0,
    hr: 0,
    bb: 0,
    k: 0,
    r: 0,
    rbi: 0,
    hbp: 0,
    ci: 0,
    sf: 0,
    sh: 0,
    sb: 0,
    cs: 0,
    pitch_bf: 0,
    pitch_outs: 0,
    pitch_h: 0,
    pitch_hr: 0,
    pitch_bb: 0,
    pitch_hbp: 0,
    pitch_k: 0,
    pitch_r: 0,
    pitch_er: 0
  }
}

function line(
  userId: number,
  teamId: string | null,
  figures: Partial<Omit<PlayerGameLine, 'userId' | 'teamId'>>
): PlayerGameLine {
  return { userId, teamId, ...emptyFigures(), ...figures }
}

function paPlay(
  eventType: string,
  opts: {
    atBatIndex?: number
    inning?: number
    halfInning?: 'top' | 'bottom'
    batter?: number | null
    pitcher?: number | null
    outs?: number
    end?: '1B' | '2B' | '3B' | 'score' | null
    isOut?: boolean
    awayScore?: number | null
    homeScore?: number | null
    runners?: GumboPlay['runners']
    earned?: boolean
    rbi?: boolean
    responsiblePitcher?: number | null
    walkOwner?: number
    outPitcher?: number
  } = {}
): GumboPlay {
  const atBatIndex = opts.atBatIndex ?? 0
  const batter = opts.batter === undefined ? 1 : opts.batter
  const pitcher = opts.pitcher === undefined ? 11 : opts.pitcher
  const end =
    opts.end === undefined ? (opts.isOut === true ? null : '1B') : opts.end
  const isOut = opts.isOut === true || end == null
  const batterObj = batter == null ? {} : { id: batter }
  const pitcherObj = pitcher == null ? {} : { id: pitcher }

  const batterEntry: Record<string, unknown> = {
    movement: { start: null, end, isOut },
    details: {
      eventType,
      runner: batterObj,
      ...(opts.walkOwner != null
        ? { responsiblePitcher: { id: opts.walkOwner } }
        : {}),
      ...(opts.outPitcher != null ? { pitcher: { id: opts.outPitcher } } : {})
    }
  }
  if (end === 'score') {
    ;(batterEntry.details as Record<string, unknown>).responsiblePitcher = {
      id:
        opts.responsiblePitcher === undefined
          ? pitcher
          : opts.responsiblePitcher
    }
    ;(batterEntry.details as Record<string, unknown>).earned =
      opts.earned ?? true
    ;(batterEntry.details as Record<string, unknown>).rbi = opts.rbi ?? true
  }

  const play: GumboPlay = {
    about: {
      atBatIndex,
      inning: opts.inning ?? 1,
      halfInning: opts.halfInning ?? 'top'
    },
    result: {
      eventType,
      awayScore: opts.awayScore ?? null,
      homeScore: opts.homeScore ?? null
    },
    count: { outs: opts.outs ?? (isOut ? 1 : 0) },
    matchup: { batter: batterObj, pitcher: pitcherObj },
    runners: opts.runners ?? [batterEntry]
  }
  return play
}

describe('gameStatLines', function () {
  it('matches the scorebook fixture box score', function () {
    const result = gameStatLines(scorebook.plays, teams, known)
    expect(result).deep.equals({ kind: 'lines', lines: scorebook.expected })
  })

  it('counts each figures-table event type', function () {
    const cases: Array<{
      eventType: string
      batter?: Partial<Omit<PlayerGameLine, 'userId' | 'teamId'>>
      pitcher?: Partial<Omit<PlayerGameLine, 'userId' | 'teamId'>>
      play?: GumboPlay
    }> = [
      {
        eventType: 'single',
        batter: { pa: 1, ab: 1, h: 1, singles: 1 },
        pitcher: { pitch_bf: 1, pitch_h: 1, pitch_outs: 0 }
      },
      {
        eventType: 'double',
        batter: { pa: 1, ab: 1, h: 1, doubles: 1 },
        pitcher: { pitch_bf: 1, pitch_h: 1 },
        play: paPlay('double', { end: '2B' })
      },
      {
        eventType: 'triple',
        batter: { pa: 1, ab: 1, h: 1, triples: 1 },
        pitcher: { pitch_bf: 1, pitch_h: 1 },
        play: paPlay('triple', { end: '3B' })
      },
      {
        eventType: 'home_run',
        batter: { pa: 1, ab: 1, h: 1, hr: 1, r: 1, rbi: 1 },
        pitcher: {
          pitch_bf: 1,
          pitch_h: 1,
          pitch_hr: 1,
          pitch_r: 1,
          pitch_er: 1
        },
        play: paPlay('home_run', { end: 'score', awayScore: 1, homeScore: 0 })
      },
      {
        eventType: 'strikeout',
        batter: { pa: 1, ab: 1, k: 1 },
        pitcher: { pitch_bf: 1, pitch_k: 1, pitch_outs: 1 },
        play: paPlay('strikeout', { isOut: true, outs: 1 })
      },
      {
        eventType: 'walk',
        batter: { pa: 1, bb: 1 },
        pitcher: { pitch_bf: 1, pitch_bb: 1 }
      },
      {
        eventType: 'intent_walk',
        batter: { pa: 1, bb: 1 },
        pitcher: { pitch_bf: 1, pitch_bb: 1 }
      },
      {
        eventType: 'hit_by_pitch',
        batter: { pa: 1, hbp: 1 },
        pitcher: { pitch_bf: 1, pitch_hbp: 1 }
      },
      {
        eventType: 'field_out',
        batter: { pa: 1, ab: 1 },
        pitcher: { pitch_bf: 1, pitch_outs: 1 },
        play: paPlay('field_out', { isOut: true, outs: 1 })
      },
      {
        eventType: 'grounded_into_double_play',
        batter: { pa: 1, ab: 1 },
        pitcher: { pitch_bf: 1, pitch_outs: 2 },
        play: paPlay('grounded_into_double_play', {
          isOut: true,
          outs: 2,
          runners: [
            {
              movement: { start: '1B', end: null, isOut: true },
              details: {
                eventType: 'grounded_into_double_play',
                runner: { id: 2 }
              }
            },
            {
              movement: { start: null, end: null, isOut: true },
              details: {
                eventType: 'grounded_into_double_play',
                runner: { id: 1 }
              }
            }
          ]
        })
      },
      {
        eventType: 'triple_play',
        batter: { pa: 1, ab: 1 },
        pitcher: { pitch_bf: 1, pitch_outs: 3 },
        play: paPlay('triple_play', {
          isOut: true,
          outs: 3,
          runners: [
            {
              movement: { start: '2B', end: null, isOut: true },
              details: { eventType: 'triple_play', runner: { id: 2 } }
            },
            {
              movement: { start: '1B', end: null, isOut: true },
              details: { eventType: 'triple_play', runner: { id: 3 } }
            },
            {
              movement: { start: null, end: null, isOut: true },
              details: { eventType: 'triple_play', runner: { id: 1 } }
            }
          ]
        })
      },
      {
        eventType: 'field_error',
        batter: { pa: 1, ab: 1 },
        pitcher: { pitch_bf: 1 }
      },
      {
        eventType: 'fielders_choice',
        batter: { pa: 1, ab: 1 },
        pitcher: { pitch_bf: 1, pitch_outs: 1 },
        play: paPlay('fielders_choice', {
          outs: 1,
          runners: [
            {
              movement: { start: '1B', end: null, isOut: true },
              details: { eventType: 'fielders_choice', runner: { id: 2 } }
            },
            {
              movement: { start: null, end: '1B', isOut: false },
              details: { eventType: 'fielders_choice', runner: { id: 1 } }
            }
          ]
        })
      },
      {
        eventType: 'catcher_interference',
        batter: { pa: 1, ci: 1 },
        pitcher: { pitch_bf: 1 }
      },
      {
        eventType: 'sac_fly',
        batter: { pa: 1, sf: 1 },
        pitcher: { pitch_bf: 1, pitch_outs: 1 },
        play: paPlay('sac_fly', { isOut: true, outs: 1 })
      },
      {
        eventType: 'sac_bunt',
        batter: { pa: 1, sh: 1 },
        pitcher: { pitch_bf: 1, pitch_outs: 1 },
        play: paPlay('sac_bunt', { isOut: true, outs: 1 })
      },
      ...(
        [
          'force_out',
          'fielders_choice_out',
          'double_play',
          'grounded_into_triple_play',
          'batter_interference',
          'fan_interference',
          'gs_batter_out'
        ] as const
      ).map(eventType => ({
        eventType,
        batter: { pa: 1, ab: 1 },
        pitcher: { pitch_bf: 1, pitch_outs: 1 },
        play: paPlay(eventType, { isOut: true, outs: 1 })
      })),
      ...(
        [
          'strike_out',
          'strikeout_double_play',
          'strikeout_triple_play'
        ] as const
      ).map(eventType => ({
        eventType,
        batter: { pa: 1, ab: 1, k: 1 },
        pitcher: { pitch_bf: 1, pitch_k: 1, pitch_outs: 1 },
        play: paPlay(eventType, { isOut: true, outs: 1 })
      })),
      {
        eventType: 'catcher_interf',
        batter: { pa: 1, ci: 1 },
        pitcher: { pitch_bf: 1 }
      },
      {
        eventType: 'sac_fly_double_play',
        batter: { pa: 1, sf: 1 },
        pitcher: { pitch_bf: 1, pitch_outs: 2 },
        play: paPlay('sac_fly_double_play', { isOut: true, outs: 2 })
      },
      {
        eventType: 'sac_bunt_double_play',
        batter: { pa: 1, sh: 1 },
        pitcher: { pitch_bf: 1, pitch_outs: 2 },
        play: paPlay('sac_bunt_double_play', { isOut: true, outs: 2 })
      },
      {
        eventType: 'gs_manual_placement',
        batter: { pa: 1 },
        pitcher: { pitch_bf: 1 }
      }
    ]

    for (const row of cases) {
      const play = row.play ?? paPlay(row.eventType)
      const result = gameStatLines([play], teams, known)
      expect(result.kind, row.eventType).equals('lines')
      if (result.kind !== 'lines') continue
      expect(
        result.lines.find(l => l.userId === 1),
        row.eventType
      ).deep.equals(line(1, 'away', row.batter ?? {}))
      expect(
        result.lines.find(l => l.userId === 11),
        row.eventType
      ).deep.equals(line(11, 'home', row.pitcher ?? {}))
    }

    const steal: GumboPlay = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' as const },
      result: { eventType: 'stolen_base' },
      count: { outs: 0 },
      matchup: { pitcher: { id: 11 } },
      runners: [
        {
          movement: { start: '1B', end: '2B', isOut: false },
          details: { eventType: 'stolen_base_2b', runner: { id: 1 } }
        }
      ]
    }
    expect(gameStatLines([steal], teams, known)).deep.equals({
      kind: 'lines',
      lines: [line(1, 'away', { sb: 1 })]
    })

    const cs: GumboPlay = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' as const },
      result: { eventType: 'caught_stealing' },
      count: { outs: 1 },
      matchup: { pitcher: { id: 11 } },
      runners: [
        {
          movement: { start: '1B', end: null, isOut: true },
          details: { eventType: 'caught_stealing_2b', runner: { id: 1 } }
        }
      ]
    }
    expect(gameStatLines([cs], teams, known)).deep.equals({
      kind: 'lines',
      lines: [line(1, 'away', { cs: 1 }), line(11, 'home', { pitch_outs: 1 })]
    })

    for (const eventType of ['wild_pitch', 'passed_ball', 'balk'] as const) {
      const play: GumboPlay = {
        about: { atBatIndex: 0, inning: 1, halfInning: 'top' as const },
        result: { eventType },
        count: { outs: 0 },
        matchup: { pitcher: { id: 11 } },
        runners: [
          {
            movement: { start: '1B', end: '2B', isOut: false },
            details: { eventType, runner: { id: 1 } }
          }
        ]
      }
      expect(gameStatLines([play], teams, known), eventType).deep.equals({
        kind: 'lines',
        lines: []
      })
    }

    const pickoff: GumboPlay = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' as const },
      result: { eventType: 'other_out' },
      count: { outs: 1 },
      matchup: { pitcher: { id: 11 } },
      runners: [
        {
          movement: { start: '1B', end: null, isOut: true },
          details: { eventType: 'other_out', runner: { id: 1 } }
        }
      ]
    }
    expect(gameStatLines([pickoff], teams, known)).deep.equals({
      kind: 'lines',
      lines: [line(11, 'home', { pitch_outs: 1 })]
    })
  })

  it('puts batting and pitching on one line for the same player', function () {
    const bat = paPlay('single', { batter: 1, pitcher: 11 })
    const pitch = paPlay('strikeout', {
      atBatIndex: 1,
      halfInning: 'bottom',
      batter: 12,
      pitcher: 1,
      isOut: true,
      outs: 1
    })
    const result = gameStatLines([bat, pitch], teams, known)
    expect(result).deep.equals({
      kind: 'lines',
      lines: [
        line(1, 'away', {
          pa: 1,
          ab: 1,
          h: 1,
          singles: 1,
          pitch_bf: 1,
          pitch_k: 1,
          pitch_outs: 1
        }),
        line(11, 'home', { pitch_bf: 1, pitch_h: 1 }),
        line(12, 'home', { pa: 1, ab: 1, k: 1 })
      ]
    })
  })

  it('restarts pitch_outs each half and counts DP and TP outs', function () {
    const topOut = paPlay('field_out', {
      isOut: true,
      outs: 1,
      batter: 1,
      pitcher: 11
    })
    const bottomOut = paPlay('field_out', {
      atBatIndex: 1,
      halfInning: 'bottom',
      isOut: true,
      outs: 1,
      batter: 12,
      pitcher: 10
    })
    const topAgain = paPlay('field_out', {
      atBatIndex: 2,
      inning: 2,
      isOut: true,
      outs: 1,
      batter: 2,
      pitcher: 11
    })
    const result = gameStatLines([topOut, bottomOut, topAgain], teams, known)
    expect(result.kind).equals('lines')
    if (result.kind !== 'lines') return
    expect(result.lines.find(l => l.userId === 11)?.pitch_outs).equals(2)
    expect(result.lines.find(l => l.userId === 10)?.pitch_outs).equals(1)
  })

  it('gives an out entry with details.pitcher its own out', function () {
    const play: GumboPlay = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' as const },
      result: { eventType: 'other_out' },
      count: { outs: 2 },
      matchup: { pitcher: { id: 16 } },
      runners: [
        {
          movement: { start: '1B', end: null, isOut: true },
          details: {
            eventType: 'other_out',
            runner: { id: 1 },
            pitcher: { id: 11 }
          }
        },
        {
          movement: { start: '2B', end: null, isOut: true },
          details: { eventType: 'other_out', runner: { id: 2 } }
        }
      ]
    }
    const result = gameStatLines([play], teams, known)
    expect(result).deep.equals({
      kind: 'lines',
      lines: [
        line(11, 'home', { pitch_outs: 1 }),
        line(16, 'home', { pitch_outs: 1 })
      ]
    })
  })

  it('charges an unearned run to responsiblePitcher only', function () {
    const play = paPlay('single', {
      batter: 2,
      pitcher: 16,
      outs: 0,
      runners: [
        {
          movement: { start: '3B', end: 'score', isOut: false },
          details: {
            eventType: 'single',
            runner: { id: 1 },
            responsiblePitcher: { id: 11 },
            earned: false,
            rbi: true
          }
        },
        {
          movement: { start: null, end: '1B', isOut: false },
          details: { eventType: 'single', runner: { id: 2 } }
        }
      ],
      awayScore: 1,
      homeScore: 0
    })
    const result = gameStatLines([play], teams, known)
    expect(result).deep.equals({
      kind: 'lines',
      lines: [
        line(1, 'away', { r: 1 }),
        line(2, 'away', { pa: 1, ab: 1, h: 1, singles: 1, rbi: 1 }),
        line(11, 'home', { pitch_r: 1 }),
        line(16, 'home', { pitch_bf: 1, pitch_h: 1 })
      ]
    })
  })

  it('charges a walk and its batter faced to responsiblePitcher alone', function () {
    const withOwner = paPlay('walk', { walkOwner: 11, pitcher: 16 })
    expect(gameStatLines([withOwner], teams, known)).deep.equals({
      kind: 'lines',
      lines: [
        line(1, 'away', { pa: 1, bb: 1 }),
        line(11, 'home', { pitch_bf: 1, pitch_bb: 1 })
      ]
    })
    const without = paPlay('walk', { pitcher: 16 })
    expect(gameStatLines([without], teams, known)).deep.equals({
      kind: 'lines',
      lines: [
        line(1, 'away', { pa: 1, bb: 1 }),
        line(16, 'home', { pitch_bf: 1, pitch_bb: 1 })
      ]
    })
  })

  it('credits an out made before a pitching change to the pitcher on the mound at its event', function () {
    // Batter 1 singles off 11. Batter 2 bats to 16 after a change: 1 is
    // caught stealing at event 1, and 2 strikes out at event 5.
    const single = paPlay('single', { pitcher: 11 })
    const changedAt = (change: number, atBatIndex = 1): GumboPlay =>
      ({
        ...paPlay('strikeout', { atBatIndex, batter: 2, pitcher: 16, outs: 2 }),
        runners: [
          {
            movement: { start: '1B', end: null, isOut: true },
            details: {
              eventType: 'caught_stealing_2b',
              runner: { id: 1 },
              playIndex: 1
            }
          },
          {
            movement: { start: null, end: null, isOut: true },
            details: { eventType: 'strikeout', runner: { id: 2 }, playIndex: 5 }
          }
        ],
        playEvents: [
          {
            index: change,
            isPitch: false,
            type: 'action',
            details: { eventType: 'pitching_substitution' },
            player: { id: 16 }
          }
        ]
      }) as unknown as GumboPlay
    const outs = (plays: GumboPlay[]): number[][] => {
      const result = gameStatLines(plays, teams, known)
      if (result.kind !== 'lines') throw new Error(result.detail)
      return result.lines
        .filter(row => row.teamId === 'home')
        .map(row => [row.userId, row.pitch_outs, row.pitch_bf])
    }
    // Changed after the caught stealing: that out is the starter's.
    expect(outs([single, changedAt(2)])).deep.equals([
      [11, 1, 1],
      [16, 1, 1]
    ])
    // Changed before it, or between plate appearances: both are 16's.
    expect(outs([single, changedAt(0)])).deep.equals([
      [11, 0, 1],
      [16, 2, 1]
    ])
    // With no play before it, the play began with its own pitcher.
    expect(outs([changedAt(2, 0)])).deep.equals([[16, 2, 1]])
  })

  /** A plate appearance with its own events and runner entries. */
  const eventful = (
    play: GumboPlay,
    changes: Array<[index: number, player: Record<string, unknown>]>,
    runners: Array<[runner: number, eventType: string, playIndex: number]>
  ): GumboPlay => ({
    ...play,
    runners: runners.map(([runner, eventType, playIndex]) => ({
      movement: {
        start: runner === play.matchup?.batter?.id ? null : '1B',
        end: null,
        isOut: true
      },
      details: { eventType, runner: { id: runner }, playIndex }
    })),
    playEvents: changes.map(([index, player]) => ({
      index,
      isPitch: false,
      type: 'action',
      details: { eventType: 'pitching_substitution' },
      player
    }))
  })
  const pitched = (plays: GumboPlay[]): unknown[][] => {
    const result = gameStatLines(plays, teams, known)
    if (result.kind !== 'lines') throw new Error(result.detail)
    return result.lines
      .filter(row => row.pitch_bf > 0 || row.pitch_outs > 0)
      .map(row => [row.userId, row.teamId, row.pitch_outs, row.pitch_bf])
  }

  it('gives a reliever who leaves inside the plate appearance he entered in the outs he made', function () {
    // 16 relieves 11 and 1 is caught stealing off him; 17 relieves 16 and
    // strikes 2 out.
    const single = paPlay('single', { pitcher: 11 })
    const pa = paPlay('strikeout', {
      atBatIndex: 1,
      batter: 2,
      pitcher: 17,
      outs: 2
    })
    expect(
      pitched([
        single,
        eventful(
          pa,
          [
            [1, { id: 16 }],
            [3, { id: 17 }]
          ],
          [
            [1, 'caught_stealing_2b', 2],
            [2, 'strikeout', 6]
          ]
        )
      ])
    ).deep.equals([
      [11, 'home', 0, 1],
      [16, 'home', 1, 0],
      [17, 'home', 1, 1]
    ])
  })

  it('begins a half with the pitcher a change at its first event brings in', function () {
    // The visitors' 4 pitches the bottom of the 1st. Batting in the top of
    // the 2nd they put 5 on the mound, which is written first in the
    // bottom of the 2nd.
    const k = (
      atBatIndex: number,
      inning: number,
      halfInning: 'top' | 'bottom',
      pitcher: number
    ): GumboPlay =>
      paPlay('strikeout', {
        atBatIndex,
        inning,
        halfInning,
        batter: halfInning === 'top' ? 1 : 12,
        pitcher,
        outs: 3
      })
    const changed = eventful(
      k(3, 2, 'bottom', 5),
      [[0, { id: 5 }]],
      [[12, 'strikeout', 3]]
    )
    expect(
      pitched([
        k(0, 1, 'top', 11),
        k(1, 1, 'bottom', 4),
        k(2, 2, 'top', 11),
        changed
      ])
    ).deep.equals([
      [4, 'away', 3, 1],
      [5, 'away', 3, 1],
      [11, 'home', 6, 2]
    ])
  })

  it('gives an out made while a pitcher with no user id is on the mound to nobody', function () {
    // 11 gives way to a pitcher made at the field, who picks 1 off, and
    // comes back to strike 2 out.
    const single = paPlay('single', { pitcher: 11 })
    const pa = paPlay('strikeout', {
      atBatIndex: 1,
      batter: 2,
      pitcher: 11,
      outs: 2
    })
    expect(
      pitched([
        single,
        eventful(
          pa,
          [
            [1, { fullName: 'Player 9' }],
            [3, { id: 11 }]
          ],
          [
            [1, 'pickoff_1b', 2],
            [2, 'strikeout', 6]
          ]
        )
      ])
    ).deep.equals([[11, 'home', 1, 2]])
  })

  it('skips game_advisory, score_correction and final_score', function () {
    const base = paPlay('single', { awayScore: 0, homeScore: 0 })
    const skips: GumboPlay[] = [
      {
        about: { atBatIndex: 1, inning: 1, halfInning: 'top' },
        result: { eventType: 'game_advisory', awayScore: 0, homeScore: 0 },
        count: { outs: 3 },
        matchup: { pitcher: { id: 11 } },
        runners: []
      },
      {
        about: { atBatIndex: 2, inning: 1, halfInning: 'top' },
        result: { eventType: 'score_correction', awayScore: 0, homeScore: 0 },
        count: { outs: 3 },
        matchup: { pitcher: { id: 11 } },
        runners: []
      },
      {
        about: { atBatIndex: 3, inning: 1, halfInning: 'top' },
        result: { eventType: 'final_score', awayScore: 0, homeScore: 0 },
        count: { outs: 3 },
        matchup: { pitcher: { id: 11 } },
        runners: []
      }
    ]
    const withSkips = gameStatLines([base, ...skips], teams, known)
    const without = gameStatLines([base], teams, known)
    expect(withSkips).deep.equals(without)
  })

  it('drops a player with no id and keeps counting', function () {
    const play = paPlay('single', {
      batter: null,
      pitcher: 11,
      runners: [
        {
          movement: { start: '3B', end: 'score', isOut: false },
          details: {
            eventType: 'single',
            runner: {},
            responsiblePitcher: { id: 11 },
            earned: true,
            rbi: false
          }
        },
        {
          movement: { start: null, end: '1B', isOut: false },
          details: { eventType: 'single', runner: {} }
        }
      ],
      awayScore: 1,
      homeScore: 0
    })
    expect(gameStatLines([play], teams, known)).deep.equals({
      kind: 'lines',
      lines: [
        line(11, 'home', { pitch_bf: 1, pitch_h: 1, pitch_r: 1, pitch_er: 1 })
      ]
    })
  })

  it('ignores a runner entry with no movement', function () {
    const play = paPlay('field_out', {
      isOut: true,
      outs: 1,
      runners: [
        {
          movement: { start: null, end: null, isOut: true },
          details: { eventType: 'field_out', runner: { id: 1 } }
        },
        { credits: [{ player: { id: 15 }, credit: 'f_putout' }] }
      ]
    })
    expect(gameStatLines([play], teams, known)).deep.equals({
      kind: 'lines',
      lines: [
        line(1, 'away', { pa: 1, ab: 1 }),
        line(11, 'home', { pitch_bf: 1, pitch_outs: 1 })
      ]
    })
  })

  it('names the batting team from halfInning, including a runner who never batted', function () {
    const top: GumboPlay = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' as const },
      result: { eventType: 'stolen_base' },
      count: { outs: 0 },
      matchup: { pitcher: { id: 11 } },
      runners: [
        {
          movement: { start: '1B', end: '2B', isOut: false },
          details: { eventType: 'stolen_base_2b', runner: { id: 5 } }
        }
      ]
    }
    const bottom = paPlay('single', {
      atBatIndex: 1,
      halfInning: 'bottom',
      batter: 12,
      pitcher: 10
    })
    const result = gameStatLines([top, bottom], teams, known)
    expect(result.kind).equals('lines')
    if (result.kind !== 'lines') return
    expect(result.lines.find(l => l.userId === 5)).deep.equals(
      line(5, 'away', { sb: 1 })
    )
    expect(result.lines.find(l => l.userId === 12)?.teamId).equals('home')
  })

  describe('incomplete for each required field', function () {
    const required: Array<{ path: string; play: GumboPlay }> = [
      {
        path: 'about.inning',
        play: {
          about: { atBatIndex: 3, halfInning: 'top' },
          result: { eventType: 'single' },
          count: { outs: 0 },
          matchup: { batter: { id: 1 }, pitcher: { id: 11 } },
          runners: []
        }
      },
      {
        path: 'about.halfInning',
        play: {
          about: { atBatIndex: 4, inning: 1 },
          result: { eventType: 'single' },
          count: { outs: 0 },
          matchup: { batter: { id: 1 }, pitcher: { id: 11 } },
          runners: []
        }
      },
      {
        path: 'matchup.pitcher',
        play: {
          about: { atBatIndex: 5, inning: 1, halfInning: 'top' },
          result: { eventType: 'single' },
          count: { outs: 0 },
          matchup: { batter: { id: 1 } },
          runners: []
        }
      },
      {
        path: 'matchup.batter',
        play: {
          about: { atBatIndex: 6, inning: 1, halfInning: 'top' },
          result: { eventType: 'single' },
          count: { outs: 0 },
          matchup: { pitcher: { id: 11 } },
          runners: []
        }
      },
      {
        path: 'count.outs',
        play: {
          about: { atBatIndex: 7, inning: 1, halfInning: 'top' },
          result: { eventType: 'single' },
          matchup: { batter: { id: 1 }, pitcher: { id: 11 } },
          runners: []
        }
      },
      {
        path: 'runners',
        play: {
          about: { atBatIndex: 8, inning: 1, halfInning: 'top' },
          result: { eventType: 'single' },
          count: { outs: 0 },
          matchup: { batter: { id: 1 }, pitcher: { id: 11 } }
        }
      },
      {
        path: 'runners batter entry',
        play: {
          about: { atBatIndex: 9, inning: 1, halfInning: 'top' },
          result: { eventType: 'single' },
          count: { outs: 0 },
          matchup: { batter: { id: 1 }, pitcher: { id: 11 } },
          runners: [
            {
              movement: { start: '1B', end: '2B', isOut: false },
              details: { eventType: 'single', runner: { id: 2 } }
            }
          ]
        }
      },
      {
        path: 'runners[0].movement.end',
        play: {
          about: { atBatIndex: 10, inning: 1, halfInning: 'top' },
          result: { eventType: 'single' },
          count: { outs: 0 },
          matchup: { batter: { id: 1 }, pitcher: { id: 11 } },
          runners: [
            {
              movement: { start: null, isOut: false },
              details: { eventType: 'single', runner: { id: 1 } }
            }
          ]
        }
      },
      {
        path: 'runners[0].details.runner',
        play: {
          about: { atBatIndex: 11, inning: 1, halfInning: 'top' },
          result: { eventType: 'stolen_base' },
          count: { outs: 0 },
          matchup: { pitcher: { id: 11 } },
          runners: [
            {
              movement: { start: '1B', end: '2B', isOut: false },
              details: { eventType: 'stolen_base_2b' }
            }
          ]
        }
      },
      {
        path: 'runners[0].details.eventType',
        play: {
          about: { atBatIndex: 12, inning: 1, halfInning: 'top' },
          result: { eventType: 'stolen_base' },
          count: { outs: 0 },
          matchup: { pitcher: { id: 11 } },
          runners: [
            {
              movement: { start: '1B', end: '2B', isOut: false },
              details: { runner: { id: 1 } }
            }
          ]
        }
      },
      {
        path: 'runners[0].details.responsiblePitcher',
        play: {
          about: { atBatIndex: 13, inning: 1, halfInning: 'top' },
          result: { eventType: 'home_run', awayScore: 1, homeScore: 0 },
          count: { outs: 0 },
          matchup: { batter: { id: 1 }, pitcher: { id: 11 } },
          runners: [
            {
              movement: { start: null, end: 'score', isOut: false },
              details: {
                eventType: 'home_run',
                runner: { id: 1 },
                earned: true,
                rbi: true
              }
            }
          ]
        }
      },
      {
        path: 'runners[0].details.earned',
        play: {
          about: { atBatIndex: 14, inning: 1, halfInning: 'top' },
          result: { eventType: 'home_run', awayScore: 1, homeScore: 0 },
          count: { outs: 0 },
          matchup: { batter: { id: 1 }, pitcher: { id: 11 } },
          runners: [
            {
              movement: { start: null, end: 'score', isOut: false },
              details: {
                eventType: 'home_run',
                runner: { id: 1 },
                responsiblePitcher: { id: 11 },
                rbi: true
              }
            }
          ]
        }
      },
      {
        path: 'runners[0].details.rbi',
        play: {
          about: { atBatIndex: 15, inning: 1, halfInning: 'top' },
          result: { eventType: 'home_run', awayScore: 1, homeScore: 0 },
          count: { outs: 0 },
          matchup: { batter: { id: 1 }, pitcher: { id: 11 } },
          runners: [
            {
              movement: { start: null, end: 'score', isOut: false },
              details: {
                eventType: 'home_run',
                runner: { id: 1 },
                responsiblePitcher: { id: 11 },
                earned: true
              }
            }
          ]
        }
      }
    ]

    for (const { path, play } of required) {
      it(`names ${path}`, function () {
        const index =
          typeof play.about.atBatIndex === 'number' ? play.about.atBatIndex : 0
        expect(gameStatLines([play], teams, known)).deep.equals({
          kind: 'incomplete',
          detail: `play ${index}: ${path} missing`
        })
      })
    }
  })

  it('rejects an id that is not a user', function () {
    const unknownRp = paPlay('single', {
      atBatIndex: 20,
      runners: [
        {
          movement: { start: '3B', end: 'score', isOut: false },
          details: {
            eventType: 'single',
            runner: { id: 1 },
            responsiblePitcher: { id: 99 },
            earned: true,
            rbi: true
          }
        },
        {
          movement: { start: null, end: '1B', isOut: false },
          details: { eventType: 'single', runner: { id: 2 } }
        }
      ],
      batter: 2,
      awayScore: 1,
      homeScore: 0
    })
    expect(gameStatLines([unknownRp], teams, known)).deep.equals({
      kind: 'incomplete',
      detail:
        'play 20: runners[0].details.responsiblePitcher.id 99 is not a user'
    })

    const stringPitcher: GumboPlay = {
      about: { atBatIndex: 21, inning: 1, halfInning: 'top' as const },
      result: { eventType: 'other_out' },
      count: { outs: 1 },
      matchup: { pitcher: { id: 11 } },
      runners: [
        {
          movement: { start: '1B', end: null, isOut: true },
          details: {
            eventType: 'other_out',
            runner: { id: 1 },
            pitcher: { id: '11' }
          }
        }
      ]
    }
    expect(gameStatLines([stringPitcher], teams, known)).deep.equals({
      kind: 'incomplete',
      detail: 'play 21: runners[0].details.pitcher.id 11 is not a user'
    })
  })

  it('checks runs against the final score', function () {
    const short = [
      paPlay('home_run', {
        end: 'score',
        awayScore: 1,
        homeScore: 0,
        atBatIndex: 0
      }),
      {
        about: { atBatIndex: 1, inning: 1, halfInning: 'top' as const },
        result: { eventType: 'final_score', awayScore: 6, homeScore: 3 },
        count: { outs: 0 },
        matchup: { pitcher: { id: 11 } },
        runners: []
      }
    ]
    expect(gameStatLines(short, teams, known)).deep.equals({
      kind: 'incomplete',
      detail:
        'runs from runners (away 1, home 0) do not match the score (away 6, home 3)'
    })

    const corrected = [
      paPlay('home_run', {
        end: 'score',
        awayScore: 1,
        homeScore: 0,
        atBatIndex: 0
      }),
      {
        about: { atBatIndex: 1, inning: 1, halfInning: 'top' as const },
        result: { eventType: 'score_correction', awayScore: 1, homeScore: 0 },
        count: { outs: 0 },
        matchup: { pitcher: { id: 11 } },
        runners: []
      }
    ]
    expect(gameStatLines(corrected, teams, known).kind).equals('lines')
  })

  it('returns no lines for no plays', function () {
    expect(gameStatLines([], teams, known)).deep.equals({
      kind: 'lines',
      lines: []
    })
  })

  it('names the new Gumbo event types', function () {
    expect(isGumboEventType('other_out')).equals(true)
    expect(isGumboEventType('game_advisory')).equals(true)
    expect(eventTypeName('other_out')).equals('Out')
    expect(eventTypeName('game_advisory')).equals('Scorekeeper note')
  })

  it('reads catcher_interf and the legacy catcher_interference alike', function () {
    expect(gameStatLines([paPlay('catcher_interf')], teams, known)).deep.equals(
      gameStatLines([paPlay('catcher_interference')], teams, known)
    )
  })

  it('counts every base-running type for its runners and outs, never as a PA', function () {
    const types = [
      'stolen_base',
      'stolen_base_2b',
      'stolen_base_3b',
      'stolen_base_home',
      'caught_stealing',
      'caught_stealing_2b',
      'caught_stealing_3b',
      'caught_stealing_home',
      'pickoff_1b',
      'pickoff_2b',
      'pickoff_3b',
      'pickoff_error_1b',
      'pickoff_error_2b',
      'pickoff_error_3b',
      'pickoff_caught_stealing_2b',
      'pickoff_caught_stealing_3b',
      'pickoff_caught_stealing_home',
      'wild_pitch',
      'passed_ball',
      'balk',
      'forced_balk',
      'other_out',
      'defensive_indiff',
      'other_advance',
      'runner_double_play',
      'cs_double_play',
      'error'
    ]
    for (const eventType of types) {
      const play: GumboPlay = {
        about: { atBatIndex: 0, inning: 1, halfInning: 'top' as const },
        result: { eventType, awayScore: 1, homeScore: 0 },
        count: { outs: 1 },
        matchup: { batter: { id: 1 }, pitcher: { id: 11 } },
        runners: [
          {
            movement: { start: '1B', end: null, isOut: true },
            details: { eventType, runner: { id: 2 } }
          },
          {
            movement: { start: '3B', end: 'score', isOut: false },
            details: {
              eventType,
              runner: { id: 3 },
              responsiblePitcher: { id: 11 },
              earned: false,
              rbi: false
            }
          }
        ]
      }
      // Each runner's own entry names the steal or the caught stealing.
      const running = eventType.startsWith('caught_stealing')
        ? { cs: 1 }
        : eventType.startsWith('stolen_base')
          ? { sb: 1 }
          : null
      expect(gameStatLines([play], teams, known), eventType).deep.equals({
        kind: 'lines',
        lines: [
          ...(running == null ? [] : [line(2, 'away', running)]),
          line(3, 'away', { r: 1, ...running }),
          line(11, 'home', { pitch_outs: 1, pitch_r: 1 })
        ]
      })
    }
  })

  it('skips substitutions, placed runners, timeouts and the score entries', function () {
    for (const eventType of [
      'runner_placed',
      'placed_runner',
      'pitching_substitution',
      'offensive_substitution',
      'defensive_substitution',
      'defensive_switch',
      'mound_visit',
      'batter_timeout',
      'game_advisory',
      'final_score',
      'score_correction'
    ]) {
      const play = paPlay(eventType, { end: 'score' })
      expect(gameStatLines([play], teams, known), eventType).deep.equals({
        kind: 'lines',
        lines: []
      })
    }
  })

  it('credits a steal made inside a plate appearance', function () {
    const play = paPlay('single', {
      runners: [
        {
          movement: { start: '1B', end: '2B', isOut: false },
          details: { eventType: 'stolen_base_2b', runner: { id: 2 } }
        },
        {
          movement: { start: null, end: '1B', isOut: false },
          details: { eventType: 'single', runner: { id: 1 } }
        }
      ]
    })
    const result = gameStatLines([play], teams, known)
    expect(result.kind).equals('lines')
    if (result.kind !== 'lines') return
    expect(result.lines.find(l => l.userId === 2)).deep.equals(
      line(2, 'away', { sb: 1 })
    )
  })

  it('counts a batter placed by hand who forces in a run: a PA, no AB, and the run', function () {
    const run = (
      runner: number,
      start: string,
      end: string
    ): NonNullable<GumboPlay['runners']>[number] => ({
      movement: { start, end, isOut: false },
      details: {
        eventType: 'gs_manual_placement',
        runner: { id: runner },
        ...(end === 'score'
          ? { responsiblePitcher: { id: 11 }, earned: true, rbi: true }
          : {})
      }
    })
    const play = paPlay('gs_manual_placement', {
      awayScore: 1,
      homeScore: 0,
      runners: [
        run(4, '3B', 'score'),
        run(3, '2B', '3B'),
        run(2, '1B', '2B'),
        {
          movement: { start: null, end: '1B', isOut: false },
          details: { eventType: 'gs_manual_placement', runner: { id: 1 } }
        }
      ]
    })
    expect(gameStatLines([play], teams, known)).deep.equals({
      kind: 'lines',
      lines: [
        line(1, 'away', { pa: 1, rbi: 1 }),
        line(4, 'away', { r: 1 }),
        line(11, 'home', { pitch_bf: 1, pitch_r: 1, pitch_er: 1 })
      ]
    })
  })

  it('gives gs_batter_out a PA and an AB, and a between-pitch other_out neither', function () {
    const batterOut = gameStatLines(
      [paPlay('gs_batter_out', { isOut: true, outs: 1 })],
      teams,
      known
    )
    expect(batterOut).deep.equals({
      kind: 'lines',
      lines: [
        line(1, 'away', { pa: 1, ab: 1 }),
        line(11, 'home', { pitch_bf: 1, pitch_outs: 1 })
      ]
    })
    const runnerOut: GumboPlay = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' as const },
      result: { eventType: 'other_out' },
      count: { outs: 1 },
      matchup: { batter: { id: 1 }, pitcher: { id: 11 } },
      runners: [
        {
          movement: { start: '2B', end: null, isOut: true },
          details: { eventType: 'other_out', runner: { id: 2 } }
        }
      ]
    }
    expect(gameStatLines([runnerOut], teams, known)).deep.equals({
      kind: 'lines',
      lines: [line(11, 'home', { pitch_outs: 1 })]
    })
  })
})

/**
 * The imported-game regression. Three imported games, anonymized, with the
 * lines the base code (02650517b) built for them: each builds the same lines
 * now, except that a sacrifice bunt moves from `sf` to `sh`. None of the
 * imports has a sacrifice bunt, so a hand-built one shows the move.
 */
describe('imported games build the lines they always did', function () {
  interface Fixture {
    plays: GumboPlay[]
    expected: Array<Omit<PlayerGameLine, 'sh'>>
    finalScore: { away: number; home: number }
  }
  const load = (name: string): Fixture =>
    JSON.parse(
      readFileSync(join(__dirname, `fixtures/${name}.json`), 'utf8')
    ) as Fixture

  /** The base code's lines, with each sac bunt batter's `sf` moved to `sh`. */
  function movedToSh(
    plays: GumboPlay[],
    expected: Fixture['expected']
  ): PlayerGameLine[] {
    const bunts = new Map<number, number>()
    for (const play of plays) {
      const id = play.matchup?.batter?.id
      if (
        typeof id === 'number' &&
        ['sac_bunt', 'sac_bunt_double_play'].includes(play.result.eventType)
      )
        bunts.set(id, (bunts.get(id) ?? 0) + 1)
    }
    return expected.map(held => {
      const moved = bunts.get(held.userId) ?? 0
      return { ...held, sf: held.sf - moved, sh: moved }
    })
  }

  for (const name of ['imported1', 'imported2', 'imported3']) {
    it(`builds ${name}'s base-code lines`, function () {
      const { plays, expected } = load(name)
      const result = gameStatLines(plays, teams, new Set(namedPlayerIds(plays)))
      expect(result).deep.equals({
        kind: 'lines',
        lines: movedToSh(plays, expected)
      })
    })
  }

  it('moves a sacrifice bunt from sf to sh', function () {
    const { plays, expected } = load('imported3')
    // A batter's out, turned into a bunt. The base code counted a sac_bunt
    // like a sac fly: a PA, no AB, and an sf. It skipped a
    // sac_bunt_double_play, which now counts as a sac_bunt does.
    const index = plays.findIndex(play => play.result.eventType === 'field_out')
    expect(index).to.be.greaterThan(-1)
    const batter = plays[index].matchup!.batter!.id!
    for (const eventType of ['sac_bunt', 'sac_bunt_double_play']) {
      const bunted = plays.map((play, at) =>
        at === index ? { ...play, result: { ...play.result, eventType } } : play
      ) as GumboPlay[]
      const baseLines = expected.map(held =>
        held.userId === batter
          ? { ...held, ab: held.ab - 1, sf: held.sf + 1 }
          : held
      )
      const lines = movedToSh(bunted, baseLines)
      const mine = lines.find(held => held.userId === batter)!
      expect(mine.sh, eventType).equals(1)
      expect(
        gameStatLines(bunted, teams, new Set(namedPlayerIds(bunted))),
        eventType
      ).deep.equals({ kind: 'lines', lines })
    }
  })
})
