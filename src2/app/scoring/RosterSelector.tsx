import React, { useEffect, useRef, useState } from 'react'
import {
  Animated,
  PanResponder,
  Platform,
  Pressable,
  Text,
  View
} from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { RosterSelectorDrag } from './RosterSelectorDrag'
export const rosterSegmentAt = (
  x: number,
  left: number,
  width: number
): number => (x - left < width / 2 ? 0 : 1)
export function RosterSelector({
  labels,
  value,
  onChange
}: {
  labels: [string, string]
  value: number
  onChange: (value: number) => void
}): React.ReactElement {
  const theme = useTheme()
  const [width, setWidth] = useState(0)
  const root = useRef<React.ComponentRef<typeof View>>(null)
  const left = useRef(0)
  const thumb = useRef(new Animated.Value(0)).current
  const latest = useRef({ value, width, onChange })
  latest.current = { value, width, onChange }
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, gesture) =>
        Math.abs(gesture.dx) > 6 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderMove: (_, gesture) => {
        thumb.setValue(
          Math.max(
            0,
            Math.min(
              latest.current.width / 2,
              gesture.moveX - left.current - latest.current.width / 4
            )
          )
        )
      },
      onPanResponderRelease: (_, gesture) => {
        latest.current.onChange(
          rosterSegmentAt(gesture.moveX, left.current, latest.current.width)
        )
        thumb.setValue(
          (rosterSegmentAt(gesture.moveX, left.current, latest.current.width) *
            latest.current.width) /
            2
        )
      },
      onPanResponderTerminate: () => {
        thumb.setValue((latest.current.value * latest.current.width) / 2)
      },
      onPanResponderTerminationRequest: () => false
    })
  ).current
  useEffect(() => {
    const animation = Animated.timing(thumb, {
      toValue: (value * width) / 2,
      duration: 150,
      useNativeDriver: false
    })
    animation.start()
    return () => {
      animation.stop()
    }
  }, [thumb, value, width])
  const content = (
    <View
      ref={root}
      {...(Platform.OS === 'web' ? {} : responder.panHandlers)}
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
        root.current?.measureInWindow(x => {
          left.current = x
        })
      }}
      style={{
        flexDirection: 'row',
        minHeight: 48,
        borderRadius: theme.radiusPill,
        backgroundColor: theme.scoringSelectorIdle,
        shadowColor: theme.buttonShadowColor,
        shadowOpacity: 1,
        shadowRadius: 8,
        shadowOffset: { width: 0, height: 3 },
        elevation: 3
      }}
    >
      <Animated.View
        pointerEvents="none"
        style={{
          position: 'absolute',
          top: 0,
          bottom: 0,
          left: thumb,
          width: '50%',
          borderRadius: theme.radiusPill,
          backgroundColor: theme.scoringMenuActiveBackground
        }}
      />
      {labels.map((label, index) => (
        <Pressable
          key={label}
          accessibilityRole="tab"
          accessibilityLabel={label}
          accessibilityState={{ selected: value === index }}
          aria-selected={value === index}
          onPress={() => {
            onChange(index)
          }}
          style={{
            width: '50%',
            minHeight: 48,
            justifyContent: 'center',
            alignItems: 'center'
          }}
        >
          <Text
            selectable={false}
            style={{
              fontFamily: theme.semiBoldTextFont,
              color:
                value === index
                  ? theme.scoringMenuActiveText
                  : theme.primaryTextColor
            }}
          >
            {label}
          </Text>
        </Pressable>
      ))}
    </View>
  )
  return (
    <RosterSelectorDrag
      value={value}
      width={width}
      onMove={x => {
        thumb.setValue(x)
      }}
      onChange={onChange}
    >
      {content}
    </RosterSelectorDrag>
  )
}
