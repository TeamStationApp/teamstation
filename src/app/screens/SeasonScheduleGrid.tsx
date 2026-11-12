import React, { useImperativeHandle } from 'react'
import { Pressable, Text, type TextInput, View } from 'react-native'

import {
  doubleheadersLabel,
  type SetupSeason
} from '../../common/seasonScheduling'
import { fieldSizeLabel } from '../../common/venues'
import { WideTable } from '../components'
import { CheckRow } from '../components/CheckRow'
import {
  isNumberColumn,
  type NumberColumn,
  useGridNumberEditor
} from '../components/GridNumberCell'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

type TextInputInstance = React.ComponentRef<typeof TextInput>

/** A column of the grid that has an editor of its own. */
export type GridColumn =
  | 'teams'
  | 'fieldSize'
  | 'gameMinutes'
  | 'bufferMinutes'
  | 'regularGames'
  | 'exhibitionGames'
  | 'doubleheaders'

interface Column {
  id: GridColumn
  title: string
  widthRem: number
  value: (season: SetupSeason) => string
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

/** What a screen reader hears for a season's teams. */
export function teamsLabel(season: SetupSeason): string {
  const teams = `${season.participants} ${season.participants === 1 ? 'team' : 'teams'}`
  return season.exhibitionTeams === 0
    ? teams
    : `${teams} and ${season.exhibitionTeams} exhibition ${season.exhibitionTeams === 1 ? 'team' : 'teams'}`
}

export const GRID_COLUMNS: Column[] = [
  {
    id: 'teams',
    title: 'Teams',
    widthRem: 4.5,
    value: season =>
      season.exhibitionTeams === 0
        ? String(season.participants)
        : `${season.participants} + ${season.exhibitionTeams}`
  },
  {
    id: 'fieldSize',
    title: 'Size',
    // The longest size, 46/60 MP, is 69 px at 0.9375 rem; with the cell's
    // padding it needs 81 px, so the next quarter rem up.
    widthRem: 5.25,
    value: season => fieldSizeLabel(season.settings.fieldSize)
  },
  {
    id: 'gameMinutes',
    title: 'Game MINS',
    widthRem: 5.5,
    value: season => String(season.settings.gameMinutes)
  },
  {
    id: 'bufferMinutes',
    title: 'Between MINS',
    // Its two words fit on one line at the header's 0.75 rem.
    widthRem: 6.25,
    value: season => String(season.settings.bufferMinutes)
  },
  {
    id: 'regularGames',
    title: '# Regular',
    widthRem: 5.5,
    value: season => String(season.settings.regularGames)
  },
  {
    id: 'exhibitionGames',
    title: '# Exhibition',
    widthRem: 6.5,
    value: season => String(season.settings.exhibitionGames)
  },
  {
    id: 'doubleheaders',
    title: 'Doubleheaders',
    widthRem: 8.5,
    value: season => doubleheadersLabel(season.settings.doubleheaders)
  }
]

/** What a screen can ask of the grid. */
export interface SeasonScheduleGridHandle {
  /** Saves the open number cell, if any: true once nothing is unsaved. */
  flush: () => Promise<boolean>
}

/**
 * One row per chosen season and a column per setting, wider than a phone,
 * so it scrolls sideways under the pinned season names. The number columns
 * are edited in place, like a spreadsheet's cells; tapping any other cell opens
 * that value's editor, and tapping a name opens the season's detail.
 */
export function SeasonScheduleGrid({
  seasons,
  selectedIds,
  onToggle,
  disabled = false,
  onEdit,
  onSaveNumber,
  onOpenSeason,
  scrollToKeyboard,
  ref
}: {
  seasons: SetupSeason[]
  selectedIds?: string[]
  onToggle?: (seasonId: string) => void
  disabled?: boolean
  onEdit: (seasonId: string, column: GridColumn) => void
  /** Resolves null once saved, or the message saying why it wasn't. */
  onSaveNumber: (
    seasonId: string,
    column: NumberColumn,
    value: number
  ) => Promise<string | null>
  onOpenSeason: (seasonId: string) => void
  /** Scrolls the screen so an open cell sits `gap` above the keyboard. */
  scrollToKeyboard?: (input: TextInputInstance, gap: number) => void
  ref?: React.Ref<SeasonScheduleGridHandle>
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const numbers = useGridNumberEditor({
    seasonIds: seasons.map(season => season.id),
    valueOf: (seasonId, column) =>
      seasons.find(season => season.id === seasonId)?.settings[column],
    titleOf: column =>
      GRID_COLUMNS.find(item => item.id === column)?.title ?? column,
    onSave: onSaveNumber,
    scrollToKeyboard
  })
  useImperativeHandle(ref, () => ({ flush: numbers.flush }))
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
          <Text
            style={[styles.cell, styles.headText, { width: theme.rem(10) }]}
          >
            Constraints
          </Text>
        </View>
        {seasons.map(season => (
          <View key={season.id} style={styles.row}>
            <View style={styles.nameCell}>
              <CheckRow
                label={season.name}
                checked={selectedIds?.includes(season.id) ?? true}
                disabled={disabled}
                onToggle={() => onToggle?.(season.id)}
              />
            </View>
            {GRID_COLUMNS.map(column => {
              const value = column.value(season)
              const width = { width: theme.rem(column.widthRem) }
              const id = column.id
              if (isNumberColumn(id))
                return numbers.cell({
                  seasonId: season.id,
                  seasonName: season.name,
                  column: id,
                  style: [styles.cell, width],
                  textStyle: [styles.value, styles.link]
                })
              return (
                <Pressable
                  key={column.id}
                  accessibilityRole="button"
                  accessibilityLabel={`${season.name} ${column.title}: ${id === 'teams' ? teamsLabel(season) : value}`}
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
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={`${season.name}: Change constraints`}
              style={[styles.cell, { width: theme.rem(10) }]}
              onPress={() => {
                onOpenSeason(season.id)
              }}
            >
              <Text style={[styles.value, styles.link]}>
                Change constraints
              </Text>
            </Pressable>
          </View>
        ))}
      </WideTable>
      {numbers.error !== '' && (
        <Text accessibilityRole="alert" style={styles.error}>
          {numbers.error}
        </Text>
      )}
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
  nameCell: { width: theme.rem(12) },
  name: { width: theme.rem(12), paddingHorizontal: theme.rem(0.75) },
  nameText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor
  },
  cell: {
    paddingHorizontal: theme.rem(0.375),
    paddingVertical: theme.rem(0.5),
    justifyContent: 'center' as const
  },
  value: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.primaryTextColor
  },
  link: { color: theme.linkTextColor },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.dangerColor,
    paddingHorizontal: theme.rem(0.75),
    paddingVertical: theme.rem(0.5)
  },
  pressed: { opacity: 0.6 }
}))
