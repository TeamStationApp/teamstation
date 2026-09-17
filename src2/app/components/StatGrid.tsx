import React from 'react'
import { type DimensionValue, Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export interface Stat {
  label: string
  value: string
  /** A smaller line under the value, e.g. "7.6 / GM". */
  note?: string
}

export interface StatGridProps {
  stats: Stat[]
  /** How many across. Two reads well on a phone, four on a desktop. */
  columns?: number
}

/**
 * `RECORD 12-3 · RUNS FOR 114 (7.6 / GM)` — the block of season numbers.
 *
 * Values are set in the scoreboard face so that a column of them aligns, and
 * labels are small caps above rather than beside, which keeps each cell the
 * same width whatever the number turns out to be.
 */
export function StatGrid(props: StatGridProps): React.ReactElement {
  const { stats, columns = 2 } = props
  const styles = getStyles(useTheme())
  const basis: DimensionValue = `${100 / columns}%`

  return (
    <View style={styles.grid}>
      {stats.map(stat => (
        <View key={stat.label} style={[styles.cell, { flexBasis: basis }]}>
          <Text style={styles.label} numberOfLines={1}>
            {stat.label.toUpperCase()}
          </Text>
          <Text style={styles.value} numberOfLines={1}>
            {stat.value}
          </Text>
          {stat.note != null && (
            <Text style={styles.note} numberOfLines={1}>
              {stat.note}
            </Text>
          )}
        </View>
      ))}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    rowGap: theme.rem(theme.spaceLgRem)
  },
  cell: {
    gap: theme.rem(0.125),
    paddingRight: theme.rem(theme.spaceSmRem)
  },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.6875),
    fontWeight: '700',
    letterSpacing: theme.rem(0.05),
    color: theme.secondaryTextColor
  },
  value: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.5),
    fontWeight: '700',
    letterSpacing: theme.rem(-0.01),
    color: theme.primaryTextColor
  },
  note: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.75),
    color: theme.secondaryTextColor
  }
}))
