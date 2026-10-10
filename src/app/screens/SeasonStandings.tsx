import React from 'react'
import { Pressable, Text, View } from 'react-native'

import type { StandingsRow } from '../../common/api'
import { Card, Emblem, initialsOf } from '../components'
import { FrozenNameTable } from '../components/FrozenNameTable'
import { useTheme } from '../theme/ThemeContext'
import type { StatColumn } from './statColumns'

function record(
  value: { w: number; l: number; t: number } | undefined
): string {
  return value == null
    ? '—'
    : `${value.w}–${value.l}${value.t > 0 ? `–${value.t}` : ''}`
}

export const seasonStandingColumns: Array<StatColumn<StandingsRow>> = [
  { label: 'W', value: row => String(row.w) },
  { label: 'L', value: row => String(row.l) },
  { label: 'T', value: row => String(row.t) },
  {
    label: '%',
    sample: '.999',
    value: row =>
      row.winningPct == null ? '—' : row.winningPct.toFixed(3).replace(/^0/, '')
  },
  {
    label: 'GB',
    sample: '99.5',
    value: row => (row.gamesBehind == null ? '—' : String(row.gamesBehind))
  },
  { label: 'RS', value: row => String(row.runsFor) },
  { label: 'RA', value: row => String(row.runsAgainst) },
  {
    label: 'Diff',
    sample: '+999',
    value: row => `${row.runDifferential >= 0 ? '+' : ''}${row.runDifferential}`
  },
  { label: 'Streak', sample: 'W99', value: row => row.streak ?? '—' },
  { label: 'Home', sample: '99–99–99', value: row => record(row.home) },
  { label: 'Away', sample: '99–99–99', value: row => record(row.away) },
  {
    label: 'PH',
    sample: '✓',
    value: row => (row.teamKind === 'external' ? '✓' : ''),
    accessibilityValue: row =>
      row.teamKind === 'external' ? 'Placeholder team' : 'Full team'
  }
]

export function SeasonStandings({
  rows,
  onOpen
}: {
  rows: StandingsRow[]
  onOpen?: (id: string) => void
}): React.ReactElement {
  const theme = useTheme()
  return (
    <>
      <Card flush>
        <FrozenNameTable
          rows={rows}
          columns={seasonStandingColumns}
          rowKey={row => row.teamId}
          name={(row, index) => (
            <Pressable
              accessibilityRole={onOpen == null ? undefined : 'button'}
              accessibilityLabel={
                onOpen == null ? undefined : `Open ${row.teamName}`
              }
              disabled={onOpen == null}
              onPress={() => onOpen?.(row.teamId)}
              style={{
                flex: 1,
                flexDirection: 'row',
                alignItems: 'center',
                gap: theme.rem(0.35),
                minHeight: 44
              }}
            >
              <Text
                style={{
                  color: theme.secondaryTextColor,
                  fontSize: theme.rem(0.75)
                }}
              >
                {index + 1}
              </Text>
              <Emblem
                uri={row.logoUrl}
                fallback={initialsOf(row.teamName)}
                size={1.5}
              />
              <View style={{ flex: 1, gap: 2 }}>
                <Text
                  numberOfLines={1}
                  style={{
                    color: theme.primaryTextColor,
                    fontFamily: theme.regularTextFont,
                    fontSize: theme.rem(0.875)
                  }}
                >
                  {row.teamName}
                </Text>
              </View>
            </Pressable>
          )}
        />
      </Card>
      <Text
        style={{
          color: theme.secondaryTextColor,
          fontFamily: theme.regularTextFont,
          fontSize: theme.rem(0.75)
        }}
      >
        W: wins · L: losses · T: ties · %: winning percentage · GB: games behind
        · RS: runs scored · RA: runs allowed · Diff: run difference · Streak:
        consecutive wins, losses or ties · Home / Away: W–L (–T when tied).
        {'\n'}PH means placeholder team.
      </Text>
    </>
  )
}
