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
  captions,
  accessibilityLabels,
  labelPrefix = '',
  compact = false,
  fitContent = false,
  value,
  onChange
}: {
  labels: string[]
  /** One caption per segment, shown in a row above the pill. */
  captions?: string[]
  /** Each tab's accessible name, when it differs from its visible label. */
  accessibilityLabels?: string[]
  labelPrefix?: string
  compact?: boolean
  fitContent?: boolean
  value: number
  onChange: (value: number) => void
}): React.ReactElement {
  const theme = useTheme()
  const count = labels.length
  const [width, setWidth] = useState(0)
  const [labelWidth, setLabelWidth] = useState(0)
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
        minHeight: fitContent ? 36 : compact ? 40 : 48,
        alignSelf: fitContent ? 'center' : undefined,
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
        // Labels can be team names, which repeat or are empty: key by place.
        <Pressable
          key={index}
          accessibilityRole="tab"
          hitSlop={fitContent ? { top: 6, bottom: 6 } : undefined}
          accessibilityLabel={
            accessibilityLabels?.[index] ??
            (labelPrefix === '' ? label : `${labelPrefix} ${label}`)
          }
          accessibilityState={{ selected: value === index }}
          aria-selected={value === index}
          onPress={() => {
            onChange(index)
          }}
          style={{
            width: fitContent ? undefined : `${100 / count}%`,
            minWidth: fitContent ? labelWidth + 24 : undefined,
            paddingHorizontal: fitContent ? 12 : 8,
            minHeight: fitContent ? 36 : compact ? 40 : 48,
            alignSelf: fitContent ? 'center' : undefined,
            justifyContent: 'center',
            alignItems: 'center'
          }}
        >
          <Text
            onLayout={event => {
              if (fitContent)
                setLabelWidth(previous =>
                  Math.max(previous, event.nativeEvent.layout.width)
                )
            }}
            selectable={false}
            numberOfLines={1}
            ellipsizeMode="tail"
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
  const control = (
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
  const pill = fitContent ? (
    <View style={{ alignSelf: 'center', paddingVertical: 6 }}>{control}</View>
  ) : (
    control
  )
  if (captions == null) return pill
  // The captions are their own row, outside the pill and its drag area, each
  // as wide as the segment under it so it sits centred over that segment.
  return (
    <View style={{ gap: 4 }}>
      <View testID="Roster selector captions" style={{ flexDirection: 'row' }}>
        {captions.map((caption, index) => (
          <View
            key={index}
            style={{ width: `${100 / count}%`, alignItems: 'center' }}
          >
            <Text
              selectable={false}
              numberOfLines={1}
              style={{
                fontFamily: theme.regularTextFont,
                fontSize: 13,
                color: theme.secondaryTextColor
              }}
            >
              {caption}
            </Text>
          </View>
        ))}
      </View>
      {pill}
    </View>
  )
}
