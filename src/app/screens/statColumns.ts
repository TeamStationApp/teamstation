import type { BattingRow, PitchingRow } from '../../common/api'

export interface StatColumn<T> {
  label: string
  /** Typical formatted value; larger actual values expand the whole column. */
  sample?: string
  value: (row: T) => string
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
  { label: 'PA', value: row => count(row.pa) },
  { label: 'AB', value: row => count(row.ab) },
  { label: 'H', value: row => count(row.h) },
  { label: 'AVG', sample: '.999', value: row => average(row.rates.avg) },
  { label: 'OBP', sample: '.999', value: row => average(row.rates.obp) },
  { label: 'OPS', sample: '1.999', value: row => average(row.rates.ops) },
  { label: 'SLG', sample: '1.999', value: row => average(row.rates.slg) },
  { label: '1B', value: row => count(row.singles) },
  { label: '2B', value: row => count(row.doubles) },
  { label: '3B', value: row => count(row.triples) },
  { label: 'HR', value: row => count(row.hr) },
  { label: 'RBI', value: row => count(row.rbi) },
  { label: 'R', value: row => count(row.r) },
  { label: 'BB', value: row => count(row.bb) },
  { label: 'SO', value: row => count(row.k) },
  { label: 'HBP', value: row => count(row.hbp) },
  { label: 'SAC', value: row => count(row.sh) },
  { label: 'SF', value: row => count(row.sf) },
  { label: 'ROE', value: row => count(row.roe) },
  { label: 'FC', value: row => count(row.fc) },
  { label: 'SB', value: row => count(row.sb) },
  { label: 'SB%', sample: '100.0%', value: row => percentage(row.rates.sbPct) },
  { label: 'CS', value: row => count(row.cs) },
  { label: 'PIK', value: row => count(row.pik) }
]

export const pitchingColumns: Array<StatColumn<PitchingRow>> = [
  { label: 'IP', sample: '99.2', value: row => row.ip },
  { label: 'GP', value: row => count(row.g) },
  { label: 'GS', value: row => count(row.gs) },
  { label: 'BF', value: row => count(row.bf) },
  { label: '#P', sample: '999', value: row => count(row.pitches) },
  // Official scorer decisions are not present in the stored game record.
  ...['W', 'L', 'SV', 'SVO', 'BS', 'SV%'].map(label => ({
    label,
    sample: label === 'SV%' ? '100.0%' : '99',
    value: () => '—'
  })),
  { label: 'H', value: row => count(row.h) },
  { label: 'R', value: row => count(row.r) },
  { label: 'ER', value: row => count(row.er) },
  { label: 'BB', value: row => count(row.bb) },
  { label: 'SO', value: row => count(row.k) },
  { label: 'K-L', value: row => count(row.kl) },
  { label: 'HBP', value: row => count(row.hbp) },
  { label: 'ERA', sample: '9.99', value: row => decimal(row.rates.era) },
  { label: 'WHIP', sample: '9.99', value: row => decimal(row.rates.whip) },
  { label: 'LOB', value: row => count(row.lob) },
  { label: 'BK', value: row => count(row.bk) },
  { label: 'PIK', value: row => count(row.pik) },
  { label: 'CS', value: row => count(row.cs) },
  { label: 'SB', value: row => count(row.sb) },
  { label: 'SB%', sample: '100.0%', value: row => percentage(row.rates.sbPct) },
  { label: 'WP', value: row => count(row.wp) },
  { label: 'BAA', sample: '.999', value: row => average(row.rates.baa) }
]

export function playerStats<T>(
  row: T,
  columns: Array<StatColumn<T>>
): Array<{ label: string; value: string }> {
  return columns.map(column => ({
    label: column.label,
    value: column.value(row)
  }))
}

/** A quarter rem separates adjacent figures; the first column has no gutter. */
export const STAT_COLUMN_GAP_REM = 0.25

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
