import React from 'react'
import { Pressable, Text, View, type ViewStyle } from 'react-native'

import type { Theme } from '../theme/types'
import { useScoringSheetTheme } from './scoringSheetTheme'

/** Shared by selectable player cards and cards hosted by a roster drag target. */
export function scoringPlayerCardStyle(
  theme: Theme,
  active = false
): ViewStyle {
  return {
    minHeight: 48,
    paddingHorizontal: 8,
    paddingVertical: 10,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: theme.scoringSurface.divider,
    backgroundColor: active
      ? theme.scoringSurface.active
      : theme.scoringSurface.idle
  }
}

export function ScoringPlayerCard({
  label,
  name,
  selected = false,
  disabled = false,
  onPress,
  children,
  trailing,
  width
}: {
  label: string
  name?: string
  selected?: boolean
  disabled?: boolean
  onPress: () => void
  children?: React.ReactNode
  trailing?: React.ReactNode
  width?: ViewStyle['width']
}): React.ReactElement {
  const theme = useScoringSheetTheme()
  const card = (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityState={{ selected, disabled }}
      disabled={disabled}
      onPress={onPress}
      style={({ pressed }) => ({
        ...scoringPlayerCardStyle(theme, pressed || selected),
        ...(trailing == null
          ? { width }
          : {
              flex: 1,
              minWidth: 0,
              borderWidth: 0,
              backgroundColor:
                pressed || selected
                  ? theme.scoringSurface.active
                  : 'transparent'
            }),
        opacity: disabled ? 0.4 : 1
      })}
    >
      {children ?? (
        <Text
          style={{
            flex: 1,
            minWidth: 0,
            color: theme.scoringSurface.text,
            fontFamily: theme.semiBoldTextFont,
            fontSize: 13
          }}
        >
          {name ?? label}
        </Text>
      )}
    </Pressable>
  )
  return trailing == null ? (
    card
  ) : (
    <View
      testID={`Player card ${label}`}
      style={{
        ...scoringPlayerCardStyle(theme, selected),
        width,
        paddingHorizontal: 0,
        paddingVertical: 0,
        gap: 0,
        overflow: 'hidden'
      }}
    >
      {card}
      <View
        style={{
          minHeight: 48,
          paddingHorizontal: 8,
          justifyContent: 'center',
          alignItems: 'center',
          flexShrink: 0
        }}
      >
        {trailing}
      </View>
    </View>
  )
}
