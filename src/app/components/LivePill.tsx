import React, { useEffect } from 'react'
import { Platform, Text, View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming
} from 'react-native-reanimated'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { useMotionPreference } from './useMotionPreference'

export interface LivePillProps {
  /** Sits over a picture by default; `inline` sits in a row of text. */
  inline?: boolean
}

/**
 * `live`, in white on red, breathing slowly.
 *
 * Deliberately not the `live` tone of `Badge`, which says in its own comment
 * that it pulses nothing: that badge marks a game in a list, where a page of
 * blinking rows would be unreadable. This is the other case — one card,
 * standing for the one thing happening right now — and the movement is what
 * tells a parent glancing at the screen that the game is on, not that it was.
 *
 * It holds still for anybody who has asked their system for less movement.
 * A pulse is decoration; for some people it is worse than that.
 *
 * In a browser it holds still; see `StillLivePill`.
 */
export function LivePill(props: LivePillProps): React.ReactElement {
  return Platform.OS === 'web' ? (
    <StillLivePill {...props} />
  ) : (
    <AnimatedLivePill {...props} />
  )
}

/**
 * The pill as the browser draws it: still.
 *
 * Any movement over a live picture costs Chrome the picture. On a Pixel 10
 * playing a 1080p60 game, the pulse — whether Reanimated's, which on the web
 * rewrites the pill's style in JavaScript every display frame, or a CSS
 * animation — dropped a quarter of the frames at every segment, and the game
 * played at 0.86 of real time, slipping about nine seconds further behind
 * live each minute. The same pill holding still, on the same page, played it
 * at full speed with no drops.
 */
export function StillLivePill(props: LivePillProps): React.ReactElement {
  const { inline = false } = props
  const styles = getStyles(useTheme())
  return (
    <View
      style={[styles.pill, inline ? styles.inline : styles.overlay]}
      accessibilityRole="text"
      accessibilityLabel="Live now"
    >
      <Text style={styles.label}>live</Text>
    </View>
  )
}

/** The pill as the apps draw it, pulsing on Reanimated's UI thread. */
export function AnimatedLivePill(props: LivePillProps): React.ReactElement {
  const { inline = false } = props
  const styles = getStyles(useTheme())
  const reduceMotion = useMotionPreference()
  const opacity = useSharedValue(1)
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }))
  useEffect(() => {
    opacity.value = 1
    if (!reduceMotion)
      opacity.value = withRepeat(
        withTiming(0.72, {
          duration: 800,
          easing: Easing.inOut(Easing.quad),
          reduceMotion: ReduceMotion.Never
        }),
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
    <Animated.View
      style={[styles.pill, inline ? styles.inline : styles.overlay, animated]}
      accessibilityRole="text"
      accessibilityLabel="Live now"
    >
      <Text style={styles.label}>live</Text>
    </Animated.View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  pill: {
    alignSelf: 'flex-start',
    backgroundColor: theme.liveColor,
    borderRadius: theme.radiusPill,
    paddingHorizontal: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(0.1875)
  },
  overlay: {
    position: 'absolute',
    top: theme.rem(theme.spaceSmRem),
    right: theme.rem(theme.spaceSmRem),
    zIndex: 2
  },
  inline: {},
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    fontWeight: '700',
    letterSpacing: theme.rem(0.04),
    // White, not the theme's text colour: this pill is the one place on the
    // screen where the background is fixed, so the text on it is too.
    color: '#FFFFFF'
  }
}))
