import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
export const CORRECTION_INSTRUCTION =
  'Drag any other runners to advance them or have them called out'
export interface ScoreboardBounds {
  x: number
  y: number
  width: number
  height: number
}
export function InstructionToast({
  instruction,
  remainingMs,
  canFinish = false,
  onFinish,
  bounds
}: {
  instruction?: string
  remainingMs?: number
  canFinish?: boolean
  onFinish?: () => void
  bounds?: ScoreboardBounds
}): React.ReactElement | null {
  const theme = useTheme()
  if (instruction == null && remainingMs == null) return null
  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: Math.max(62, bounds?.y ?? 75),
        left: bounds?.x ?? 12,
        right: bounds == null ? 12 : undefined,
        width: bounds?.width,
        borderRadius: theme.rem(theme.radiusRem),
        borderWidth: 2,
        borderColor: theme.scoringInstructionBorder,
        backgroundColor: theme.scoringInstructionBackground,
        padding: 12,
        gap: 10
      }}
    >
      <Text
        pointerEvents="none"
        accessibilityLiveRegion="polite"
        style={{
          fontFamily: theme.semiBoldTextFont,
          color: theme.scoringInstructionText,
          fontSize: 16
        }}
      >
        {instruction ?? CORRECTION_INSTRUCTION}
      </Text>
      {remainingMs != null && (
        <View
          pointerEvents="box-none"
          style={{ flexDirection: 'row', alignItems: 'center', gap: 10 }}
        >
          <Text
            pointerEvents="none"
            accessibilityLabel="Seconds to edit play"
            style={{
              color: theme.scoringInstructionText,
              fontFamily: theme.boldTextFont,
              fontSize: 18,
              minWidth: 24
            }}
          >
            {Math.ceil(remainingMs / 1000)}
          </Text>
          <View
            pointerEvents="none"
            accessibilityRole="progressbar"
            accessibilityLabel="Time to edit play"
            aria-valuemin={0}
            aria-valuemax={10}
            aria-valuenow={Math.ceil(remainingMs / 1000)}
            style={{ flex: 1, height: 5 }}
          >
            <View
              style={{
                height: 5,
                borderRadius: 3,
                backgroundColor: theme.scoringCountdownColor,
                width: `${Math.max(0, Math.min(100, remainingMs / 100))}%`
              }}
            />
          </View>
          <Pressable
            accessibilityLabel="Finish at-bat"
            accessibilityRole="button"
            disabled={!canFinish}
            onPress={onFinish}
            style={{
              backgroundColor: theme.scoringSafeColor,
              minHeight: 44,
              paddingHorizontal: 16,
              borderRadius: theme.rem(theme.radiusRem),
              justifyContent: 'center',
              opacity: canFinish ? 1 : 0.5
            }}
          >
            <Text
              selectable={false}
              style={{
                color: theme.scoringDecisionText,
                fontFamily: theme.semiBoldTextFont
              }}
            >
              Done
            </Text>
          </Pressable>
        </View>
      )}
    </View>
  )
}
