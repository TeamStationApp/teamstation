import React from 'react'
import { Pressable } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { UmpireMaskDrawing } from './UmpireMaskDrawing'
export function UmpireMask({
  onPress
}: {
  onPress: () => void
}): React.ReactElement {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel="Umpire schedule"
      onPress={onPress}
      style={{
        width: theme.rem(3),
        height: theme.rem(3),
        alignItems: 'center',
        justifyContent: 'center'
      }}
    >
      <UmpireMaskDrawing size={theme.rem(1.6)} color={theme.headerTextColor} />
    </Pressable>
  )
}
