import React, { useEffect, useMemo, useRef, useState } from 'react'
import {
  Animated,
  PanResponder,
  Platform,
  Pressable,
  Text,
  View
} from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/** One capsule with two equal choices and a sliding selected region. */
export function SegmentedPill<Id extends string>({
  options,
  selected,
  onSelect,
  accessibilityLabel,
  disabled = false
}: {
  options: readonly [{ id: Id; label: string }, { id: Id; label: string }]
  selected: Id
  onSelect: (id: Id) => void
  accessibilityLabel: string
  disabled?: boolean
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const index = selected === options[1].id ? 1 : 0
  const position = useRef(new Animated.Value(index)).current
  const previous = useRef(index)
  const [width, setWidth] = useState(0)
  const current = useRef({ index, width, disabled, options, onSelect })
  current.current = { index, width, disabled, options, onSelect }
  const origin = useRef(index)
  const dragged = useRef(index)
  // Match the RSVP capsule's horizontal gesture capture, leaving vertical scroll alone.
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
          origin.current = current.current.index
          dragged.current = origin.current
        },
        onPanResponderMove: (_event, gesture) => {
          dragged.current = Math.max(
            0,
            Math.min(
              1,
              origin.current + gesture.dx / (current.current.width / 2)
            )
          )
          position.setValue(dragged.current)
        },
        onPanResponderRelease: () => {
          const next = Math.round(dragged.current)
          const held = current.current
          if (!held.disabled && next !== held.index)
            held.onSelect(held.options[next].id)
          position.setValue(held.index)
        },
        onPanResponderTerminate: () => {
          position.setValue(current.current.index)
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
      useNativeDriver: Platform.OS !== 'web'
    })
    animation.start()
    return () => {
      animation.stop()
    }
  }, [index, position])
  return (
    <View
      testID="segmented-pill"
      accessibilityRole="tablist"
      accessibilityLabel={accessibilityLabel}
      {...pan.panHandlers}
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
      }}
      style={styles.track}
    >
      <Animated.View
        testID="segmented-pill-fill"
        pointerEvents="none"
        accessibilityElementsHidden
        importantForAccessibility="no"
        style={[
          styles.fill,
          {
            transform: [
              {
                translateX: position.interpolate({
                  inputRange: [0, 1],
                  outputRange: [0, width / 2]
                })
              }
            ]
          }
        ]}
      />
      {options.map(option => {
        const active = selected === option.id
        return (
          <Pressable
            key={option.id}
            accessibilityRole="tab"
            accessibilityLabel={option.label}
            accessibilityState={{ selected: active, disabled }}
            aria-selected={active}
            aria-disabled={disabled}
            disabled={disabled}
            onPress={() => {
              if (!active) onSelect(option.id)
            }}
            style={({ pressed }) => [styles.region, pressed && styles.pressed]}
          >
            <Text
              numberOfLines={1}
              selectable={false}
              style={[styles.label, active && styles.activeLabel]}
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
    backgroundColor: theme.pillBackground
  },
  fill: {
    position: 'absolute',
    top: 0,
    bottom: 0,
    left: 0,
    width: '50%',
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
  pressed: { opacity: 0.85 },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    color: theme.pillTextColor
  },
  activeLabel: { color: '#ffffff' }
}))
