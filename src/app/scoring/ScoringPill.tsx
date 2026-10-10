import React from 'react'
import { Pressable, Text } from 'react-native'

import { useScoringSheetTheme } from './scoringSheetTheme'

/** Content-sized pills wrap in their parent's flex row without shortening text. */
export function ScoringPill({
  label,
  accessibilityLabel = label,
  selected = false,
  disabled = false,
  size,
  onPress
}: {
  label: string
  accessibilityLabel?: string
  selected?: boolean
  disabled?: boolean
  size?: number
  onPress: () => void
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const badge = theme.scoringSurface.badges.green
  return (
    <Pressable
      accessibilityRole="checkbox"
      accessibilityLabel={accessibilityLabel}
      accessibilityState={{ checked: selected, disabled }}
      aria-checked={selected}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        minHeight: size ?? 44,
        width: size,
        maxWidth: '100%',
        justifyContent: 'center',
        paddingHorizontal: size == null ? 22 : 10,
        paddingVertical: 8,
        borderRadius: theme.radiusPill,
        borderWidth: 1,
        borderColor: selected ? theme.scoringSurface.accent : badge.border,
        backgroundColor:
          selected || pressed ? theme.scoringSurface.active : badge.background,
        opacity: disabled ? 0.4 : 1
      })}
    >
      <Text
        style={{
          fontFamily: theme.semiBoldTextFont,
          fontSize: 14,
          textAlign: 'center',
          color: selected ? theme.scoringSurface.activeText : badge.text
        }}
      >
        {label}
      </Text>
    </Pressable>
  )
}
