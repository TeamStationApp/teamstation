import type { PitchingRow } from '../../common/api'
import { inningsPitched } from '../../common/statExtras'
import type { BattingLine } from './BoxScore'

/**
 * A side's batting table, added up: the line under its batters.
 *
 * Each counting column is the sum of the lines above it. The average column
 * reads `seasonAvg`, which on a batter's line is their season so far; on this
 * line it is the table's own hits over its at-bats, the counts just summed and
 * never the mean of the averages above, and null with no at-bats, which the
 * column draws as it draws a batter with none. A batter in the order who has
 * not come to the plate has a line of noughts and adds nothing.
 */
export function battingTotals(lines: readonly BattingLine[]): BattingLine {
  const sum = (field: CountingBatting): number =>
    lines.reduce((total, line) => total + line[field], 0)
  const ab = sum('ab')
  const h = sum('h')
  return {
    userId: null,
    shortName: undefined,
    openable: false,
    gumboIds: [],
    teamId: lines[0]?.teamId ?? null,
    g: 0,
    pa: sum('pa'),
    ab,
    h,
    singles: sum('singles'),
    doubles: sum('doubles'),
    triples: sum('triples'),
    hr: sum('hr'),
    bb: sum('bb'),
    k: sum('k'),
    r: sum('r'),
    hbp: sum('hbp'),
    rbi: sum('rbi'),
    sb: sum('sb'),
    cs: sum('cs'),
    sf: sum('sf'),
    sh: sum('sh'),
    roe: null,
    fc: null,
    pik: null,
    rates: {
      avg: undefined,
      obp: undefined,
      slg: undefined,
      ops: undefined,
      sbPct: undefined
    },
    seasonAvg: ab > 0 ? h / ab : null,
    standsFor: null
  }
}

type CountingBatting =
  | 'pa'
  | 'ab'
  | 'h'
  | 'singles'
  | 'doubles'
  | 'triples'
  | 'hr'
  | 'bb'
  | 'k'
  | 'r'
  | 'hbp'
  | 'rbi'
  | 'sb'
  | 'cs'
  | 'sf'
  | 'sh'

/**
 * A side's pitching table, added up. Innings are summed as outs and written
 * the usual way, so one and a third and one and two thirds are `3.0`.
 */
export function pitchingTotals(rows: readonly PitchingRow[]): PitchingRow {
  const sum = (field: CountingPitching): number =>
    rows.reduce((total, row) => total + row[field], 0)
  const outs = sum('outs')
  return {
    userId: rows[0]?.userId ?? '',
    shortName: undefined,
    openable: false,
    gumboIds: [],
    teamId: rows[0]?.teamId ?? null,
    ip: inningsPitched(outs),
    g: 0,
    outs,
    bf: sum('bf'),
    h: sum('h'),
    hr: sum('hr'),
    hbp: sum('hbp'),
    r: sum('r'),
    er: sum('er'),
    bb: sum('bb'),
    k: sum('k'),
    gs: null,
    pitches: null,
    kl: null,
    lob: null,
    bk: null,
    pik: null,
    cs: null,
    sb: null,
    wp: null,
    rates: { era: undefined, whip: undefined, baa: undefined, sbPct: undefined }
  }
}

type CountingPitching =
  'outs' | 'bf' | 'h' | 'hr' | 'hbp' | 'r' | 'er' | 'bb' | 'k'
