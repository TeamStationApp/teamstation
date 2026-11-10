import React, { useMemo, useRef, useState } from 'react'
import { PanResponder, Pressable, Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'

/** A compact, horizontally draggable count with a full-height touch target. */
export function OverrideCountSlider({
  label,
  max,
  value,
  onChange
}: {
  label: string
  max: number
  value: number
  onChange: (value: number) => void
}): React.ReactElement {
  const theme = useTheme()
  const [dragged, setDragged] = useState<number | null>(null)
  const current = useRef({ value, max, onChange })
  current.current = { value, max, onChange }
  const origin = useRef(0)
  const pending = useRef(0)
  const pan = useMemo(
    () =>
      PanResponder.create({
        onMoveShouldSetPanResponderCapture: (_event, gesture) =>
          Math.abs(gesture.dx) > 5 &&
          Math.abs(gesture.dx) > Math.abs(gesture.dy),
        onPanResponderGrant: () => {
          origin.current = current.current.value
          pending.current = origin.current
          setDragged(origin.current)
        },
        onPanResponderMove: (_event, gesture) => {
          pending.current = Math.max(
            0,
            Math.min(current.current.max, origin.current + gesture.dx / 44)
          )
          setDragged(pending.current)
        },
        onPanResponderTerminationRequest: () => false,
        onPanResponderRelease: () => {
          current.current.onChange(Math.round(pending.current))
          setDragged(null)
        },
        onPanResponderTerminate: () => {
          setDragged(null)
        }
      }),
    []
  )
  return (
    <View
      accessibilityRole="tablist"
      accessibilityLabel={label}
      {...pan.panHandlers}
      style={{ width: (max + 1) * 44, height: 44, justifyContent: 'center' }}
    >
      <View
        pointerEvents="none"
        style={{
          position: 'absolute',
          left: 0,
          right: 0,
          top: 6,
          height: 32,
          borderRadius: 16,
          backgroundColor: theme.sliderTrackBackground
        }}
      />
      <View
        pointerEvents="none"
        testID={`${label}-slider-fill`}
        style={{
          position: 'absolute',
          left: (dragged ?? value) * 44,
          top: 6,
          width: 44,
          height: 32,
          borderRadius: 16,
          backgroundColor: theme.pillActiveBackground
        }}
      />
      <View style={{ flexDirection: 'row' }}>
        {Array.from({ length: max + 1 }, (_, count) => (
          <Pressable
            key={count}
            accessibilityRole="tab"
            accessibilityLabel={`${label} ${count}`}
            accessibilityState={{ selected: count === value }}
            aria-selected={count === value}
            onPress={() => {
              onChange(count)
            }}
            style={{
              width: 44,
              height: 44,
              alignItems: 'center',
              justifyContent: 'center'
            }}
          >
            <Text
              selectable={false}
              style={{
                color:
                  count === Math.round(dragged ?? value)
                    ? '#ffffff'
                    : theme.primaryTextColor,
                fontFamily: theme.semiBoldTextFont
              }}
            >
              {count}
            </Text>
          </Pressable>
        ))}
      </View>
    </View>
  )
}
