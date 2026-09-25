import React, { useEffect } from 'react'
import { Pressable, Text, View } from 'react-native'
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming
} from 'react-native-reanimated'

import { useMotionPreference } from '../components/useMotionPreference'
import { useTheme } from '../theme/ThemeContext'
import type { ScoreboardBounds } from './InstructionToast'

export function SwitchHitterHint({
  onDismiss,
  bounds
}: {
  onDismiss: () => void
  bounds?: ScoreboardBounds
}): React.ReactElement {
  const theme = useTheme()
  const opacity = useSharedValue(1)
  const reduceMotion = useMotionPreference()
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }))
  useEffect(() => {
    opacity.value = 1
    if (!reduceMotion)
      opacity.value = withRepeat(
        withTiming(0.3, { duration: 650, reduceMotion: ReduceMotion.Never }),
        -1,
        true,
        undefined,
        ReduceMotion.Never
      )
    return () => {
      cancelAnimation(opacity)
    }
  }, [opacity, reduceMotion])

  return (
    <View
      pointerEvents="box-none"
      style={{
        position: 'absolute',
        top: bounds?.y ?? 75,
        bottom: 165,
        left: bounds?.x ?? 12,
        right: bounds == null ? 12 : undefined,
        width: bounds?.width,
        alignItems: 'center'
      }}
    >
      <View
        style={{
          padding: 16,
          backgroundColor: theme.scoringInstructionBackground,
          borderWidth: 2,
          borderColor: theme.scoringInstructionBorder,
          borderRadius: 12,
          width: '100%'
        }}
      >
        <Text
          style={{
            color: theme.scoringInstructionText,
            fontFamily: theme.semiBoldTextFont,
            textAlign: 'center'
          }}
        >
          Drag hitter to other box to switch hitting position.
        </Text>
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="OK"
          onPress={onDismiss}
          style={{ minHeight: 48, justifyContent: 'center' }}
        >
          <Text
            style={{
              color: theme.scoringCountdownColor,
              fontFamily: theme.semiBoldTextFont,
              textAlign: 'center'
            }}
          >
            OK
          </Text>
        </Pressable>
      </View>
      <Animated.Text
        pointerEvents="none"
        accessibilityLabel="Drag to the other batter box"
        style={[
          animated,
          {
            fontSize: 40,
            color: theme.scoringCountdownColor,
            fontFamily: theme.semiBoldTextFont,
            position: 'absolute',
            bottom: 0
          }
        ]}
      >
        › › ›
      </Animated.Text>
    </View>
  )
}
