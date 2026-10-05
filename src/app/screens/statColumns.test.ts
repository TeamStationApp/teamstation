import { expect } from 'chai'
import { describe, it } from 'mocha'

import { asBattingRow, asPitchingRow } from '../../common/api'
import {
  battingColumns,
  pitchingColumns,
  playerStats,
  statColumnWidths
} from './statColumns'

export const battingFixture = asBattingRow({
  userId: 101,
  shortName: 'Alex L',
  teamId: 'demo-hawks',
  g: 2,
  pa: 8,
  ab: 6,
  h: 3,
  singles: 1,
  doubles: 1,
  triples: 0,
  hr: 1,
  bb: 1,
  k: 2,
  r: 2,
  rbi: 3,
  hbp: 1,
  sb: 2,
  cs: 1,
  sf: 0,
  sh: 0,
  roe: 0,
  fc: 1,
  pik: 0,
  rates: { avg: 0.5, obp: 0.625, ops: 1.792, slg: 1.167, sbPct: 0.667 }
})
export const pitchingFixture = asPitchingRow({
  userId: 102,
  shortName: 'Blair R',
  teamId: 'demo-hawks',
  g: 2,
  gs: 1,
  ip: '5.2',
  outs: 17,
  bf: 25,
  pitches: 82,
  h: 4,
  hr: 1,
  hbp: 1,
  r: 3,
  er: 2,
  bb: 2,
  k: 6,
  kl: 2,
  lob: 3,
  bk: 0,
  pik: 1,
  cs: 1,
  sb: 2,
  wp: 1,
  rates: { era: 2.12, whip: 1.06, baa: 0.182, sbPct: 0.667 }
})

describe('expanded statistics columns', function () {
  it('formats every batting statistic in the requested order', function () {
    expect(battingColumns.map(c => c.label).join(' ')).equals(
      'PA AB H AVG OBP OPS SLG 1B 2B 3B HR RBI R BB SO HBP SAC SF ROE FC SB SB% CS PIK'
    )
    expect(
      playerStats(battingFixture, battingColumns).map(c => c.value)
    ).deep.equals([
      '8',
      '6',
      '3',
      '.500',
      '.625',
      '1.792',
      '1.167',
      '1',
      '1',
      '0',
      '1',
      '3',
      '2',
      '1',
      '2',
      '1',
      '0',
      '0',
      '0',
      '1',
      '2',
      '66.7%',
      '1',
      '0'
    ])
  })
  it('formats every pitching statistic with unavailable official decisions', function () {
    expect(pitchingColumns.map(c => c.label).join(' ')).equals(
      'IP GP GS BF #P W L SV SVO BS SV% H R ER BB SO K-L HBP ERA WHIP LOB BK PIK CS SB SB% WP BAA'
    )
    expect(
      playerStats(pitchingFixture, pitchingColumns).map(c => c.value)
    ).deep.equals([
      '5.2',
      '2',
      '1',
      '25',
      '82',
      '—',
      '—',
      '—',
      '—',
      '—',
      '—',
      '4',
      '3',
      '2',
      '2',
      '6',
      '2',
      '1',
      '2.12',
      '1.06',
      '3',
      '0',
      '1',
      '1',
      '2',
      '66.7%',
      '1',
      '.182'
    ])
  })
  it('distinguishes missing detail and denominators from recorded zero', function () {
    const batting = playerStats(
      asBattingRow({ ...battingFixture, roe: null, rates: {} }),
      battingColumns
    )
    expect(batting.find(c => c.label === 'AVG')?.value).equals('—')
    expect(batting.find(c => c.label === 'ROE')?.value).equals('—')
    expect(batting.find(c => c.label === 'SB%')?.value).equals('—')
    const pitching = playerStats(
      asPitchingRow({ ...pitchingFixture, pitches: null, rates: {} }),
      pitchingColumns
    )
    for (const label of ['#P', 'ERA', 'WHIP', 'BAA', 'SB%'])
      expect(pitching.find(c => c.label === label)?.value).equals('—')
  })
})

describe('compact statistics widths', function () {
  it('preserves room for complete values and headings at larger accessibility sizes', function () {
    const normal = statColumnWidths(
      pitchingColumns,
      [pitchingFixture],
      0.875,
      0.6875,
      0.05
    )
    const larger = statColumnWidths(
      pitchingColumns,
      [pitchingFixture],
      0.875,
      0.6875,
      0.05,
      2
    )
    for (let i = 0; i < normal.length; i++)
      expect(larger[i]).at.least(normal[i] * 2)
  })

  it('reserves space for numeric formats and headings without uniform wide columns', function () {
    const widths = statColumnWidths(
      battingColumns,
      [battingFixture],
      0.875,
      0.6875,
      0.05
    )
    const width = (label: string): number =>
      widths[battingColumns.findIndex(c => c.label === label)]
    expect(width('PA')).lessThan(width('AVG'))
    expect(width('AVG')).lessThan(width('OPS'))
    expect(width('OPS')).lessThan(width('SB%'))
    expect(width('PA')).lessThan(1.5)
    expect(width('SB%')).lessThan(3.75)
  })
  it('expands one shared column for outliers, including innings and percentages', function () {
    const regular = statColumnWidths(pitchingColumns, [pitchingFixture], 0.8125)
    const large = statColumnWidths(
      pitchingColumns,
      [
        {
          ...pitchingFixture,
          ip: '1234.2',
          pitches: 123456,
          rates: { ...pitchingFixture.rates, era: 123.45, sbPct: 1 }
        }
      ],
      0.8125
    )
    for (const label of ['IP', '#P', 'ERA']) {
      const index = pitchingColumns.findIndex(c => c.label === label)
      expect(large[index], label).greaterThan(regular[index])
    }
    const percent = pitchingColumns.findIndex(c => c.label === 'SB%')
    expect(large[percent]).equals(regular[percent])
  })
  it('sizes empty tables, unavailable figures and wide headings', function () {
    const columns = [
      { label: 'WHIP', value: () => '—' },
      { label: 'K-L', value: () => '–' },
      { label: 'I', sample: '', value: () => '' }
    ]
    const empty = statColumnWidths(columns, [], 0.875)
    const unknown = statColumnWidths(columns, [{}], 0.875)
    expect(unknown).deep.equals(empty)
    expect(empty[0]).greaterThan(empty[1])
    expect(empty[2]).greaterThan(0)
  })
})
