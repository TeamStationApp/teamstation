import React from 'react'
import { Text, View } from 'react-native'

import {
  COMPACT_PILL_LABEL_REM,
  COMPACT_PILL_REM,
  pillPadding,
  pillShadow
} from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export type BadgeTone =
  'win' | 'loss' | 'honour' | 'neutral' | 'live' | 'umpire'

export interface BadgeProps {
  label: string
  tone?: BadgeTone
  /** Allow long descriptive labels to wrap within the available width. */
  wrap?: boolean
  /**
   * A shorter shell and smaller type, for a pill that shares a line with a
   * name it must leave room for. Its padding is still half its height.
   */
  compact?: boolean
  /** Lift it off the page with a raised button's shadow. */
  raised?: boolean
}

/**
 * A short status, read at a glance down a list: `W 4–0`, `1st Place`, `Active`.
 *
 * A win and a loss differ in hue, not only in the letter, because the letter is
 * the thing a parent scanning a season will not stop to read. `live` pulses
 * nothing and spins nothing — it is simply the one warm colour on an otherwise
 * green screen, which is enough to find it.
 */
export function Badge(props: BadgeProps): React.ReactElement {
  const {
    label,
    tone = 'neutral',
    wrap = false,
    compact = false,
    raised = false
  } = props
  const styles = getStyles(useTheme())
  return (
    <View
      testID="settings-pill-badge"
      style={[
        styles.badge,
        compact && styles.compact,
        styles[tone],
        wrap && styles.wrapped,
        raised && styles.raised
      ]}
    >
      <Text
        style={[
          styles.label,
          compact && styles.compactLabel,
          styles[`${tone}Text`]
        ]}
        numberOfLines={wrap ? undefined : 1}
      >
        {label}
      </Text>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  badge: {
    alignSelf: 'flex-start',
    height: theme.rem(1.5),
    minHeight: theme.rem(1.5),
    justifyContent: 'center',
    paddingHorizontal: pillPadding(theme.rem(1.5)),
    borderRadius: theme.radiusPill,
    borderWidth: 1,
    borderColor: 'transparent'
  },
  compact: {
    height: theme.rem(COMPACT_PILL_REM),
    minHeight: theme.rem(COMPACT_PILL_REM),
    paddingHorizontal: pillPadding(theme.rem(COMPACT_PILL_REM))
  },
  compactLabel: { fontSize: theme.rem(COMPACT_PILL_LABEL_REM) },
  raised: pillShadow(theme),
  // Multiline descriptions use a rounded rectangle, not semicircular ends.
  wrapped: {
    borderRadius: theme.rem(0.25),
    maxWidth: '100%',
    height: 'auto',
    paddingVertical: 3
  },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    fontWeight: '600'
  },

  win: { backgroundColor: theme.winBadgeBackground },
  winText: { color: theme.winBadgeTextColor },

  loss: { backgroundColor: theme.lossBadgeBackground },
  lossText: { color: theme.lossBadgeTextColor },

  honour: { backgroundColor: theme.honourBadgeBackground },
  honourText: { color: theme.honourBadgeTextColor },

  neutral: { backgroundColor: theme.neutralBadgeBackground },
  neutralText: { color: theme.neutralBadgeTextColor },

  live: { backgroundColor: theme.liveColor },
  liveText: { color: theme.buttonTextColor },
  umpire: { backgroundColor: '#000000' },
  umpireText: { color: '#FFFFFF' }
}))
