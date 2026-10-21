import React from 'react'
import { Pressable, type StyleProp, Text, type ViewStyle } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

export function DangerText({
  label,
  accessibilityLabel,
  onPress,
  disabled = false,
  bold = false,
  style
}: {
  label: string
  accessibilityLabel?: string
  onPress: () => void
  disabled?: boolean
  /** Bold rather than semibold, for an account's own sign-out and delete. */
  bold?: boolean
  style?: StyleProp<ViewStyle>
}): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={accessibilityLabel ?? label}
      accessibilityState={{ disabled }}
      disabled={disabled}
      onPress={() => {
        if (!disabled) onPress()
      }}
      style={({ pressed }) => [
        styles.target,
        (disabled || pressed) && styles.muted,
        style
      ]}
    >
      <Text style={[styles.label, bold && styles.bold]}>{label}</Text>
    </Pressable>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  target: {
    minHeight: 48,
    justifyContent: 'center' as const,
    alignSelf: 'flex-start' as const
  },
  label: {
    color: theme.dangerColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1)
  },
  bold: {
    fontFamily: theme.boldTextFont,
    fontWeight: '700' as const
  },
  muted: { opacity: 0.5 }
}))
