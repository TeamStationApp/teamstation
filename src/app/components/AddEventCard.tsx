import React from 'react'
import { Pressable, Text } from 'react-native'

import { elevationFor } from '../theme/elevation'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'

export function AddEventCard({
  onPress,
  variant = 'event'
}: {
  onPress: () => void
  variant?: 'event' | 'game'
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  if (variant === 'game')
    return (
      <Button
        label="Add Game"
        accessibilityLabel="Add Game"
        testID="add-game-button"
        color={theme.scoreActionColor}
        style={{ alignSelf: 'center' }}
        onPress={onPress}
      />
    )
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
    backgroundColor: theme.addEventCardColor,
    shadowColor: theme.shadowColor,
    shadowOpacity: 1,
    shadowRadius: theme.rem(0.375),
    shadowOffset: { width: 0, height: theme.rem(0.125) },
    elevation: elevationFor(theme.rem(0.375)),
    borderRadius: theme.rem(theme.radiusRem)
  },
  pressed: {
    opacity: 0.75
  },
  title: {
    fontSize: theme.rem(1.5),
    lineHeight: theme.rem(1.5),
    fontFamily: theme.boldTextFont,
    fontWeight: '700' as const,
    color: theme.addEventCardTextColor,
    textAlign: 'center' as const
  }
}))
