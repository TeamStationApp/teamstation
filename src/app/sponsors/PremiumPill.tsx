import React from 'react'
import { Pressable, Text } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * The blue "Premium" pill on the Sponsor features row. It is its own touch
 * target and does nothing yet.
 */
export function PremiumPill(): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Premium (coming soon)"
      testID="sponsor-premium-pill"
      hitSlop={{
        top: theme.rem(0.625),
        bottom: theme.rem(0.625),
        left: theme.rem(0.5),
        right: theme.rem(0.5)
      }}
      onPress={() => undefined}
      style={styles.pill}
    >
      <Text style={styles.label}>Premium</Text>
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  pill: {
    height: theme.rem(1.75),
    paddingHorizontal: theme.rem(0.875),
    borderRadius: theme.rem(0.875),
    justifyContent: 'center',
    backgroundColor: theme.linkTextColor
  },
  label: {
    color: '#FFFFFF',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    fontWeight: '600'
  }
}))
