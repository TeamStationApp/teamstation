import React, { useEffect, useRef } from 'react'
import { Animated, Pressable, Text, View } from 'react-native'

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
  const opacity = useRef(new Animated.Value(1)).current
  useEffect(() => {
    const animation = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.3,
          duration: 650,
          useNativeDriver: false
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 650,
          useNativeDriver: false
        })
      ])
    )
    animation.start()
    return () => {
      animation.stop()
    }
  }, [opacity])
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
        style={{
          opacity,
          fontSize: 40,
          color: theme.scoringCountdownColor,
          fontFamily: theme.semiBoldTextFont,
          position: 'absolute',
          bottom: 0
        }}
      >
        › › ›
      </Animated.Text>
    </View>
  )
}
