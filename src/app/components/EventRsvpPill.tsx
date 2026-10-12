import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  type NativeSyntheticEvent,
  PanResponder,
  Platform,
  Pressable,
  Text,
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

/** A continuous three-position response capsule, shared by browser and phones. */
export function EventRsvpPill({
  value,
  onChange,
  name,
  userId,
  disabled = false
}: {
  value: RsvpChoice
  onChange: (response: Rsvp) => void
  name: string
  userId: number
  disabled?: boolean
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const reducedMotion = useMotionPreference()
  const position = useRef(new Animated.Value(rsvpPosition(value))).current
  const [width, setWidth] = useState(0)
  const [dragging, setDragging] = useState(false)
  const selected = rsvpPosition(value)
  const current = useRef({ selected, value, disabled, width, onChange })
  current.current = { selected, value, disabled, width, onChange }
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
    if (held.disabled || (held.value == null && index === 1)) return
    if (index !== held.selected) held.onChange(rsvpAtPosition(index))
  }
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
        onPanResponderRelease: () => {
          const next = Math.round(dragged.current)
          setDragging(false)
          if (
            !current.current.disabled &&
            (current.current.value != null || next !== 1) &&
            next !== current.current.selected
          )
            current.current.onChange(rsvpAtPosition(next))
          else position.setValue(current.current.selected)
        },
        onPanResponderTerminate: () => {
          setDragging(false)
          position.setValue(current.current.selected)
        }
      }),
    [position]
  )
  const options = ['Yes', value == null ? 'No reply' : 'Maybe', 'No']
  return (
    <View
      testID={`event-rsvp-${userId}`}
      accessibilityRole="radiogroup"
      accessibilityLabel={`${name} RSVP`}
      {...pan.panHandlers}
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
      }}
      style={[styles.track, disabled && styles.disabled]}
    >
      <Animated.View
        testID={`event-rsvp-${userId}-fill`}
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[
          styles.fill,
          {
            backgroundColor: position.interpolate({
              inputRange: [0, 1, 2],
              outputRange: [...RSVP_COLORS],
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
          testID={`event-rsvp-${userId}-${index}`}
          accessibilityRole="radio"
          accessibilityLabel={`${label} for ${name}`}
          accessibilityState={{ checked: selected === index, disabled }}
          aria-checked={selected === index}
          aria-disabled={disabled}
          disabled={disabled}
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
                  if (disabled || next == null) return
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
          style={styles.choice}
        >
          <Text
            selectable={false}
            style={[
              styles.label,
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
    width: theme.rem(12),
    maxWidth: '100%',
    flexDirection: 'row',
    borderRadius: theme.radiusPill,
    backgroundColor: theme.pillBackground,
    overflow: 'hidden',
    position: 'relative'
  },
  fill: {
    position: 'absolute',
    left: 0,
    top: 0,
    bottom: 0,
    width: '33.333333%',
    borderRadius: theme.radiusPill
  },
  choice: {
    flex: 1,
    minWidth: 0,
    minHeight: theme.rem(2.5),
    paddingHorizontal: theme.rem(0.25),
    alignItems: 'center',
    justifyContent: 'center'
  },
  label: {
    maxWidth: '100%',
    flexShrink: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    color: theme.primaryTextColor,
    textAlign: 'center'
  },
  selected: { color: '#ffffff' },
  disabled: { opacity: 0.65 }
}))
