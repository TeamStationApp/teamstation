import React from 'react'
import { ScrollView, Text, useWindowDimensions, View } from 'react-native'

import { type StatColumn, statColumnWidths } from '../screens/statColumns'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { usePaneWidth } from './useBreakpoint'

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
  rowHeight = 3.5,
  headBackground,
  nameBackground
}: {
  rows: T[]
  columns: Array<StatColumn<T>>
  /** A row's key; the index tells apart rows that may share an id. */
  rowKey: (row: T, index: number) => string | number
  name: (row: T, index: number) => React.ReactNode
  heading?: string
  /** A last row, under the others in both halves, its figures in bold. */
  total?: { row: T; name: React.ReactNode }
  /** The names column's width in rem; by the pane's width otherwise. */
  nameWidth?: number
  /** Every row's height in rem. */
  rowHeight?: number
  /** The head row's colour, in both halves. */
  headBackground?: string
  /** Behind the names column's rows and its total; its head cell is the head's. */
  nameBackground?: string
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const { fontScale } = useWindowDimensions()
  const width = usePaneWidth()
  const measured = total == null ? rows : [...rows, total.row]
  const widths = statColumnWidths(
    columns,
    measured,
    0.875,
    0.6875,
    0.05,
    fontScale
  )
  const size = (index: number): { width: number } => ({
    width: theme.rem(widths[index] + 0.65)
  })
  const height = { height: theme.rem(rowHeight) }
  const head = [
    styles.row,
    height,
    { backgroundColor: headBackground ?? theme.containerBackgroundColor }
  ]
  const names =
    nameBackground == null ? null : { backgroundColor: nameBackground }
  const figures = (row: T, strong: boolean): React.ReactElement[] =>
    columns.map((column, index) => (
      <Text
        key={column.label}
        style={[
          styles.value,
          styles.cell,
          size(index),
          (strong || column.strong === true) && styles.strong
        ]}
        numberOfLines={1}
        accessibilityLabel={column.accessibilityValue?.(row)}
      >
        {column.value(row)}
      </Text>
    ))
  return (
    <View style={styles.table}>
      <View
        testID="frozen-names"
        style={{
          width: theme.rem(nameWidth ?? (width < 600 ? 10 : 15)),
          flexShrink: 0
        }}
      >
        <View style={head}>
          <Text style={styles.heading}>{heading}</Text>
        </View>
        {rows.map((row, index) => (
          <View key={rowKey(row, index)} style={[styles.row, height, names]}>
            {name(row, index)}
          </View>
        ))}
        {total != null && (
          <View style={[styles.row, height, styles.totalRow, names]}>
            {total.name}
          </View>
        )}
      </View>
      <ScrollView
        testID="frozen-figures"
        horizontal
        showsHorizontalScrollIndicator
        style={styles.figures}
      >
        <View>
          <View style={head}>
            {columns.map((column, index) => (
              <Text
                key={column.label}
                style={[styles.heading, styles.cell, size(index)]}
              >
                {column.label}
              </Text>
            ))}
          </View>
          {rows.map((row, index) => (
            <View key={rowKey(row, index)} style={[styles.row, height]}>
              {figures(row, false)}
            </View>
          ))}
          {total != null && (
            <View style={[styles.row, height, styles.totalRow]}>
              {figures(total.row, true)}
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: theme.rem(0.5)
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
  cell: { flexShrink: 0, textAlign: 'right' },
  value: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    fontVariant: ['tabular-nums'],
    color: theme.primaryTextColor
  },
  strong: {
    fontFamily: theme.boldTextFont,
    fontWeight: '700'
  }
}))
