import React from 'react'
import { ScrollView, Text, useWindowDimensions, View } from 'react-native'

import {
  COMPACT_COLUMN_GAP_REM,
  fittedColumnWidths,
  type StatColumn,
  statColumnWidths
} from '../screens/statColumns'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { usePaneWidth } from './useBreakpoint'

/** Every stat table's row, the height of the team page's tables. */
export const STAT_ROW_REM = 2.125

/** A size that holds text, in any unit: larger with the reader's, never less. */
export function scaledSize(size: number, fontScale: number): number {
  return size * Math.max(1, fontScale)
}

/**
 * Names remain visible on both platforms while only the figures scroll.
 *
 * The names are a column of their own beside the horizontal scroll, not a
 * sticky cell inside it: React Native has no sticky position, so on the phone
 * a pinned name scrolled away with the numbers. Every row in both halves has
 * one fixed height, which is what keeps a name level with its figures.
 */
export function FrozenNameTable<T>({
  rows,
  columns,
  rowKey,
  name,
  heading = 'Team',
  total,
  nameWidth,
  rowHeight = STAT_ROW_REM,
  headBackground,
  nameBackground,
  rowLabel,
  compact = false,
  namesGrow = true,
  nameMaxWidth,
  columnWidth
}: {
  rows: T[]
  columns: Array<StatColumn<T>>
  /** A row's key; the index tells apart rows that may share an id. */
  rowKey: (row: T, index: number) => string | number
  name: (row: T, index: number) => React.ReactNode
  heading?: string
  /** Who or what a row is, for a screen reader, which reads figures alone. */
  rowLabel?: (row: T, index: number) => string
  /** A last row, under the others in both halves, its figures in bold. */
  total?: { row: T; name: React.ReactNode; label?: string }
  /** The names column's width in rem; by the pane's width otherwise. */
  nameWidth?: number
  /** Every row's height in rem. */
  rowHeight?: number
  /** The head row's colour, in both halves. */
  headBackground?: string
  /** Behind the names column's rows and its total; its head cell is the head's. */
  nameBackground?: string
  /**
   * The box score's look: smaller figures close together under a ruled head,
   * `nameWidth` the floor for the name's text, the row's padding beside it. A
   * table that fits does not scroll.
   */
  compact?: boolean
  /**
   * In a compact table, whether the names take whatever width is left, which
   * sets the figures against the right edge. Otherwise the column is as wide
   * as its longest name, and the table keeps to its left.
   */
  namesGrow?: boolean
  /** The most a column sized to its names may take, in rem. */
  nameMaxWidth?: number
  /** Every figure's width in rem, for columns that line up; measured otherwise. */
  columnWidth?: number
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const { fontScale } = useWindowDimensions()
  const width = usePaneWidth()
  const measured = total == null ? rows : [...rows, total.row]
  const widths = compact
    ? fittedColumnWidths(columns, measured, 0.8125, fontScale)
    : statColumnWidths(columns, measured, 0.875, 0.6875, 0.05, fontScale)
  const size = (index: number): { width: number; paddingLeft?: number } => {
    if (columnWidth != null)
      return { width: theme.rem(scaledSize(columnWidth, fontScale)) }
    if (!compact) return { width: theme.rem(widths[index] + 0.65) }
    const gap = index === 0 ? 0 : COMPACT_COLUMN_GAP_REM
    return {
      width: theme.rem(widths[index] + gap),
      paddingLeft: theme.rem(gap)
    }
  }
  const height = { height: theme.rem(scaledSize(rowHeight, fontScale)) }
  const head = [
    height,
    compact && styles.headRule,
    { backgroundColor: headBackground ?? theme.containerBackgroundColor }
  ]
  const nameRow = compact ? styles.compactNameRow : styles.row
  const figureRow = compact ? styles.compactFigureRow : styles.row
  const headingStyle = compact ? styles.compactHeading : styles.heading
  const names =
    nameBackground == null ? null : { backgroundColor: nameBackground }
  const spoken = (
    row: T,
    column: StatColumn<T>,
    who: string | undefined
  ): string | undefined => {
    const said = column.accessibilityValue?.(row)
    return who == null
      ? said
      : [who, column.label, said ?? column.value(row)]
          .filter(part => part !== '')
          .join(', ')
  }
  const figures = (
    row: T,
    strong: boolean,
    who: string | undefined
  ): React.ReactElement[] =>
    columns.map((column, index) => (
      <Text
        key={column.label}
        style={[
          compact ? styles.compactValue : styles.value,
          styles.cell,
          size(index),
          (strong || column.strong === true) && styles.strong
        ]}
        numberOfLines={1}
        accessibilityLabel={spoken(row, column, who)}
      >
        {column.value(row)}
      </Text>
    ))
  return (
    <View style={styles.table}>
      <View
        testID="frozen-names"
        style={
          compact
            ? {
                flexBasis: namesGrow
                  ? theme.rem((nameWidth ?? 6.5) + 0.75)
                  : undefined,
                flexGrow: namesGrow ? 1 : 0,
                flexShrink: 0,
                minWidth: theme.rem((nameWidth ?? 6.5) + 0.75),
                maxWidth:
                  nameMaxWidth == null ? undefined : theme.rem(nameMaxWidth)
              }
            : {
                width: theme.rem(nameWidth ?? (width < 600 ? 10 : 15)),
                flexShrink: 0
              }
        }
      >
        <View style={[nameRow, ...head]}>
          <Text style={headingStyle}>{heading}</Text>
        </View>
        {rows.map((row, index) => (
          <View key={rowKey(row, index)} style={[nameRow, height, names]}>
            {name(row, index)}
          </View>
        ))}
        {total != null && (
          <View style={[nameRow, height, styles.totalRow, names]}>
            {total.name}
          </View>
        )}
      </View>
      <ScrollView
        testID="frozen-figures"
        horizontal
        showsHorizontalScrollIndicator
        style={compact ? styles.compactFigures : styles.figures}
      >
        <View>
          <View style={[figureRow, ...head]}>
            {columns.map((column, index) => (
              <Text
                key={column.label}
                style={[headingStyle, styles.cell, size(index)]}
              >
                {column.label}
              </Text>
            ))}
          </View>
          {rows.map((row, index) => (
            <View key={rowKey(row, index)} style={[figureRow, height]}>
              {figures(row, false, rowLabel?.(row, index))}
            </View>
          ))}
          {total != null && (
            <View style={[figureRow, height, styles.totalRow]}>
              {figures(total.row, true, total.label)}
            </View>
          )}
        </View>
      </ScrollView>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  table: { flexDirection: 'row' },
  figures: { flex: 1 },
  compactFigures: { flexGrow: 0, flexShrink: 1 },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.rem(0.5)
  },
  compactNameRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingLeft: theme.rem(0.75)
  },
  compactFigureRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingRight: theme.rem(0.75)
  },
  headRule: {
    borderBottomWidth: 1,
    borderBottomColor: theme.defaultBorderColor
  },
  totalRow: {
    borderTopWidth: 1,
    borderTopColor: theme.defaultBorderColor
  },
  heading: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    fontWeight: '700',
    color: theme.secondaryTextColor
  },
  compactHeading: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  cell: { flexShrink: 0, textAlign: 'right' },
  value: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontVariant: ['tabular-nums'],
    color: theme.primaryTextColor
  },
  compactValue: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    fontVariant: ['tabular-nums'],
    color: theme.primaryTextColor
  },
  strong: {
    fontFamily: theme.boldTextFont,
    fontWeight: '700'
  }
}))
