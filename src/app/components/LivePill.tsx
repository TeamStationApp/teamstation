import React, { createContext, useContext, useEffect } from 'react'
import { Platform, Text, View, type ViewStyle } from 'react-native'
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
import { useSceneShown } from './sceneShown'
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
  const placed = useOverlayStyle(inline)
  return (
    <View style={placed} accessibilityRole="text" accessibilityLabel="Live now">
      <Text style={styles.label}>live</Text>
    </View>
  )
}

/**
 * Holds every live pill below it still: for a page something else covers,
 * such as a game under its angles, which is still the screen on show.
 */
export const LivePillHeld = createContext(false)

/**
 * Where a pill over a picture starts down from the picture's top, when
 * something else holds its corner: below a sponsor logo (`PlayerSurface`).
 * `null` keeps the usual inset.
 */
export const LivePillTop = createContext<number | null>(null)

/**
 * The overlay pill's inset from the picture's corner and the box it takes,
 * as its styles draw it: the label's line and the padding round it. The
 * width allows for the word's four letters in the semi-bold face, a little
 * wider than they draw, so a logo near the pill is never taken as clear.
 */
export function livePillBox(theme: Theme): {
  inset: number
  w: number
  h: number
} {
  const font = theme.rem(0.8125)
  return {
    inset: theme.rem(theme.spaceSmRem),
    w: font * 2.8 + 2 * theme.rem(theme.spaceSmRem),
    h: font * 1.4 + 2 * theme.rem(0.1875)
  }
}

/** The pill's own place over a picture, or `inline` in a row. */
function useOverlayStyle(inline: boolean): ViewStyle[] {
  const styles = getStyles(useTheme())
  const top = useContext(LivePillTop)
  if (inline) return [styles.pill, styles.inline]
  return top == null
    ? [styles.pill, styles.overlay]
    : [styles.pill, styles.overlay, { top }]
}

/**
 * Whether a pill pulses: only where it can be seen, and for those who have
 * not asked for less movement. On Android every frame of the pulse is a
 * commit of the whole tree, so one nobody can see costs as much as one
 * somebody can.
 */
export function livePillPulses(options: {
  reduceMotion: boolean
  held: boolean
  shown: boolean
}): boolean {
  return !options.reduceMotion && !options.held && options.shown
}

/**
 * The live pulse, as an animated style: 1 to 0.72 opacity over 800 ms and
 * back, repeating, on Reanimated's UI thread. Still unless `enabled`, and
 * still wherever `livePillPulses` says a pill holds still.
 */
export function useLivePulse(
  enabled: boolean
): ReturnType<typeof useAnimatedStyle<{ opacity: number }>> {
  const reduceMotion = useMotionPreference()
  const shown = useSceneShown()
  const held = useContext(LivePillHeld)
  const pulse = enabled && livePillPulses({ reduceMotion, held, shown })
  const opacity = useSharedValue(1)
  const animated = useAnimatedStyle(() => ({ opacity: opacity.value }))
  useEffect(() => {
    opacity.value = 1
    if (pulse)
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
  }, [opacity, pulse])
  return animated
}

/** The pill as the apps draw it, pulsing on Reanimated's UI thread. */
export function AnimatedLivePill(props: LivePillProps): React.ReactElement {
  const { inline = false } = props
  const styles = getStyles(useTheme())
  const placed = useOverlayStyle(inline)
  const animated = useLivePulse(true)

  return (
    <Animated.View
      style={[...placed, animated]}
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
