import React, { useEffect } from 'react'
import { Text, View } from 'react-native'
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming
} from 'react-native-reanimated'

import { useMotionPreference } from '../components/useMotionPreference'
import { useTheme } from '../theme/ThemeContext'

export function GuidanceDetail({
  label,
  value
}: {
  label: string
  value: string
}): React.ReactElement {
  const theme = useTheme()
  const reduced = useMotionPreference()
  const glow = useSharedValue(0)
  const animated = useAnimatedStyle(() => ({ opacity: glow.value }))
  useEffect(() => {
    glow.value = 0
    if (!reduced) {
      glow.value = withRepeat(
        withSequence(
          withTiming(1, { duration: 650, reduceMotion: ReduceMotion.Never }),
          withTiming(0, { duration: 950, reduceMotion: ReduceMotion.Never })
        ),
        -1,
        false,
        undefined,
        ReduceMotion.Never
      )
    }
    return () => {
      cancelAnimation(glow)
    }
  }, [glow, reduced])
  const text = {
    color: theme.scoringCountdownColor,
    fontFamily: theme.boldTextFont,
    fontWeight: '700' as const,
    fontSize: 16
  }
  return (
    <View
      pointerEvents="none"
      accessibilityLabel={`${label}: ${value}`}
      accessibilityLiveRegion="polite"
      style={{
        alignSelf: 'flex-start',
        maxWidth: '100%',
        marginTop: label === 'Home run type' ? 16 : 0
      }}
    >
      <Text testID={`${label} value`} style={[text, { zIndex: 1 }]}>
        {value}
      </Text>
      <Animated.Text
        testID={`${label} shadow`}
        accessible={false}
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        aria-hidden
        style={[
          text,
          {
            position: 'absolute',
            top: 0,
            left: 0,
            right: 0,
            color: 'transparent',
            textShadowColor: theme.scoringCountdownColor,
            textShadowOffset: { width: 0, height: 1 },
            textShadowRadius: 8
          },
          animated
        ]}
      >
        {value}
      </Animated.Text>
    </View>
  )
}
