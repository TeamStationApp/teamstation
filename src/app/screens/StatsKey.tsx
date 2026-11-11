import React from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { battingColumns, pitchingColumns } from './statColumns'

const meanings: Record<string, string> = {
  GP: 'Games played',
  PA: 'Plate appearances',
  AB: 'At bats',
  AVG: 'Batting average',
  OBP: 'On-base percentage',
  OPS: 'On-base percentage plus slugging percentage',
  SLG: 'Slugging percentage',
  H: 'Hits',
  E: 'Errors',
  '1B': 'Single',
  '2B': 'Doubles',
  '3B': 'Triples',
  HR: 'Home runs',
  RBI: 'Runs batted in',
  R: 'Runs scored',
  BB: 'Base on balls (walks)',
  SO: 'Strikeouts',
  'K-L': 'Strikeouts Looking',
  HBP: 'Hit by pitch',
  SAC: 'Sacrifice hits & bunts',
  SF: 'Sacrifice flies',
  ROE: 'Reached on error',
  FC: "Hit into fielder's choice",
  SB: 'Stolen bases',
  'SB%': 'Stolen base percentage',
  CS: 'Caught stealing',
  PIK: 'Picked off',
  IP: 'Innings pitched',
  GS: 'Games started',
  BF: 'Batters faced',
  '#P': 'Number of pitches',
  S: 'Strikes',
  W: 'Wins',
  L: 'Losses',
  SV: 'Saves',
  SVO: 'Save opportunities',
  BS: 'Blown saves',
  'SV%': 'Save percentage',
  ER: 'Earned runs',
  ERA: 'Earned run average',
  WHIP: 'Walks and hits per inning pitched',
  LOB: 'Runners left on base',
  BK: 'Balks',
  WP: 'Wild pitches',
  BAA: 'Opponent batting average'
}

/** Labels stay beside the first line; wrapped meanings align beneath themselves. */
export function StatsKey({
  kind,
  color,
  fontSize,
  columns
}: {
  color?: string
  fontSize?: number
} & (
  | { kind: 'box'; columns: readonly string[] }
  | { kind: 'batting' | 'pitching'; columns?: never }
)): React.ReactElement {
  const theme = useTheme()
  const labels = [
    ...new Set(
      columns ??
        (kind === 'batting' ? battingColumns : pitchingColumns).map(
          column => column.label
        )
    )
  ]
  const split = Math.ceil(labels.length / 2)
  return (
    <View
      testID={`${kind}-stats-key`}
      style={{
        flexDirection: 'row',
        gap: theme.rem(0.75),
        padding: theme.rem(0.75)
      }}
    >
      {[labels.slice(0, split), labels.slice(split)].map((column, index) => (
        <View
          key={index}
          style={{ flex: 1, minWidth: 0, gap: theme.rem(0.25) }}
        >
          {column.map(label => (
            <View
              key={label}
              style={{ flexDirection: 'row', alignItems: 'flex-start' }}
            >
              <Text
                style={{
                  color: color ?? theme.primaryTextColor,
                  fontFamily: theme.boldTextFont,
                  fontWeight: '700',
                  fontSize: fontSize ?? theme.rem(0.75)
                }}
              >
                {label}
              </Text>
              <Text
                style={{
                  color: color ?? theme.primaryTextColor,
                  fontFamily: theme.regularTextFont,
                  fontSize: fontSize ?? theme.rem(0.75)
                }}
              >
                {' '}
                -{' '}
              </Text>
              <Text
                style={{
                  flex: 1,
                  color: color ?? theme.primaryTextColor,
                  fontFamily: theme.regularTextFont,
                  fontSize: fontSize ?? theme.rem(0.75)
                }}
              >
                {meanings[label]}
              </Text>
            </View>
          ))}
        </View>
      ))}
    </View>
  )
}
