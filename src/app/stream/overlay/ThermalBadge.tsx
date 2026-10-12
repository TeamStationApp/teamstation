import React, { useEffect } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming
} from 'react-native-reanimated'
import { Defs, LinearGradient, Rect, Stop, Svg } from 'react-native-svg'

import { useMotionPreference } from '../../components/useMotionPreference'
import type { ThermalLevel } from '../phoneStreamClient'
import {
  PILL_HEIGHT,
  ROUNDED_FONT,
  THERMAL,
  THERMAL_COLORS,
  WHITE
} from './overlayTheme'

/** `COOL`, `FAIR`, `WARM`, `HOT`. */
export function thermalLabel(level: ThermalLevel): string {
  return level.toUpperCase()
}

/** Hot burns: a flame either side of the word. */
export function showsFlames(level: ThermalLevel): boolean {
  return level === 'hot'
}

export interface ThermalBadgeProps {
  level: ThermalLevel
}

/**
 * Cool, Fair, Warm or Hot, as TS Cameraman shows them. The pill is filled
 * with the level's colour, faint and breathing (3 s a breath for Cool and
 * Fair, 2 s for Warm); Hot shows a flame either side and sends a band of its
 * red up through the pill once a second. Touches pass through it.
 */
export function ThermalBadge(props: ThermalBadgeProps): React.ReactElement {
  const { level } = props
  const color = THERMAL_COLORS[level]
  const flames = showsFlames(level)
  return (
    <View testID="camera-thermal" pointerEvents="none" style={styles.pill}>
      {flames ? (
        <HotBand color={color} />
      ) : (
        <PulsingFill color={color} seconds={THERMAL.cycleSeconds[level]} />
      )}
      {flames ? <Text style={styles.flame}>🔥</Text> : null}
      <Text style={styles.label} numberOfLines={1}>
        {thermalLabel(level)}
      </Text>
      {flames ? <Text style={styles.flame}>🔥</Text> : null}
    </View>
  )
}

/** The fill, between 0.18 and 0.38 opacity, half a cycle each way. */
function PulsingFill(props: {
  color: string
  seconds: number
}): React.ReactElement {
  const { color, seconds } = props
  const still = useMotionPreference()
  const opacity = useSharedValue<number>(THERMAL.fillOpacity)
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }))
  useEffect(() => {
    opacity.value = still
      ? THERMAL.fillOpacity + (THERMAL.bandOpacity - THERMAL.fillOpacity) / 2
      : THERMAL.fillOpacity
    if (!still)
      opacity.value = withRepeat(
        withTiming(THERMAL.bandOpacity, {
          duration: (seconds * 1000) / 2,
          easing: Easing.inOut(Easing.sin)
        }),
        -1,
        true
      )
    return () => {
      cancelAnimation(opacity)
    }
  }, [opacity, seconds, still])
  return (
    <Animated.View
      style={[styles.fill, { backgroundColor: color }, animated]}
    />
  )
}

/** Hot: the resting fill, and a band ¾ as tall as the pill rising through it. */
function HotBand(props: { color: string }): React.ReactElement {
  const { color } = props
  const still = useMotionPreference()
  const band = PILL_HEIGHT * THERMAL.bandFraction
  // Each end of the band fades over a fifth of the pill's height.
  const fade = Math.min(0.49, (THERMAL.fadeFraction * PILL_HEIGHT) / band)
  const top = useSharedValue(PILL_HEIGHT)
  const animated = useAnimatedStyle(() => ({
    transform: [{ translateY: top.value }]
  }))
  useEffect(() => {
    top.value = still ? (PILL_HEIGHT - band) / 2 : PILL_HEIGHT
    if (!still)
      top.value = withRepeat(
        withTiming(-band, {
          duration: THERMAL.cycleSeconds.hot * 1000,
          easing: Easing.linear
        }),
        -1,
        false
      )
    return () => {
      cancelAnimation(top)
    }
  }, [band, still, top])
  return (
    <View style={styles.clip}>
      <View
        style={[
          styles.fill,
          { backgroundColor: color, opacity: THERMAL.fillOpacity }
        ]}
      />
      <Animated.View style={[styles.band, { height: band }, animated]}>
        <Svg width="100%" height="100%">
          <Defs>
            <LinearGradient id="hotBand" x1="0" y1="0" x2="0" y2="1">
              <Stop offset="0" stopColor={color} stopOpacity={0} />
              <Stop
                offset={fade}
                stopColor={color}
                stopOpacity={THERMAL.bandOpacity}
              />
              <Stop
                offset={1 - fade}
                stopColor={color}
                stopOpacity={THERMAL.bandOpacity}
              />
              <Stop offset="1" stopColor={color} stopOpacity={0} />
            </LinearGradient>
          </Defs>
          <Rect width="100%" height="100%" fill="url(#hotBand)" />
        </Svg>
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  pill: {
    height: PILL_HEIGHT,
    paddingHorizontal: THERMAL.paddingHorizontal,
    borderRadius: THERMAL.radius,
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8
  },
  fill: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: THERMAL.radius
  },
  clip: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    borderRadius: THERMAL.radius,
    overflow: 'hidden'
  },
  band: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0
  },
  label: {
    fontFamily: ROUNDED_FONT,
    fontSize: THERMAL.fontSize,
    fontWeight: '800',
    letterSpacing: THERMAL.letterSpacing,
    color: WHITE
  },
  flame: {
    fontSize: THERMAL.fontSize
  }
})
