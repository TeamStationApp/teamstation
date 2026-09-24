import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'

export function RosterRemoveButton({
  label,
  disabled = false,
  onPress
}: {
  label: string
  disabled?: boolean
  onPress: () => void
}): React.ReactElement {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      hitSlop={6}
      onPress={onPress}
      onTouchStart={event => {
        event.stopPropagation()
      }}
      style={{
        width: 32,
        height: 32,
        alignItems: 'center',
        justifyContent: 'center',
        opacity: disabled ? 0.4 : 1
      }}
    >
      {({ pressed }) => (
        <View
          pointerEvents="none"
          style={{
            width: 24,
            height: 24,
            borderRadius: 12,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.scoringOutColor,
            shadowColor: theme.buttonShadowColor,
            shadowOpacity: 1,
            shadowRadius: pressed ? 4 : 8,
            shadowOffset: { width: 0, height: pressed ? 1 : 3 },
            elevation: pressed ? 1 : 3
          }}
        >
          <Text
            selectable={false}
            style={{
              color: theme.scoringDecisionText,
              fontSize: 20,
              lineHeight: 22,
              fontFamily: theme.semiBoldTextFont,
              textAlign: 'center'
            }}
          >
            ×
          </Text>
        </View>
      )}
    </Pressable>
  )
}
