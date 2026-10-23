import React from 'react'
import { Pressable, Text, View } from 'react-native'

import {
  doubleheadersLabel,
  type SetupSeason
} from '../../common/seasonScheduling'
import { fieldSizeLabel } from '../../common/venues'
import { WideTable } from '../components'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** A column of the grid that has an editor of its own. */
export type GridColumn =
  | 'teams'
  | 'fieldSize'
  | 'gameMinutes'
  | 'bufferMinutes'
  | 'regularGames'
  | 'exhibitionGames'
  | 'doubleheaders'
  | 'dates'
  | 'blackouts'
  | 'windows'

interface Column {
  id: GridColumn | 'total'
  title: string
  widthRem: number
  value: (season: SetupSeason) => string
}

function shortDay(date: string): string {
  return new Intl.DateTimeFormat('en', {
    timeZone: 'UTC',
    month: 'short',
    day: 'numeric'
  }).format(new Date(`${date}T12:00:00Z`))
}

function count(n: number, one: string, many = `${one}s`): string {
  return n === 0 ? 'None' : `${n} ${n === 1 ? one : many}`
}

/**
 * The games a season's settings come to: half the participants' regular
 * games, since each game has two of them, and every exhibition game, which
 * has one.
 */
export function seasonGameTotal(season: SetupSeason): number {
  const s = season.settings
  return (
    Math.floor((season.participants * s.regularGames) / 2) +
    (season.exhibitionTeams === 0 ? 0 : season.participants * s.exhibitionGames)
  )
}

export const GRID_COLUMNS: Column[] = [
  {
    id: 'teams',
    title: 'Teams',
    widthRem: 7,
    value: season =>
      season.exhibitionTeams === 0
        ? String(season.participants)
        : `${season.participants} + ${season.exhibitionTeams} exh.`
  },
  {
    id: 'fieldSize',
    title: 'Size',
    widthRem: 5,
    value: season => fieldSizeLabel(season.settings.fieldSize)
  },
  {
    id: 'gameMinutes',
    title: 'Game',
    widthRem: 5,
    value: season => `${season.settings.gameMinutes} min`
  },
  {
    id: 'bufferMinutes',
    title: 'Between',
    widthRem: 5.5,
    value: season => `${season.settings.bufferMinutes} min`
  },
  {
    id: 'regularGames',
    title: 'Regular',
    widthRem: 5,
    value: season => String(season.settings.regularGames)
  },
  {
    id: 'exhibitionGames',
    title: 'Exhibition',
    widthRem: 6,
    value: season => String(season.settings.exhibitionGames)
  },
  {
    id: 'total',
    title: 'Total games',
    widthRem: 6,
    value: season => String(seasonGameTotal(season))
  },
  {
    id: 'doubleheaders',
    title: 'Doubleheaders',
    widthRem: 8.5,
    value: season => doubleheadersLabel(season.settings.doubleheaders)
  },
  {
    id: 'dates',
    title: 'Dates',
    widthRem: 9,
    value: season =>
      `${shortDay(season.settings.startsOn)} – ${shortDay(season.settings.endsOn)}`
  },
  {
    id: 'blackouts',
    title: 'Blackouts',
    widthRem: 6,
    value: season => count(season.settings.blackouts.length, 'day')
  },
  {
    id: 'windows',
    title: 'Windows',
    widthRem: 6.5,
    value: season => count(season.settings.windows.length, 'period')
  }
]

/**
 * One row per chosen season and a column per setting, wider than a phone,
 * so it scrolls sideways under the pinned season names. Tapping a cell opens
 * that value's editor; tapping a name opens the season's detail.
 */
export function SeasonScheduleGrid({
  seasons,
  onEdit,
  onOpenSeason
}: {
  seasons: SetupSeason[]
  onEdit: (seasonId: string, column: GridColumn) => void
  onOpenSeason: (seasonId: string) => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  return (
    <View style={styles.card} testID="season-schedule-grid">
      <WideTable>
        <View style={[styles.row, styles.head]}>
          <Text style={[styles.name, styles.headText]}>Season</Text>
          {GRID_COLUMNS.map(column => (
            <Text
              key={column.id}
              style={[
                styles.cell,
                styles.headText,
                { width: theme.rem(column.widthRem) }
              ]}
            >
              {column.title}
            </Text>
          ))}
        </View>
        {seasons.map(season => (
          <View key={season.id} style={styles.row}>
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`Open ${season.name}`}
              style={styles.nameCell}
              onPress={() => {
                onOpenSeason(season.id)
              }}
            >
              <Text style={[styles.nameText, styles.link]} numberOfLines={2}>
                {season.name}
              </Text>
            </Pressable>
            {GRID_COLUMNS.map(column => {
              const value = column.value(season)
              const width = { width: theme.rem(column.widthRem) }
              if (column.id === 'total')
                return (
                  <Text
                    key={column.id}
                    accessibilityLabel={`${season.name} ${column.title}: ${value}`}
                    style={[styles.cell, styles.value, width]}
                  >
                    {value}
                  </Text>
                )
              const id = column.id
              return (
                <Pressable
                  key={column.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${season.name} ${column.title}: ${value}`}
                  style={({ pressed }) => [
                    styles.cell,
                    width,
                    pressed && styles.pressed
                  ]}
                  onPress={() => {
                    onEdit(season.id, id)
                  }}
                >
                  <Text style={[styles.value, styles.link]}>{value}</Text>
                </Pressable>
              )
            })}
          </View>
        ))}
      </WideTable>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  card: {
    backgroundColor: theme.cardBackgroundColor,
    borderRadius: theme.rem(0.75),
    paddingVertical: theme.rem(0.25),
    overflow: 'hidden' as const
  },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    minHeight: theme.rem(3),
    borderBottomWidth: 1,
    borderBottomColor: theme.defaultBorderColor
  },
  head: { minHeight: theme.rem(2.25) },
  headText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    color: theme.secondaryTextColor,
    textTransform: 'uppercase' as const
  },
  nameCell: { width: theme.rem(9), paddingHorizontal: theme.rem(0.75) },
  name: { width: theme.rem(9), paddingHorizontal: theme.rem(0.75) },
  nameText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor
  },
  cell: {
    paddingHorizontal: theme.rem(0.5),
    paddingVertical: theme.rem(0.5),
    justifyContent: 'center' as const
  },
  value: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor
  },
  link: { color: theme.linkTextColor },
  pressed: { opacity: 0.6 }
}))
