import React, { useEffect, useRef, useState } from 'react'
import { AccessibilityInfo, Animated, Easing, Text } from 'react-native'

import { USE_NATIVE_DRIVER } from '../platform/nativeDriver'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

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
 */
export function LivePill(props: LivePillProps): React.ReactElement {
  const { inline = false } = props
  const styles = getStyles(useTheme())
  const [reduceMotion, setReduceMotion] = useState(false)
  const opacity = useRef(new Animated.Value(1)).current

  useEffect(() => {
    let cancelled = false
    AccessibilityInfo.isReduceMotionEnabled?.()
      .then(on => {
        if (!cancelled) setReduceMotion(on)
      })
      .catch(() => undefined)
    const subscription = AccessibilityInfo.addEventListener?.(
      'reduceMotionChanged',
      on => {
        setReduceMotion(on)
      }
    )
    return () => {
      cancelled = true
      subscription?.remove()
    }
  }, [])

  useEffect(() => {
    if (reduceMotion) {
      opacity.setValue(1)
      return
    }
    // Down and back over 1.6 s: slow enough to read as breathing rather than
    // flashing, and only as far as three-quarters. It sits over a picture, and
    // a red pill faded much further than that over a bright one stops reading
    // as red at all — which is the whole of what the pill is for.
    //
    // The driver is the platform's where there is one. A browser has none —
    // asking react-native-web for it reaches into a bridge helper it does not
    // have and brings the screen down — and a phone does, which matters here
    // because this pill sits over a video that is decoding.
    const pulse = Animated.loop(
      Animated.sequence([
        Animated.timing(opacity, {
          toValue: 0.72,
          duration: 800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: USE_NATIVE_DRIVER
        }),
        Animated.timing(opacity, {
          toValue: 1,
          duration: 800,
          easing: Easing.inOut(Easing.quad),
          useNativeDriver: USE_NATIVE_DRIVER
        })
      ])
    )
    pulse.start()
    return () => {
      pulse.stop()
    }
  }, [opacity, reduceMotion])

  return (
    <Animated.View
      style={[
        styles.pill,
        inline ? styles.inline : styles.overlay,
        { opacity }
      ]}
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
