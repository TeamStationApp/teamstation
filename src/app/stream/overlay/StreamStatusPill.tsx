import React, { useEffect } from 'react'
import { StyleSheet, Text, View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  interpolateColor,
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withTiming
} from 'react-native-reanimated'

import { useMotionPreference } from '../../components/useMotionPreference'
import { lstrings } from '../../locales/strings'
import type { PhoneStreamStatus } from '../phoneStreamClient'
import {
  ENDED_RED,
  IDLE_BLUE,
  IDLE_PILL,
  LIVE_PILL,
  PILL_HEIGHT,
  PILL_RADIUS,
  PULSE_BRIGHT,
  PULSE_DARK,
  PULSE_SECONDS,
  ROUNDED_FONT,
  WHITE
} from './overlayTheme'

/** What the pill says, and how. */
export type PillState =
  | { kind: 'idle'; text: string; color: string }
  | { kind: 'connecting'; text: string; colors: [string, string] }
  | { kind: 'live'; text: string; colors: [string, string] }
  | { kind: 'ended'; text: string; color: string }

/**
 * The pill for the engine's state.
 *
 * - Not recording: blue, "Press record to start stream", in place of
 *   Cameraman's idle pill.
 * - Recording while the stream dials, or redials after a drop: Cameraman's
 *   pulsing red, reading "Connecting".
 * - Publishing: the same pulsing red with the white square, "Broadcasting".
 * - Somebody ended this camera on the server: "Stream ended". The recording
 *   goes on, and the engine dials no more until Record is pressed again.
 */
export function pillFor(status: PhoneStreamStatus | null): PillState {
  if (status?.error === 'streamEnded')
    return { kind: 'ended', text: lstrings.stream_pill_ended, color: ENDED_RED }
  if (status?.phase === 'live')
    return {
      kind: 'live',
      text: lstrings.stream_pill_live,
      colors: [PULSE_DARK, PULSE_BRIGHT]
    }
  if (
    status != null &&
    (status.phase === 'connecting' ||
      status.phase === 'retrying' ||
      status.isRecording)
  )
    return {
      kind: 'connecting',
      text: lstrings.stream_pill_connecting,
      colors: [PULSE_DARK, PULSE_BRIGHT]
    }
  return { kind: 'idle', text: lstrings.stream_pill_idle, color: IDLE_BLUE }
}

export interface StreamStatusPillProps {
  status: PhoneStreamStatus | null
}

/** The stream's state, at the left of the thermal pill and as tall as it. */
export function StreamStatusPill(
  props: StreamStatusPillProps
): React.ReactElement {
  const pill = pillFor(props.status)
  if (pill.kind === 'idle' || pill.kind === 'ended')
    return (
      <View
        testID="stream-status-pill"
        pointerEvents="none"
        style={[
          styles.pill,
          pill.kind === 'idle' ? styles.idle : styles.wide,
          { backgroundColor: pill.color }
        ]}
      >
        <Text
          style={pill.kind === 'idle' ? styles.idleText : styles.liveText}
          numberOfLines={1}
        >
          {pill.text}
        </Text>
      </View>
    )
  return <PulsingPill text={pill.text} square={pill.kind === 'live'} />
}

/** Cameraman's broadcasting pill: two reds, 0.7 s each way, eased. */
function PulsingPill(props: {
  text: string
  square: boolean
}): React.ReactElement {
  const { text, square } = props
  const still = useMotionPreference()
  const pulse = useSharedValue(0)
  const animated = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(
      pulse.value,
      [0, 1],
      [PULSE_DARK, PULSE_BRIGHT]
    )
  }))
  useEffect(() => {
    pulse.value = 0
    if (!still)
      pulse.value = withRepeat(
        withTiming(1, {
          duration: PULSE_SECONDS * 1000,
          easing: Easing.inOut(Easing.ease)
        }),
        -1,
        true
      )
    return () => {
      cancelAnimation(pulse)
    }
  }, [pulse, still])
  return (
    <Animated.View
      testID="stream-status-pill"
      pointerEvents="none"
      style={[styles.pill, styles.wide, animated]}
    >
      {square ? <View style={styles.square} /> : null}
      <Text style={styles.liveText} numberOfLines={1}>
        {text}
      </Text>
    </Animated.View>
  )
}

const styles = StyleSheet.create({
  pill: {
    height: PILL_HEIGHT,
    borderRadius: PILL_RADIUS,
    flexDirection: 'row',
    alignItems: 'center',
    gap: LIVE_PILL.gap
  },
  idle: {
    paddingHorizontal: IDLE_PILL.paddingHorizontal
  },
  wide: {
    paddingHorizontal: LIVE_PILL.paddingHorizontal
  },
  idleText: {
    fontFamily: ROUNDED_FONT,
    fontSize: IDLE_PILL.fontSize,
    fontWeight: '800',
    letterSpacing: IDLE_PILL.letterSpacing,
    color: WHITE
  },
  liveText: {
    fontFamily: ROUNDED_FONT,
    fontSize: LIVE_PILL.fontSize,
    fontWeight: '800',
    letterSpacing: LIVE_PILL.letterSpacing,
    color: WHITE
  },
  square: {
    width: LIVE_PILL.square,
    height: LIVE_PILL.square,
    borderRadius: LIVE_PILL.squareRadius,
    backgroundColor: WHITE
  }
})
