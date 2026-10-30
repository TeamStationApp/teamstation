import React from 'react'
import { Text } from 'react-native'

import type { BattingRow, PitchingRow, PlayerStats } from '../../common/api'
import { splitLabels, type StatSplit } from '../../common/playerStatSplits'
import { FrozenNameTable } from '../components/FrozenNameTable'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { shortDateNoWeekday } from './format'
import { battingColumns, pitchingColumns, type StatColumn } from './statColumns'

/** One row of a player's table: where it was played, and their line there. */
interface SplitRow<T> {
  /** Null on the total. */
  split: StatSplit | null
  line: T
}

/**
 * A player's batting or pitching, as a table of the rows the server split
 * their total into — a team each for a career, a game each under a season, a
 * team or a year — with that total last.
 *
 * Every figure is the server's: the page neither adds the rows up nor works
 * out a rate, so the total row is the same figure the filter has always
 * shown. The labels are short — a team, or a date and an opponent — and wrap
 * to a second line rather than lose the opponent or the team that tells two
 * rows apart.
 */
export function PlayerStatsTable(props: {
  stats: PlayerStats
  kind: 'batting' | 'pitching'
}): React.ReactElement | null {
  const { stats, kind } = props
  const theme = useTheme()
  const total = stats[kind]
  if (total == null) return null
  const by = stats.splits?.by ?? (isNarrowed(stats) ? 'game' : 'team')
  const rows: Array<SplitRow<BattingRow | PitchingRow>> =
    stats.splits?.[kind] ?? []
  const labels = splitLabels(
    rows.map(row => row.split!),
    by,
    shortDateNoWeekday,
    [...(stats.splits?.batting ?? []), ...(stats.splits?.pitching ?? [])].map(
      row => row.split
    )
  )
  const columns = (
    kind === 'batting' ? battingColumns : pitchingColumns
  ) as Array<StatColumn<BattingRow | PitchingRow>>
  const label = (text: string): React.ReactElement => (
    <Text
      numberOfLines={2}
      style={{
        flex: 1,
        fontFamily: theme.regularTextFont,
        fontSize: theme.rem(0.875),
        color: theme.primaryTextColor
      }}
    >
      {text}
    </Text>
  )
  return (
    <FrozenNameTable<SplitRow<BattingRow | PitchingRow>>
      compact
      nameWidth={9.25}
      // A game's label may wrap to a second line, which a team's does not.
      rowHeight={by === 'game' ? 2.75 : undefined}
      heading={
        by === 'team' ? lstrings.player_stats_team : lstrings.player_stats_game
      }
      rows={rows}
      columns={columns.map(column => ({
        ...column,
        value: row => column.value(row.line),
        accessibilityValue:
          column.accessibilityValue == null
            ? undefined
            : row => column.accessibilityValue!(row.line)
      }))}
      rowKey={(row, index) =>
        `${row.split!.gameId ?? ''}:${row.split!.teamId ?? index}`
      }
      name={(row, index) => label(labels[index])}
      rowLabel={(row, index) => labels[index]}
      total={{
        row: { split: null, line: total },
        label: lstrings.player_stats_total,
        name: (
          <Text
            style={{
              fontFamily: theme.boldTextFont,
              fontWeight: '700',
              fontSize: theme.rem(0.875),
              color: theme.primaryTextColor
            }}
          >
            {lstrings.player_stats_total}
          </Text>
        )
      }}
    />
  )
}

function isNarrowed(stats: PlayerStats): boolean {
  const { seasonId, teamId, year } = stats.filter
  return seasonId != null || teamId != null || year != null
}
