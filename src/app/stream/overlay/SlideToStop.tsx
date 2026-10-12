import React, { useEffect, useMemo, useState } from 'react'
import {
  type GestureResponderEvent,
  StyleSheet,
  Text,
  View
} from 'react-native'
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
import {
  LIVE_PILL,
  PULSE_BRIGHT,
  PULSE_DARK,
  PULSE_SECONDS,
  ROUNDED_FONT,
  SLIDE,
  WHITE
} from './overlayTheme'

/** How far the knob has to travel before letting go stops the recording. */
export function slideCommits(progress: number): boolean {
  return progress >= SLIDE.commitFraction
}

/** How far the knob can travel: the track, less the knob and its insets. */
export const SLIDE_TRAVEL = SLIDE.trackWidth - SLIDE.knob - 2 * SLIDE.knobInset

export interface SlideGesture {
  start: (x: number) => void
  move: (x: number) => void
  end: () => void
}

/**
 * The knob's drag: it follows the finger to the right, between the track's
 * ends, and on release either commits (at 80 % of the way or more) or goes
 * back to the start.
 */
export function slideGesture(
  onOffset: (offset: number) => void,
  onStop: () => void,
  travel: number = SLIDE_TRAVEL
): SlideGesture {
  let from: number | null = null
  let offset = 0
  return {
    start: x => {
      from = x
      offset = 0
    },
    move: x => {
      if (from == null) return
      offset = Math.min(Math.max(x - from, 0), travel)
      onOffset(offset)
    },
    end: () => {
      if (from == null) return
      from = null
      if (slideCommits(offset / travel)) {
        onOffset(travel)
        onStop()
      } else {
        onOffset(0)
      }
      offset = 0
    }
  }
}

/** A view's responder props that hand a finger's movement across it to `gesture`. */
export function slideResponder(gesture: SlideGesture): {
  onStartShouldSetResponder: () => boolean
  onMoveShouldSetResponder: () => boolean
  onResponderTerminationRequest: () => boolean
  onResponderGrant: (event: GestureResponderEvent) => void
  onResponderMove: (event: GestureResponderEvent) => void
  onResponderRelease: () => void
  onResponderTerminate: () => void
} {
  return {
    onStartShouldSetResponder: () => true,
    onMoveShouldSetResponder: () => true,
    onResponderTerminationRequest: () => false,
    onResponderGrant: event => {
      gesture.start(event.nativeEvent.pageX)
    },
    onResponderMove: event => {
      gesture.move(event.nativeEvent.pageX)
    },
    onResponderRelease: () => {
      gesture.end()
    },
    onResponderTerminate: () => {
      gesture.end()
    }
  }
}

export interface SlideToStopProps {
  onStop: () => void
}

/**
 * Stopping takes a slide, so a knock on the screen in a dugout does not end
 * the recording: a 272×58 track whose pulsing knob has to be dragged 80 % of
 * the way across. Starting stays one tap.
 */
export function SlideToStop(props: SlideToStopProps): React.ReactElement {
  const { onStop } = props
  const [offset, setOffset] = useState(0)
  const gesture = useMemo(() => slideGesture(setOffset, onStop), [onStop])
  const still = useMotionPreference()
  const pulse = useSharedValue(0)
  const knobColor = useAnimatedStyle(() => ({
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
    <View
      testID="slide-to-stop-track"
      accessibilityValue={{
        text: `${Math.round((offset / SLIDE_TRAVEL) * 100)} percent`
      }}
      style={styles.track}
      {...slideResponder(gesture)}
    >
      <Text
        testID="slide-to-stop-label"
        style={styles.slideLabel}
        numberOfLines={1}
      >
        {lstrings.stream_slide_to_stop}
      </Text>
      <Animated.View
        testID="slide-to-stop-knob"
        pointerEvents="none"
        style={[
          styles.knob,
          { transform: [{ translateX: SLIDE.knobInset + offset }] },
          knobColor
        ]}
      >
        <View style={styles.knobSquare} />
      </Animated.View>
    </View>
  )
}

const styles = StyleSheet.create({
  track: {
    width: SLIDE.trackWidth,
    height: SLIDE.trackHeight,
    borderRadius: SLIDE.trackRadius,
    backgroundColor: SLIDE.trackColor,
    justifyContent: 'center'
  },
  slideLabel: {
    position: 'absolute',
    left: SLIDE.knobInset + SLIDE.knob,
    right: SLIDE.labelTrailing,
    textAlign: 'center',
    fontFamily: ROUNDED_FONT,
    fontSize: SLIDE.fontSize,
    fontWeight: '600',
    color: WHITE
  },
  knob: {
    position: 'absolute',
    left: 0,
    width: SLIDE.knob,
    height: SLIDE.knob,
    borderRadius: SLIDE.knobRadius,
    alignItems: 'center',
    justifyContent: 'center'
  },
  knobSquare: {
    width: LIVE_PILL.square,
    height: LIVE_PILL.square,
    borderRadius: LIVE_PILL.squareRadius,
    backgroundColor: WHITE
  }
})
