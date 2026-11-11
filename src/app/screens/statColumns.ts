import type { BattingRow, PitchingRow } from '../../common/api'

export interface StatColumn<T> {
  label: string
  meaning?: string
  /** Typical formatted value; larger actual values expand the whole column. */
  sample?: string
  value: (row: T) => string
  /** Spoken meaning for flags whose visible glyph is not descriptive. */
  accessibilityValue?: (row: T) => string
  /** Bold figures, as a line score's runs are. */
  strong?: boolean
}

const count = (value: number | null | undefined): string =>
  value == null ? '—' : String(value)
const average = (value: number | undefined): string =>
  value == null ? '—' : value.toFixed(3).replace(/^0/, '')
const decimal = (value: number | undefined): string =>
  value == null ? '—' : value.toFixed(2)
const percentage = (value: number | undefined): string =>
  value == null ? '—' : `${(value * 100).toFixed(1)}%`

/** One order and one format for the team tables and the player's cards. */
export const battingColumns: Array<StatColumn<BattingRow>> = [
  { label: 'GP', meaning: 'Games played', value: row => count(row.g) },
  { label: 'PA', meaning: 'Plate appearances', value: row => count(row.pa) },
  { label: 'AB', meaning: 'At bats', value: row => count(row.ab) },
  {
    label: 'AVG',
    meaning: 'Batting average',
    sample: '.999',
    value: row => average(row.rates.avg)
  },
  {
    label: 'OBP',
    meaning: 'On-base percentage',
    sample: '.999',
    value: row => average(row.rates.obp)
  },
  {
    label: 'OPS',
    meaning: 'On-base percentage plus slugging percentage',
    sample: '1.999',
    value: row => average(row.rates.ops)
  },
  {
    label: 'SLG',
    meaning: 'Slugging percentage',
    sample: '1.999',
    value: row => average(row.rates.slg)
  },
  { label: 'H', meaning: 'Hits', value: row => count(row.h) },
  { label: '1B', meaning: 'Single', value: row => count(row.singles) },
  { label: '2B', meaning: 'Doubles', value: row => count(row.doubles) },
  { label: '3B', meaning: 'Triples', value: row => count(row.triples) },
  { label: 'HR', meaning: 'Home runs', value: row => count(row.hr) },
  { label: 'RBI', meaning: 'Runs batted in', value: row => count(row.rbi) },
  { label: 'R', meaning: 'Runs scored', value: row => count(row.r) },
  {
    label: 'BB',
    meaning: 'Base on balls (walks)',
    value: row => count(row.bb)
  },
  { label: 'SO', meaning: 'Strikeouts', value: row => count(row.k) },
  { label: 'K-L', meaning: 'Strikeouts Looking', value: row => count(row.kl) },
  { label: 'HBP', meaning: 'Hit by pitch', value: row => count(row.hbp) },
  {
    label: 'SAC',
    meaning: 'Sacrifice hits & bunts',
    value: row => count(row.sh)
  },
  { label: 'SF', meaning: 'Sacrifice flies', value: row => count(row.sf) },
  { label: 'ROE', meaning: 'Reached on error', value: row => count(row.roe) },
  {
    label: 'FC',
    meaning: "Hit into fielder's choice",
    value: row => count(row.fc)
  },
  { label: 'SB', meaning: 'Stolen bases', value: row => count(row.sb) },
  {
    label: 'SB%',
    meaning: 'Stolen base percentage',
    sample: '100.0%',
    value: row => percentage(row.rates.sbPct)
  },
  { label: 'CS', meaning: 'Caught stealing', value: row => count(row.cs) },
  { label: 'PIK', meaning: 'Picked off', value: row => count(row.pik) }
]

export const pitchingColumns: Array<StatColumn<PitchingRow>> = [
  {
    label: 'IP',
    meaning: 'Innings pitched',
    sample: '99.2',
    value: row => row.ip
  },
  { label: 'GP', meaning: 'Games played', value: row => count(row.g) },
  { label: 'GS', meaning: 'Games started', value: row => count(row.gs) },
  { label: 'BF', meaning: 'Batters faced', value: row => count(row.bf) },
  {
    label: '#P',
    meaning: 'Pitches',
    sample: '999',
    value: row => count(row.pitches)
  },
  // Official scorer decisions are not present in the stored game record.
  ...(
    [
      ['W', 'Wins'],
      ['L', 'Losses'],
      ['SV', 'Saves'],
      ['SVO', 'Save opportunities'],
      ['BS', 'Blown saves'],
      ['SV%', 'Save percentage']
    ] as const
  ).map(([label, meaning]) => ({
    label,
    meaning,
    sample: label === 'SV%' ? '100.0%' : '99',
    value: () => '—'
  })),
  { label: 'H', meaning: 'Hits', value: row => count(row.h) },
  { label: 'R', meaning: 'Runs scored', value: row => count(row.r) },
  { label: 'ER', meaning: 'Earned runs', value: row => count(row.er) },
  {
    label: 'BB',
    meaning: 'Base on balls (walks)',
    value: row => count(row.bb)
  },
  { label: 'SO', meaning: 'Strikeouts', value: row => count(row.k) },
  { label: 'K-L', meaning: 'Strikeouts Looking', value: row => count(row.kl) },
  { label: 'HBP', meaning: 'Hit by pitch', value: row => count(row.hbp) },
  {
    label: 'ERA',
    meaning: 'Earned run average',
    sample: '9.99',
    value: row => decimal(row.rates.era)
  },
  {
    label: 'WHIP',
    meaning: 'Walks and hits per inning pitched',
    sample: '9.99',
    value: row => decimal(row.rates.whip)
  },
  {
    label: 'LOB',
    meaning: 'Runners left on base',
    value: row => count(row.lob)
  },
  { label: 'BK', meaning: 'Balks', value: row => count(row.bk) },
  { label: 'PIK', meaning: 'Picked off', value: row => count(row.pik) },
  { label: 'CS', meaning: 'Caught stealing', value: row => count(row.cs) },
  { label: 'SB', meaning: 'Stolen bases', value: row => count(row.sb) },
  {
    label: 'SB%',
    meaning: 'Stolen base percentage',
    sample: '100.0%',
    value: row => percentage(row.rates.sbPct)
  },
  { label: 'WP', meaning: 'Wild pitches', value: row => count(row.wp) },
  {
    label: 'BAA',
    meaning: 'Opponent batting average',
    sample: '.999',
    value: row => average(row.rates.baa)
  }
]

/** A quarter rem separates adjacent figures; the first column has no gutter. */
export const STAT_COLUMN_GAP_REM = 0.25
/** Between a compact table's columns, whose widths have no slack in them. */
export const COMPACT_COLUMN_GAP_REM = 0.45

/** Conservative glyph advances for the app's proportional text fonts. */
function textWidth(text: string, fontSize: number, letterSpacing = 0): number {
  let em = 0
  for (const character of text) {
    if (/[0-9]/.test(character)) em += 0.65
    else if (character === '.') em += 0.3
    else if (/[MW%—–]/.test(character)) em += 1
    else if (character === 'I' || character === '-') em += 0.4
    else em += 0.75
  }
  return em * fontSize + Math.max(0, text.length - 1) * letterSpacing
}

/** The same text's real advances, near enough to sit figures close together. */
function fittedTextWidth(text: string, fontSize: number): number {
  let em = 0
  for (const character of text) {
    if (/[0-9]/.test(character)) em += 0.62
    else if (character === '.') em += 0.28
    else if (/[MW%—–]/.test(character)) em += 1.1
    else if (character === 'I' || character === '-') em += 0.36
    else if (/[A-Z#]/.test(character)) em += 0.68
    else em += 0.56
  }
  // A little over, for the bold of a total row.
  return em * fontSize * 1.08
}

/**
 * Compact columns, as wide as what they hold now: the head and the rows, and
 * no room kept for a figure nobody on the page has.
 */
export function fittedColumnWidths<T>(
  columns: Array<StatColumn<T>>,
  rows: T[],
  fontSize: number,
  fontScale = 1
): number[] {
  const size = fontSize * fontScale
  return columns.map(column =>
    Math.max(
      fittedTextWidth(column.label, size),
      ...rows.map(row => fittedTextWidth(column.value(row), size))
    )
  )
}

/** Shared by the header and every row so outliers never shift a column. */
export function statColumnWidths<T>(
  columns: Array<StatColumn<T>>,
  rows: T[],
  fontSize: number,
  headingSize = fontSize,
  headingSpacing = 0,
  fontScale = 1
): number[] {
  fontSize *= fontScale
  headingSize *= fontScale
  headingSpacing *= fontScale
  return columns.map(column => {
    let width = Math.max(
      textWidth(column.label, headingSize, headingSpacing),
      textWidth(column.sample ?? '99', fontSize)
    )
    for (const row of rows)
      width = Math.max(width, textWidth(column.value(row), fontSize))
    return width
  })
}
