import React, { useImperativeHandle } from 'react'
import { Pressable, Text, type TextInput, View } from 'react-native'

import {
  doubleheadersLabel,
  type GameWeekPart,
  type ScheduleSettings,
  type SetupSeason
} from '../../common/seasonScheduling'
import { fieldSizeLabel } from '../../common/venues'
import { useBreakpoint, WideTable } from '../components'
import { CheckBox } from '../components/CheckRow'
import {
  isNumberColumn,
  type NumberColumn,
  useGridNumberEditor
} from '../components/GridNumberCell'
import {
  VerticalToggle,
  type VerticalToggleOption
} from '../components/VerticalToggle'
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
  | 'maxGamesOnWeekdays'
  | 'maxGamesOnWeekend'
  | 'preferGameOn'

interface Column {
  id: GridColumn
  title: string
  widthRem: number
  value: (season: SetupSeason) => string
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
  },
  {
    id: 'maxGamesOnWeekdays',
    title: 'Max weekday games',
    widthRem: 6.5,
    value: season => String(season.settings.maxGamesOnWeekdays ?? 1)
  },
  {
    id: 'maxGamesOnWeekend',
    title: 'Max weekend games',
    widthRem: 6.5,
    value: season => String(season.settings.maxGamesOnWeekend ?? 1)
  },
  {
    id: 'preferGameOn',
    title: 'Preferred days',
    widthRem: 6.5,
    value: season => preferredLabel(preferredDays(season.settings))
  }
]

/** The two ends of the Preferred days toggle, weekend on top. */
const PREFERRED: readonly [
  VerticalToggleOption<GameWeekPart>,
  VerticalToggleOption<GameWeekPart>
] = [
  { value: 'weekend', label: 'Weekend' },
  { value: 'weekdays', label: 'Weekday' }
]

function preferredLabel(value: GameWeekPart): string {
  return PREFERRED.find(option => option.value === value)!.label
}

/**
 * The days a season prefers, as the toggle shows them: an option whose
 * maximum is 0 can't be preferred, so the other one is.
 */
export function preferredDays(
  settings: Pick<
    ScheduleSettings,
    'maxGamesOnWeekdays' | 'maxGamesOnWeekend' | 'preferGameOn'
  >
): GameWeekPart {
  if ((settings.maxGamesOnWeekdays ?? 1) === 0) return 'weekend'
  if ((settings.maxGamesOnWeekend ?? 1) === 0) return 'weekdays'
  return settings.preferGameOn ?? 'weekend'
}

/** The option a season's maxima leave no games for, if one of them does. */
function lockedDays(
  settings: Pick<ScheduleSettings, 'maxGamesOnWeekdays' | 'maxGamesOnWeekend'>
): GameWeekPart | undefined {
  if ((settings.maxGamesOnWeekdays ?? 1) === 0) return 'weekdays'
  if ((settings.maxGamesOnWeekend ?? 1) === 0) return 'weekend'
  return undefined
}

/** What a screen can ask of the grid. */
export interface SeasonScheduleGridHandle {
  /** Saves the open number cell, if any: true once nothing is unsaved. */
  flush: () => Promise<boolean>
}

/**
 * One row per chosen season and a column per setting, wider than a phone,
 * so it scrolls sideways beside the season names, which stay put. The number
 * columns are edited in place, like a spreadsheet's cells; tapping any other
 * cell opens that value's editor, and tapping a name opens the season's page.
 */
export function SeasonScheduleGrid({
  seasons,
  selectedIds,
  onToggle,
  disabled = false,
  onEdit,
  onSaveNumber,
  onOpenSeason,
  onOpenSeasonPage,
  onChooseDays,
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
  /** Opens the season's other constraints. */
  onOpenSeason: (seasonId: string) => void
  /** Opens the season's own page. */
  onOpenSeasonPage: (seasonId: string) => void
  /** Saves the days a season prefers. */
  onChooseDays: (seasonId: string, preferGameOn: GameWeekPart) => void
  /** Scrolls the screen so an open cell sits `gap` above the keyboard. */
  scrollToKeyboard?: (input: TextInputInstance, gap: number) => void
  ref?: React.Ref<SeasonScheduleGridHandle>
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const phone = useBreakpoint() === 'phone'
  const numbers = useGridNumberEditor({
    seasonIds: seasons.map(season => season.id),
    valueOf: (seasonId, column) => {
      const settings = seasons.find(season => season.id === seasonId)?.settings
      if (settings == null) return undefined
      // A season saved before the weekly maxima has neither; each is 1.
      return column === 'maxGamesOnWeekdays' || column === 'maxGamesOnWeekend'
        ? (settings[column] ?? 1)
        : settings[column]
    },
    titleOf: column =>
      GRID_COLUMNS.find(item => item.id === column)?.title ?? column,
    onSave: onSaveNumber,
    scrollToKeyboard
  })
  useImperativeHandle(ref, () => ({ flush: numbers.flush }))
  // Every row is one height in both halves, which keeps a season's name
  // level with its cells.
  const head = [styles.row, styles.head]
  const row = [styles.row, styles.body]
  return (
    <View style={styles.card} testID="season-schedule-grid">
      <View style={styles.table}>
        {/* The names stay put while the cells scroll beside them. */}
        <View
          testID="season-schedule-names"
          style={[styles.names, { width: theme.rem(phone ? 10 : 12) }]}
        >
          <View style={head}>
            <Text style={[styles.name, styles.headText]}>Season</Text>
          </View>
          {seasons.map(season => (
            <View key={season.id} style={[row, styles.nameRow]}>
              <CheckBox
                label={`Auto-schedule ${season.name}`}
                checked={selectedIds?.includes(season.id) ?? true}
                disabled={disabled}
                onToggle={() => onToggle?.(season.id)}
              />
              <Pressable
                accessibilityRole="link"
                accessibilityLabel={`Open ${season.name}`}
                style={({ pressed }) => [
                  styles.nameLink,
                  pressed && styles.pressed
                ]}
                onPress={() => {
                  onOpenSeasonPage(season.id)
                }}
              >
                <Text
                  numberOfLines={2}
                  style={[styles.seasonName, styles.link]}
                >
                  {season.name}
                </Text>
              </Pressable>
            </View>
          ))}
        </View>
        <View style={styles.cells}>
          <WideTable>
            <View style={head}>
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
                Other Constraints
              </Text>
            </View>
            {seasons.map(season => (
              <View key={season.id} style={row}>
                {GRID_COLUMNS.map(column => {
                  const value = column.value(season)
                  const width = { width: theme.rem(column.widthRem) }
                  const id = column.id
                  // The count is the season's teams, which its own page changes.
                  if (id === 'teams')
                    return (
                      <View
                        key={id}
                        accessible
                        accessibilityLabel={`${season.name} ${column.title}: ${teamsLabel(season)}`}
                        style={[styles.cell, width]}
                      >
                        <Text style={styles.value}>{value}</Text>
                      </View>
                    )
                  if (id === 'preferGameOn') {
                    const weekdays = season.settings.maxGamesOnWeekdays ?? 1
                    const weekend = season.settings.maxGamesOnWeekend ?? 1
                    return (
                      <View key={id} style={[styles.cell, width]}>
                        <VerticalToggle
                          label={`${season.name} ${column.title}`}
                          options={PREFERRED}
                          value={preferredDays(season.settings)}
                          locked={lockedDays(season.settings)}
                          disabled={
                            disabled || (weekdays === 0 && weekend === 0)
                          }
                          onChange={next => {
                            onChooseDays(season.id, next)
                          }}
                        />
                      </View>
                    )
                  }
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
                <Pressable
                  accessibilityRole="button"
                  accessibilityLabel={`${season.name}: Change other constraints`}
                  style={[styles.cell, { width: theme.rem(10) }]}
                  onPress={() => {
                    onOpenSeason(season.id)
                  }}
                >
                  <Text style={[styles.value, styles.link]}>Change</Text>
                </Pressable>
              </View>
            ))}
          </WideTable>
        </View>
      </View>
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
  table: { flexDirection: 'row' as const },
  // A rule down the names' side, where the cells slide under.
  names: {
    flexShrink: 0,
    borderRightWidth: 1,
    borderRightColor: theme.defaultBorderColor
  },
  // As wide as the cells, or the rest of the card, scrolling within it.
  cells: { flexGrow: 1, flexShrink: 1 },
  row: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    borderBottomWidth: 1,
    borderBottomColor: theme.defaultBorderColor
  },
  // Room for a two-line title.
  head: { height: theme.rem(3.25) },
  // Room for two lines of a value, or the preferred days' toggle.
  body: { height: theme.rem(4) },
  headText: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    color: theme.secondaryTextColor,
    textTransform: 'uppercase' as const
  },
  nameRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    paddingLeft: theme.rem(1)
  },
  nameLink: {
    flex: 1,
    minHeight: theme.rem(3),
    justifyContent: 'center' as const,
    paddingHorizontal: theme.rem(0.75)
  },
  seasonName: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1)
  },
  name: { paddingHorizontal: theme.rem(1) },
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
