import React, { useEffect, useRef, useState } from 'react'
import { Animated, Easing, Platform, View } from 'react-native'

import { useMotionPreference } from '../components/useMotionPreference'
import type { LevelSource } from './useTessMicrophone'

/** How many samples the strip holds: one per frame of audio. */
export const WAVE_SAMPLES = 24
/** About how often the microphone reports a frame, and so a sample. */
export const WAVE_FRAME_MS = 100
/** How long a sample takes to grow from a dot into its line. */
export const WAVE_GROW_MS = 150
/** A sample at silence: a dot this wide and this tall. */
export const WAVE_DOT = 3
/** The least distance between samples: twice a dot, so bars never touch. */
export const WAVE_MIN_SPACING = 2 * WAVE_DOT
/** The left part of the strip, as a fraction of it, over which a sample fades out. */
const FADE = 0.5

/**
 * How long one run of the scroll lasts: past it every bar heard before it
 * started has left the strip, so with nothing more heard it stops. Each
 * sample heard starts another.
 */
const SCROLL_MS = (WAVE_SAMPLES + 1) * WAVE_FRAME_MS
/** The platforms whose animations run natively, off the JavaScript thread. */
const NATIVE_DRIVER = Platform.OS !== 'web'

interface Sample {
  key: number
  level: number
  /** `performance.now()` when it was heard. */
  at: number
}

/** How tall a level draws, 0 to 1: speech is quiet, so its root is shown. */
export function waveHeight(level: number, lineHeight: number): number {
  const shown = Math.min(1, Math.sqrt(Math.max(0, level)) * 2)
  return Math.max(WAVE_DOT, shown * lineHeight)
}

/**
 * What the microphone hears while Tess records, as a strip of bars: each
 * frame's loudness enters at the right edge as a dot, grows into a line as
 * tall as it was loud, and scrolls left, fading out as it reaches the left
 * edge. The strip moves on between frames, so it scrolls smoothly. With
 * reduced motion the bars stand in their places and only their heights
 * change as each new frame comes in.
 *
 * Each bar has a fixed place along the strip, from when it was heard, and
 * the strip slides left under them as one animated value (`scroll`), on the
 * native driver where there is one; a bar's growth and fade are read from
 * that value too. So the waveform draws again only when a sample comes in,
 * never each frame, and nothing runs until the strip knows its width.
 */
export function TessWaveform({
  levels,
  height,
  color
}: {
  levels: LevelSource
  /** The line it is drawn on: its tallest bar. */
  height: number
  color: string
}): React.ReactElement {
  const reduced = useMotionPreference()
  const [width, setWidth] = useState(0)
  const [samples, setSamples] = useState<Sample[]>([])
  // When the strip began, from which each bar's place along it is fixed.
  const [origin] = useState(() => performance.now())
  const scroll = useRef(new Animated.Value(0)).current
  useEffect(() => {
    let key = 0
    return levels.subscribe(level => {
      const at = performance.now()
      setSamples(current => [
        ...current.slice(-(WAVE_SAMPLES - 1)),
        { key: key++, level, at }
      ])
    })
  }, [levels])

  // A narrow strip shows fewer samples rather than crowding them into a blot.
  const spacing = Math.max(width / WAVE_SAMPLES, WAVE_MIN_SPACING)
  // How far the strip slides each millisecond.
  const speed = spacing / WAVE_FRAME_MS
  useEffect(() => {
    if (reduced || width === 0 || samples.length === 0) return
    const offset = (time: number): number => -(time - origin) * speed
    const time = performance.now()
    scroll.setValue(offset(time))
    const run = Animated.timing(scroll, {
      toValue: offset(time + SCROLL_MS),
      duration: SCROLL_MS,
      // Steadily, as the samples come.
      easing: value => Easing.linear(value),
      useNativeDriver: NATIVE_DRIVER
    })
    run.start()
    return () => {
      run.stop()
    }
  }, [samples, width, reduced, origin, speed, scroll])

  const right = width - WAVE_DOT / 2
  const fade = width * FADE
  const bars = samples.map((sample, index) => {
    const tall = waveHeight(sample.level, height)
    const box = {
      position: 'absolute' as const,
      top: (height - tall) / 2,
      width: WAVE_DOT,
      height: tall,
      borderRadius: WAVE_DOT / 2,
      backgroundColor: color
    }
    if (reduced) {
      const x = right - (samples.length - 1 - index) * spacing
      if (x < 0) return null
      return (
        <View
          key={sample.key}
          testID="Tess wave bar"
          style={{
            ...box,
            left: x - WAVE_DOT / 2,
            opacity: Math.min(1, x / fade)
          }}
        />
      )
    }
    // Its middle along the strip; on the screen, that plus `scroll`.
    const x = right + (sample.at - origin) * speed
    // `scroll` when it was heard, and once it has grown.
    const heard = -(sample.at - origin) * speed
    return (
      <Animated.View
        key={sample.key}
        testID="Tess wave bar"
        style={{
          ...box,
          left: x - WAVE_DOT / 2,
          opacity: scroll.interpolate({
            inputRange: [-x, fade - x],
            outputRange: [0, 1],
            extrapolate: 'clamp'
          }),
          transform: [
            {
              scaleY: scroll.interpolate({
                inputRange: [heard - WAVE_GROW_MS * speed, heard],
                outputRange: [1, WAVE_DOT / tall],
                extrapolate: 'clamp'
              })
            }
          ]
        }}
      />
    )
  })
  return (
    <View
      testID="Tess waveform"
      accessible={false}
      importantForAccessibility="no-hide-descendants"
      style={{
        width: '100%',
        height,
        pointerEvents: 'none',
        overflow: 'hidden'
      }}
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
      }}
    >
      {width > 0 && (
        <Animated.View
          testID="Tess wave strip"
          style={{
            position: 'absolute',
            top: 0,
            left: 0,
            width,
            height,
            transform: [{ translateX: reduced ? 0 : scroll }]
          }}
        >
          {bars}
        </Animated.View>
      )}
    </View>
  )
}
