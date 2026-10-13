import React from 'react'
import { Pressable, Text } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function AddEventCard({
  onPress
}: {
  onPress: () => void
}): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Add Event"
      testID="add-event-card"
      onPress={onPress}
      style={({ pressed }) => [styles.card, pressed && styles.pressed]}
    >
      <Text style={styles.title}>Add Event</Text>
    </Pressable>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  card: {
    alignSelf: 'stretch' as const,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    paddingVertical: theme.rem(0.875),
    borderWidth: 1.5,
    borderStyle: 'dashed' as const,
    borderColor: theme.secondaryTextColor,
    borderRadius: theme.rem(theme.radiusRem)
  },
  pressed: {
    borderColor: theme.activeColor,
    backgroundColor: theme.containerBackgroundColor
  },
  title: {
    fontSize: theme.rem(1.5),
    lineHeight: theme.rem(1.5),
    fontFamily: theme.semiBoldTextFont,
    color: theme.activeColor,
    textAlign: 'center' as const
  }
}))
