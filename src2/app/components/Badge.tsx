import React from 'react'
import { Text, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export type BadgeTone = 'win' | 'loss' | 'honour' | 'neutral' | 'live'

export interface BadgeProps {
  label: string
  tone?: BadgeTone
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
  const { label, tone = 'neutral' } = props
  const styles = getStyles(useTheme())
  return (
    <View style={[styles.badge, styles[tone]]}>
      <Text style={[styles.label, styles[`${tone}Text`]]} numberOfLines={1}>
        {label}
      </Text>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  badge: {
    alignSelf: 'flex-start',
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(0.1875),
    borderRadius: theme.radiusPill,
    borderWidth: 1,
    borderColor: 'transparent'
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
  liveText: { color: theme.buttonTextColor }
}))
