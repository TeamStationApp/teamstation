import React from 'react'
import { Pressable, View } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Icon } from './Icon'

/** A top-right settings disc with a full 48-point touch target. */
export function SettingsGear({
  onPress,
  label = 'Settings'
}: {
  onPress: () => void
  label?: string
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      onPress={onPress}
      style={({ pressed }) => [styles.target, pressed && styles.pressed]}
    >
      <View style={styles.disc}>
        <Icon name="settings" size={1.25} color={theme.secondaryTextColor} />
      </View>
    </Pressable>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  target: {
    width: theme.rem(3),
    height: theme.rem(3),
    flexShrink: 0,
    alignSelf: 'flex-start' as const,
    alignItems: 'flex-end' as const
  },
  disc: {
    width: theme.rem(2),
    height: theme.rem(2),
    borderRadius: theme.radiusPill,
    backgroundColor: theme.containerBackgroundColor,
    alignItems: 'center' as const,
    justifyContent: 'center' as const
  },
  pressed: { opacity: 0.6 }
}))
