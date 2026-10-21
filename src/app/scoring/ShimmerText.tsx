import React, { useEffect, useMemo, useState } from 'react'
import { type StyleProp, Text, type TextStyle, View } from 'react-native'
import Animated, {
  cancelAnimation,
  Easing,
  interpolateColor,
  type SharedValue,
  useAnimatedStyle,
  useSharedValue,
  withDelay,
  withRepeat,
  withTiming
} from 'react-native-reanimated'

import { useMotionPreference } from '../components/useMotionPreference'

/** How far past each end the highlight starts and stops, in text widths. */
const OVERSHOOT = 0.3
/** The highlight's half width, in text widths. */
const BAND = 0.12
/**
 * A row of characters, left to right whatever the layout direction: Android
 * lays a plain row out from the right on a right-to-left phone, which would
 * spell the text backwards.
 */
const ROW = { flexDirection: 'row', direction: 'ltr' } as const

/**
 * Where a character's colour peaks as the sweep's progress runs 0 to 1: the
 * highlight enters from the left of the text and leaves past its right.
 */
export function shimmerPeak(index: number, length: number): number {
  const centre = (index + 0.5) / length
  return (centre + OVERSHOOT) / (1 + 2 * OVERSHOOT)
}

/** The text's user-perceived characters, where the platform can say. */
function graphemes(text: string): string[] {
  if (typeof Intl.Segmenter === 'function')
    return Array.from(new Intl.Segmenter().segment(text), part => part.segment)
  return Array.from(text)
}

function ShimmerCharacter({
  character,
  peak,
  progress,
  style,
  color,
  highlight
}: {
  character: string
  peak: number
  progress: SharedValue<number>
  style: StyleProp<TextStyle>
  color: string
  highlight: string
}): React.ReactElement {
  const band = BAND / (1 + 2 * OVERSHOOT)
  const lit = useAnimatedStyle(() => ({
    color: interpolateColor(
      progress.value,
      [peak - band, peak, peak + band],
      [color, highlight, color]
    )
  }))
  return <Animated.Text style={[style, lit]}>{character}</Animated.Text>
}

/** Whether the line's natural width fits the room it has, once both are measured. */
export function shimmerFits(room?: number, natural?: number): boolean {
  return room != null && natural != null && natural <= room + 0.5
}

/**
 * One line of text that a highlight sweeps across, left to right, then rests
 * before the next sweep. Each character's colour rises to `highlight` as the
 * sweep passes it, so it needs no gradient or mask and runs the same on the
 * phones and the web. The characters cannot ellipsize, so the line sweeps only
 * once it is measured and found to fit; otherwise, with Reduce Motion on, or
 * while `active` is false, it is one still line that ellipsizes.
 */
export function ShimmerText({
  text,
  style,
  color,
  highlight,
  duration = 1400,
  rest = 1600,
  active = true,
  testID,
  accessibilityLabel
}: {
  text: string
  style?: StyleProp<TextStyle>
  color: string
  highlight: string
  duration?: number
  rest?: number
  /** Whether the line is on screen; a hidden one holds still. */
  active?: boolean
  testID?: string
  /**
   * What a screen reader hears for the row of characters, when the text is
   * not already inside a labelled control.
   */
  accessibilityLabel?: string
}): React.ReactElement {
  const reduced = useMotionPreference()
  const [room, setRoom] = useState<number>()
  const [natural, setNatural] = useState<number>()
  const sweeping = !reduced && active && shimmerFits(room, natural)
  const progress = useSharedValue(0)
  useEffect(() => {
    progress.value = 0
    if (sweeping)
      progress.value = withRepeat(
        withDelay(
          rest,
          withTiming(1, { duration, easing: Easing.inOut(Easing.quad) })
        ),
        -1
      )
    return () => {
      cancelAnimation(progress)
    }
  }, [progress, sweeping, duration, rest])
  const characters = useMemo(() => graphemes(text), [text])
  return (
    <View
      testID={testID}
      onLayout={event => {
        setRoom(event.nativeEvent.layout.width)
      }}
      style={{ minWidth: 0, overflow: 'hidden' }}
    >
      {/* The characters as the sweep draws them, one text each, at their
          natural width: unseen and unread. Separate texts lose kerning and
          round up apart, so the joined line would measure narrower. */}
      <View
        pointerEvents="none"
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          position: 'absolute',
          width: 10000,
          flexDirection: 'row',
          opacity: 0
        }}
      >
        <View
          testID={testID == null ? undefined : `${testID} measure`}
          onLayout={event => {
            setNatural(event.nativeEvent.layout.width)
          }}
          style={ROW}
        >
          {characters.map((character, index) => (
            <Text key={index} style={style}>
              {character}
            </Text>
          ))}
        </View>
      </View>
      {!reduced && shimmerFits(room, natural) ? (
        // One text per character, so each takes its own colour.
        <View
          {...(accessibilityLabel == null
            ? {}
            : {
                accessible: true,
                accessibilityRole: 'text' as const,
                accessibilityLabel
              })}
          style={ROW}
        >
          {characters.map((character, index) => (
            <ShimmerCharacter
              key={index}
              character={character}
              peak={shimmerPeak(index, characters.length)}
              progress={progress}
              style={style}
              color={color}
              highlight={highlight}
            />
          ))}
        </View>
      ) : (
        <Text
          numberOfLines={1}
          style={[style, { color }]}
          {...(accessibilityLabel == null ? {} : { accessibilityLabel })}
        >
          {text}
        </Text>
      )}
    </View>
  )
}
