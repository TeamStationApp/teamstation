import React, { useEffect, useRef, useState } from 'react'
import { PanResponder, Platform, Pressable, Text, View } from 'react-native'
import Animated, {
  cancelAnimation,
  ReduceMotion,
  useAnimatedStyle,
  useSharedValue,
  withTiming
} from 'react-native-reanimated'

import { useMotionPreference } from '../components/useMotionPreference'
import { useTheme } from '../theme/ThemeContext'
import { RosterSelectorDrag } from './RosterSelectorDrag'
export const rosterSegmentAt = (
  x: number,
  left: number,
  width: number,
  count = 2
): number =>
  Math.max(
    0,
    Math.min(count - 1, Math.floor(((x - left) / Math.max(1, width)) * count))
  )
export function RosterSelector({
  labels,
  labelPrefix = '',
  compact = false,
  value,
  onChange
}: {
  labels: string[]
  labelPrefix?: string
  compact?: boolean
  value: number
  onChange: (value: number) => void
}): React.ReactElement {
  const theme = useTheme()
  const count = labels.length
  const [width, setWidth] = useState(0)
  const root = useRef<React.ComponentRef<typeof View>>(null)
  const left = useRef(0)
  const thumb = useSharedValue(0)
  const reduced = useMotionPreference()
  const animated = useAnimatedStyle(() => ({ left: thumb.value }))
  const latest = useRef({ value, width, onChange, count })
  latest.current = { value, width, onChange, count }
  const responder = useRef(
    PanResponder.create({
      onMoveShouldSetPanResponderCapture: (_, gesture) =>
        Math.abs(gesture.dx) > 6 && Math.abs(gesture.dx) > Math.abs(gesture.dy),
      onPanResponderMove: (_, gesture) => {
        cancelAnimation(thumb)
        thumb.value = Math.max(
          0,
          Math.min(
            latest.current.width * (1 - 1 / latest.current.count),
            gesture.moveX -
              left.current -
              latest.current.width / (2 * latest.current.count)
          )
        )
      },
      onPanResponderRelease: (_, gesture) => {
        latest.current.onChange(
          rosterSegmentAt(
            gesture.moveX,
            left.current,
            latest.current.width,
            latest.current.count
          )
        )
        cancelAnimation(thumb)
        thumb.value =
          (rosterSegmentAt(
            gesture.moveX,
            left.current,
            latest.current.width,
            latest.current.count
          ) *
            latest.current.width) /
          latest.current.count
      },
      onPanResponderTerminate: () => {
        cancelAnimation(thumb)
        thumb.value =
          (latest.current.value * latest.current.width) / latest.current.count
      },
      onPanResponderTerminationRequest: () => false
    })
  ).current
  useEffect(() => {
    thumb.value = withTiming((value * width) / count, {
      duration: reduced ? 0 : 150,
      reduceMotion: reduced ? ReduceMotion.Always : ReduceMotion.Never
    })
    return () => {
      cancelAnimation(thumb)
    }
  }, [thumb, value, width, count, reduced])

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
        minHeight: compact ? 40 : 48,
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
        testID="Roster selector thumb"
        pointerEvents="none"
        style={[
          animated,
          {
            position: 'absolute',
            top: 0,
            bottom: 0,
            width: `${100 / count}%`,
            borderRadius: theme.radiusPill,
            backgroundColor: theme.scoringMenuActiveBackground
          }
        ]}
      />
      {labels.map((label, index) => (
        <Pressable
          key={label}
          accessibilityRole="tab"
          accessibilityLabel={
            labelPrefix === '' ? label : `${labelPrefix} ${label}`
          }
          accessibilityState={{ selected: value === index }}
          aria-selected={value === index}
          onPress={() => {
            onChange(index)
          }}
          style={{
            width: `${100 / count}%`,
            minHeight: compact ? 40 : 48,
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
      count={count}
      value={value}
      width={width}
      onMove={x => {
        cancelAnimation(thumb)
        thumb.value = x
      }}
      onChange={onChange}
    >
      {content}
    </RosterSelectorDrag>
  )
}
