import { expect } from 'chai'
import { readFileSync } from 'fs'
import { describe, it } from 'mocha'
import { join } from 'path'

import { eventTypeName, isGumboEventType } from '../../common/gumboEventTypes'
import type { GumboPlay } from '../../common/gumboPlay'
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
        batter: { pa: 1, sf: 1 },
        pitcher: { pitch_bf: 1, pitch_outs: 1 },
        play: paPlay('sac_bunt', { isOut: true, outs: 1 })
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

  it('charges a walk to responsiblePitcher and gives both pitch_bf', function () {
    const withOwner = paPlay('walk', { walkOwner: 11, pitcher: 16 })
    expect(gameStatLines([withOwner], teams, known)).deep.equals({
      kind: 'lines',
      lines: [
        line(1, 'away', { pa: 1, bb: 1 }),
        line(11, 'home', { pitch_bf: 1, pitch_bb: 1 }),
        line(16, 'home', { pitch_bf: 1 })
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
})
