import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  type NativeSyntheticEvent,
  PanResponder,
  Platform,
  Pressable,
  Text,
  type TextProps,
  useWindowDimensions,
  View
} from 'react-native'

import type { Rsvp, RsvpChoice } from '../../common/eventInfo'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  clampRsvpPosition,
  RSVP_COLORS,
  rsvpAtPosition,
  rsvpKeyboardPosition,
  rsvpPosition
} from './eventRsvpPosition'
import { useMotionPreference } from './useMotionPreference'

/**
 * What a one-line label adds to its `Text`. A phone shrinks the label a
 * little before it would wrap. A browser cannot shrink it, and would cut it
 * off instead, so there it fits at its own size and wraps only when the text
 * is enlarged.
 */
export function oneLineLabelProps(
  oneLine: boolean,
  os: string = Platform.OS
): Partial<TextProps> {
  return oneLine && os !== 'web'
    ? { numberOfLines: 1, adjustsFontSizeToFit: true, minimumFontScale: 0.85 }
    : {}
}

/** A continuous three-position response capsule, shared by browser and phones. */
export function EventRsvpPill({
  value,
  onChange,
  name,
  userId,
  disabled = false,
  labels,
  groupLabel,
  selectedColor,
  testID,
  widthRem = 14.25,
  disabledChoices = [],
  labelSizeRem,
  oneLineLabels = false
}: {
  value: RsvpChoice
  onChange: (response: Rsvp) => void
  name: string
  userId: number
  disabled?: boolean
  labels?: readonly [string, string, string]
  groupLabel?: string
  selectedColor?: string
  testID?: string
  widthRem?: number
  disabledChoices?: readonly number[]
  labelSizeRem?: number
  /**
   * Each label stays on one line: the capsule is given the width its longest
   * label needs, and on phones a label shrinks a little before it would wrap.
   * Its padding stays the fill's radius, so no glyph reaches the rounded ends.
   */
  oneLineLabels?: boolean
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const { fontScale } = useWindowDimensions()
  const reducedMotion = useMotionPreference()
  const position = useRef(new Animated.Value(rsvpPosition(value))).current
  const [width, setWidth] = useState(0)
  const [dragging, setDragging] = useState(false)
  const selected = rsvpPosition(value)
  const current = useRef({
    selected,
    value,
    disabled,
    width,
    onChange,
    disabledChoices
  })
  current.current = {
    selected,
    value,
    disabled,
    width,
    onChange,
    disabledChoices
  }
  const origin = useRef(selected)
  const dragged = useRef(selected)
  const settle = (index: number): void => {
    const animation = Animated.timing(position, {
      toValue: index,
      duration: reducedMotion ? 0 : 180,
      useNativeDriver: false
    })
    animation.start()
  }
  useEffect(() => {
    const animation = Animated.timing(position, {
      toValue: selected,
      duration: reducedMotion ? 0 : 180,
      useNativeDriver: false
    })
    animation.start()
    return () => {
      animation.stop()
    }
  }, [position, selected, reducedMotion])
  const choose = (index: number): void => {
    const held = current.current
    if (
      held.disabled ||
      held.disabledChoices.includes(index) ||
      (held.value == null && index === 1)
    )
      return
    if (index !== held.selected) held.onChange(rsvpAtPosition(index))
  }
  /** From where the finger let go to the nearest choice it may take. */
  const release = (): void => {
    const next = Math.round(dragged.current)
    const held = current.current
    setDragging(false)
    if (
      !held.disabled &&
      !held.disabledChoices.includes(next) &&
      (held.value != null || next !== 1) &&
      next !== held.selected
    ) {
      held.onChange(rsvpAtPosition(next))
      settle(next)
    } else settle(held.selected)
  }
  const released = useRef(release)
  released.current = release
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          !current.current.disabled &&
          current.current.width > 0 &&
          Math.abs(gesture.dx) > 5 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderGrant: () => {
          position.stopAnimation()
          origin.current = current.current.selected
          dragged.current = origin.current
          setDragging(true)
        },
        onPanResponderMove: (_event, gesture) => {
          dragged.current = clampRsvpPosition(
            origin.current + gesture.dx / (current.current.width / 3)
          )
          position.setValue(dragged.current)
        },
        // Once grabbed, the capsule keeps the finger however far it strays
        // up or down, until it lets go; a scroll view cannot take it.
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
  const options = labels ?? ['Yes', value == null ? 'No reply' : 'Maybe', 'No']
  const id = testID ?? `event-rsvp-${userId}`
  return (
    <View
      testID={id}
      accessibilityRole="radiogroup"
      accessibilityLabel={groupLabel ?? `${name} RSVP`}
      {...pan.panHandlers}
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
      }}
      style={[
        styles.track,
        { width: theme.rem(widthRem) * Math.max(1, fontScale) },
        disabled && styles.disabled
      ]}
    >
      <View pointerEvents="none" style={styles.surface} />
      <Animated.View
        testID={`${id}-fill`}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[
          styles.fill,
          {
            backgroundColor: position.interpolate({
              inputRange: [0, 1, 2],
              outputRange:
                selectedColor != null
                  ? [selectedColor, selectedColor, selectedColor]
                  : [...RSVP_COLORS],
              extrapolate: 'clamp'
            }),
            transform: [
              {
                translateX: position.interpolate({
                  inputRange: [0, 2],
                  outputRange: [0, (width * 2) / 3],
                  extrapolate: 'clamp'
                })
              }
            ]
          }
        ]}
      />
      {options.map((label, index) => (
        <Pressable
          key={index}
          testID={`${id}-${index}`}
          accessibilityRole="radio"
          accessibilityLabel={
            groupLabel == null ? `${label} for ${name}` : label
          }
          accessibilityState={{
            checked: selected === index,
            disabled: disabled || disabledChoices.includes(index)
          }}
          aria-checked={selected === index}
          aria-disabled={disabled || disabledChoices.includes(index)}
          disabled={disabled || disabledChoices.includes(index)}
          {...(Platform.OS === 'web'
            ? {
                tabIndex: disabled || selected !== index ? -1 : 0,
                onKeyDown: (event: NativeSyntheticEvent<unknown>) => {
                  const keyboard = event as unknown as {
                    key?: string
                    nativeEvent?: { key?: string }
                    currentTarget: {
                      parentElement?: {
                        querySelectorAll: (
                          selector: string
                        ) => ArrayLike<{ focus: () => void }>
                      }
                    }
                  }
                  const next = rsvpKeyboardPosition(
                    keyboard.key ?? keyboard.nativeEvent?.key ?? '',
                    index
                  )
                  if (
                    disabled ||
                    next == null ||
                    disabledChoices.includes(next)
                  )
                    return
                  event.preventDefault()
                  choose(next)
                  if (!(value == null && next === 1)) settle(next)
                  keyboard.currentTarget.parentElement
                    ?.querySelectorAll('[role="radio"]')
                    [next]?.focus()
                }
              }
            : {})}
          onPress={() => {
            choose(index)
            if (!disabled && !(value == null && index === 1)) settle(index)
          }}
          style={[styles.choice, oneLineLabels && styles.oneLineChoice]}
        >
          <Text
            selectable={false}
            {...oneLineLabelProps(oneLineLabels)}
            style={[
              styles.label,
              labelSizeRem == null
                ? undefined
                : { fontSize: theme.rem(labelSizeRem) },
              selected === index && !dragging && styles.selected
            ]}
          >
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  track: {
    width: theme.rem(14.25),
    maxWidth: '100%',
    flexDirection: 'row',
    borderRadius: theme.rem(1),
    overflow: 'hidden',
    position: 'relative'
  },
  surface: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: theme.rem(0.375),
    bottom: theme.rem(0.375),
    borderRadius: theme.rem(1),
    backgroundColor: theme.pillBackground
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: theme.rem(0.375),
    bottom: theme.rem(0.375),
    width: '33.333333%',
    borderRadius: theme.rem(1)
  },
  choice: {
    flex: 1,
    minWidth: 0,
    minHeight: theme.rem(2.75),
    paddingHorizontal: theme.rem(1.125),
    paddingVertical: theme.rem(0.5),
    alignItems: 'center',
    justifyContent: 'center'
  },
  oneLineChoice: { paddingHorizontal: theme.rem(1) },
  label: {
    maxWidth: '100%',
    flexShrink: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    lineHeight: theme.rem(0.875),
    color: theme.primaryTextColor,
    textAlign: 'center'
  },
  selected: { color: '#ffffff' },
  disabled: { opacity: 0.65 }
}))
