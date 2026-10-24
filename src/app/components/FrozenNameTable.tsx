import React from 'react'
import { ScrollView, Text, useWindowDimensions, View } from 'react-native'

import { type StatColumn, statColumnWidths } from '../screens/statColumns'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { usePaneWidth } from './useBreakpoint'

/** Names remain visible on both platforms while only the figures scroll. */
export function FrozenNameTable<T>({
  rows,
  columns,
  rowKey,
  name,
  heading = 'Team'
}: {
  rows: T[]
  columns: Array<StatColumn<T>>
  rowKey: (row: T) => string | number
  name: (row: T, index: number) => React.ReactNode
  heading?: string
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const { fontScale } = useWindowDimensions()
  const width = usePaneWidth()
  const widths = statColumnWidths(columns, rows, 0.875, 0.6875, 0.05, fontScale)
  const size = (index: number): { width: number } => ({
    width: theme.rem(widths[index] + 0.65)
  })
  return (
    <View style={styles.table}>
      <View style={{ width: theme.rem(width < 600 ? 10 : 15), flexShrink: 0 }}>
        <View style={[styles.row, styles.head]}>
          <Text style={styles.heading}>{heading}</Text>
        </View>
        {rows.map((row, index) => (
          <View key={rowKey(row)} style={styles.row}>
            {name(row, index)}
          </View>
        ))}
      </View>
      <ScrollView
        horizontal
        showsHorizontalScrollIndicator
        style={styles.figures}
      >
        <View>
          <View style={[styles.row, styles.head]}>
            {columns.map((column, index) => (
              <Text
                key={column.label}
                style={[styles.heading, styles.cell, size(index)]}
              >
                {column.label}
              </Text>
            ))}
          </View>
          {rows.map(row => (
            <View key={rowKey(row)} style={styles.row}>
              {columns.map((column, index) => (
                <Text
                  key={column.label}
                  style={[styles.value, styles.cell, size(index)]}
                  numberOfLines={1}
                  accessibilityLabel={column.accessibilityValue?.(row)}
                >
                  {column.value(row)}
                </Text>
              ))}
            </View>
          ))}
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
    height: theme.rem(3.5),
    paddingHorizontal: theme.rem(0.5)
  },
  head: { backgroundColor: theme.containerBackgroundColor },
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
  }
}))
