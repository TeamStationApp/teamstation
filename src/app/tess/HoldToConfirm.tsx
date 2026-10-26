import React, { useEffect, useRef } from 'react'
import { Animated, Pressable, Text, View } from 'react-native'
import Svg, { Rect } from 'react-native-svg'

import { useMotionPreference } from '../components/useMotionPreference'
import { lstrings } from '../locales/strings'
import { lightHaptic } from '../scoring/lightHaptic'
import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** How long Confirm is held before the change runs. */
export const HOLD_MS = 3000

/** With reduced motion the trace jumps a quarter at a time, as often. */
const STEP_MS = HOLD_MS / 4

const STROKE = 3

const AnimatedRect = Animated.createAnimatedComponent(Rect)

/** The outline's length: two straight runs and two semicircular ends. */
export function pillPerimeter(width: number, height: number): number {
  return 2 * (width - height) + Math.PI * height
}

/**
 * A pill that runs its action only after it has been held for three
 * seconds. The outline is traced round while it is held; letting go early,
 * or the press being taken away, wipes the trace and nothing runs.
 */
export function HoldToConfirm({
  onConfirm,
  busy = false,
  disabled = false
}: {
  onConfirm: () => void
  /** The change is running: the pill says so and takes no hold. */
  busy?: boolean
  /** Tess is answering something else: the pill takes no hold until she has. */
  disabled?: boolean
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const reduced = useMotionPreference()
  const progress = useRef(new Animated.Value(0)).current
  // The hold's timers, in an object the unmount cleanup can still reach.
  const hold = useRef({
    timers: [] as Array<ReturnType<typeof setTimeout>>
  }).current
  const view = useRef<React.ComponentRef<typeof View>>(null)

  const width = theme.rem(15)
  const height = theme.rem(3)
  const outline = {
    x: STROKE / 2,
    y: STROKE / 2,
    width: width - STROKE,
    height: height - STROKE
  }
  const perimeter = pillPerimeter(outline.width, outline.height)

  const stop = (): void => {
    for (const timer of hold.timers) clearTimeout(timer)
    hold.timers = []
    progress.stopAnimation()
  }
  useEffect(
    () => () => {
      for (const timer of hold.timers) clearTimeout(timer)
    },
    [hold]
  )

  const off = busy || disabled
  // A hold under way when the pill is turned off is let go.
  useEffect(() => {
    if (!disabled || hold.timers.length === 0) return
    for (const timer of hold.timers) clearTimeout(timer)
    hold.timers = []
    progress.stopAnimation()
    progress.setValue(0)
  }, [disabled, hold, progress])

  const start = (): void => {
    if (off) return
    stop()
    progress.setValue(0)
    if (reduced)
      for (let step = 1; step < 4; ++step)
        hold.timers.push(
          setTimeout(() => {
            progress.setValue(step / 4)
          }, step * STEP_MS)
        )
    else
      Animated.timing(progress, {
        toValue: 1,
        duration: HOLD_MS,
        // Linear: the trace moves at the pace of the clock it stands for.
        easing: value => value,
        useNativeDriver: false
      }).start()
    hold.timers.push(
      setTimeout(() => {
        hold.timers = []
        progress.stopAnimation()
        progress.setValue(1)
        lightHaptic(view.current)
        onConfirm()
      }, HOLD_MS)
    )
  }

  const release = (): void => {
    if (hold.timers.length === 0) return
    stop()
    progress.setValue(0)
  }

  const label = busy ? lstrings.tess_confirming : lstrings.tess_hold_confirm
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint={lstrings.tess_hold_hint}
      accessibilityState={{ disabled: off, busy }}
      disabled={off}
      onPressIn={start}
      onPressOut={release}
      style={{ alignSelf: 'flex-start' }}
    >
      <View
        ref={view}
        testID="Tess hold"
        style={[styles.pill, { width, height }]}
      >
        <Svg width={width} height={height} style={styles.outline}>
          <Rect
            {...outline}
            rx={outline.height / 2}
            ry={outline.height / 2}
            fill="none"
            stroke={theme.defaultBorderColor}
            strokeWidth={STROKE}
          />
          <AnimatedRect
            testID="Tess hold trace"
            {...outline}
            rx={outline.height / 2}
            ry={outline.height / 2}
            fill="none"
            stroke={theme.successColor}
            strokeWidth={STROKE}
            strokeDasharray={`${perimeter} ${perimeter}`}
            strokeDashoffset={progress.interpolate({
              inputRange: [0, 1],
              outputRange: [perimeter, 0]
            })}
          />
        </Svg>
        <Text
          numberOfLines={1}
          adjustsFontSizeToFit
          style={[styles.label, { paddingHorizontal: pillPadding(height) }]}
        >
          {label}
        </Text>
      </View>
    </Pressable>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  pill: {
    borderRadius: theme.radiusPill,
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.cardBackgroundColor
  },
  outline: { position: 'absolute', left: 0, top: 0, pointerEvents: 'none' },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '600',
    color: theme.primaryTextColor
  }
}))
