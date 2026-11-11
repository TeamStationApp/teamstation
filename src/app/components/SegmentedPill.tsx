import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  PanResponder,
  Platform,
  Pressable,
  Text,
  View
} from 'react-native'

import { pillPadding } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * A content-width capsule's height in rem, 26 points, and its labels' size,
 * 12 points: small enough that a row's name keeps two lines beside it on a
 * 402-point phone.
 */
const CONTENT_HEIGHT_REM = 1.625
const CONTENT_LABEL_REM = 0.75
/** Points a content-width choice's target reaches above and below, to 48. */
const CONTENT_HIT_SLOP = 11

export interface SegmentedPillOption<Id> {
  id: Id
  label: string
}

/** Where a choice sits along the capsule, from its left end. */
interface Span {
  x: number
  width: number
}

/**
 * The selection a fill's left edge at `left` stands for, between the choices'
 * left edges `offsets`: a whole index on a choice, a fraction between two,
 * and the end choice beyond either end.
 */
export function pillIndexAt(offsets: readonly number[], left: number): number {
  const last = offsets.length - 1
  if (left <= offsets[0]) return 0
  if (left >= offsets[last]) return last
  let at = 0
  while (left > offsets[at + 1]) at++
  return at + (left - offsets[at]) / (offsets[at + 1] - offsets[at])
}

/**
 * One capsule of two to four choices with a sliding selected region, tapped
 * or dragged. By default it fills the width it is given, the choices sharing
 * it equally. `fit="content"` makes it only as wide as its labels, in
 * smaller type: each choice is its own label's width plus the pill padding,
 * and the selected region slides and resizes between them, for a capsule at
 * a row's right.
 */
export function SegmentedPill<Id extends string | number>({
  options,
  selected,
  onSelect,
  accessibilityLabel,
  disabled = false,
  fit = 'fill'
}: {
  /** Two to four. */
  options: ReadonlyArray<SegmentedPillOption<Id>>
  selected: Id
  onSelect: (id: Id) => void
  accessibilityLabel: string
  disabled?: boolean
  fit?: 'fill' | 'content'
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const content = fit === 'content'
  const found = options.findIndex(option => option.id === selected)
  const index = found < 0 ? 0 : found
  const position = useRef(new Animated.Value(index)).current
  const previous = useRef(index)
  const [width, setWidth] = useState(0)
  const [measured, setMeasured] = useState<Array<Span | undefined>>([])
  const spans: Span[] = options.map((_option, at) =>
    content
      ? (measured[at] ?? { x: 0, width: 0 })
      : { x: (at * width) / options.length, width: width / options.length }
  )
  const ready = width > 0 && spans.every(span => span.width > 0)
  // A width cannot be animated natively, so a content-width fill slides in JS.
  const useNativeDriver = Platform.OS !== 'web' && !content
  const current = useRef({ index, ready, spans, disabled, options, onSelect })
  current.current = { index, ready, spans, disabled, options, onSelect }
  const origin = useRef(index)
  const dragged = useRef(index)
  /**
   * From where the finger let go to the nearer choice. The selection effect
   * then finds the pill already heading there, so it never jumps back first.
   */
  const release = (): void => {
    const held = current.current
    const next = held.disabled ? held.index : Math.round(dragged.current)
    if (next !== held.index) {
      previous.current = next
      held.onSelect(held.options[next].id)
    }
    Animated.timing(position, {
      toValue: next,
      duration: 220,
      useNativeDriver
    }).start()
  }
  const released = useRef(release)
  released.current = release
  // Match the RSVP capsule's horizontal gesture capture, leaving vertical scroll alone.
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          !current.current.disabled &&
          current.current.ready &&
          Math.abs(gesture.dx) > 5 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderGrant: () => {
          position.stopAnimation()
          origin.current = current.current.index
          dragged.current = origin.current
        },
        onPanResponderMove: (_event, gesture) => {
          const offsets = current.current.spans.map(span => span.x)
          dragged.current = pillIndexAt(
            offsets,
            offsets[origin.current] + gesture.dx
          )
          position.setValue(dragged.current)
        },
        // Once grabbed, the pill keeps the finger however far it strays up
        // or down, until it lets go; a scroll view cannot take it.
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: () => {
          released.current()
        },
        onPanResponderTerminate: () => {
          released.current()
        }
      }),
    [position]
  )
  useEffect(() => {
    if (previous.current === index) return
    previous.current = index
    const animation = Animated.timing(position, {
      toValue: index,
      duration: 220,
      useNativeDriver
    })
    animation.start()
    return () => {
      animation.stop()
    }
  }, [index, position, useNativeDriver])
  const inputRange = options.map((_option, at) => at)
  const slide = {
    translateX: position.interpolate({
      inputRange,
      outputRange: spans.map(span => span.x)
    })
  }
  return (
    <View
      testID="segmented-pill"
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      {...pan.panHandlers}
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
      }}
      style={content ? styles.contentTrack : styles.track}
    >
      <Animated.View
        testID="segmented-pill-fill"
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[
          styles.fill,
          content
            ? {
                width: position.interpolate({
                  inputRange,
                  outputRange: spans.map(span => span.width)
                }),
                transform: [slide]
              }
            : { width: `${100 / options.length}%` as const, transform: [slide] }
        ]}
      />
      {options.map((option, at) => {
        const active = selected === option.id
        return (
          <Pressable
            key={String(option.id)}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active, disabled }}
            aria-selected={active}
            aria-disabled={disabled}
            disabled={disabled}
            hitSlop={
              content
                ? { top: CONTENT_HIT_SLOP, bottom: CONTENT_HIT_SLOP }
                : undefined
            }
            onLayout={
              content
                ? event => {
                    const { x, width: wide } = event.nativeEvent.layout
                    setMeasured(all => {
                      const was = all[at]
                      if (was?.x === x && was.width === wide) return all
                      const next = [...all]
                      next[at] = { x, width: wide }
                      return next
                    })
                  }
                : undefined
            }
            onPress={() => {
              if (!active) onSelect(option.id)
            }}
            style={({ pressed }) => [
              content ? styles.contentRegion : styles.region,
              pressed && styles.pressed
            ]}
          >
            <Text
              numberOfLines={1}
              selectable={false}
              style={[
                styles.label,
                content && styles.contentLabel,
                active && styles.activeLabel
              ]}
            >
              {option.label}
            </Text>
          </Pressable>
        )
      })}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  track: {
    flexDirection: 'row',
    position: 'relative',
    width: '100%',
    maxWidth: theme.rem(27),
    borderRadius: theme.radiusPill,
    overflow: 'hidden',
    backgroundColor: theme.sliderTrackBackground
  },
  contentTrack: {
    flexDirection: 'row',
    position: 'relative',
    flexShrink: 0,
    borderRadius: theme.radiusPill,
    overflow: 'hidden',
    backgroundColor: theme.sliderTrackBackground
  },
  fill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    borderRadius: theme.radiusPill,
    backgroundColor: theme.pillActiveBackground
  },
  region: {
    flex: 1,
    minHeight: theme.rem(3),
    paddingHorizontal: theme.rem(0.5),
    alignItems: 'center',
    justifyContent: 'center'
  },
  // Each label clears the selected region's round ends.
  contentRegion: {
    height: theme.rem(CONTENT_HEIGHT_REM),
    paddingHorizontal: pillPadding(theme.rem(CONTENT_HEIGHT_REM)),
    alignItems: 'center',
    justifyContent: 'center'
  },
  pressed: { opacity: 0.85 },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    color: theme.pillTextColor
  },
  contentLabel: { fontSize: theme.rem(CONTENT_LABEL_REM) },
  activeLabel: { color: '#ffffff' }
}))
