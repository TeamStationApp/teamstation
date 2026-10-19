import React, { useEffect, useRef, useState } from 'react'
import {
  Animated,
  Easing,
  ScrollView,
  type StyleProp,
  Text,
  type TextStyle,
  View
} from 'react-native'

import { useMotionPreference } from '../components/useMotionPreference'
import { undoTickerTiming } from './undoTickerTiming'

export function UndoTicker({
  text,
  style,
  enabled,
  testID
}: {
  text: string
  style: StyleProp<TextStyle>
  enabled: boolean
  testID?: string
}): React.ReactElement {
  const [width, setWidth] = useState(0)
  const [contentWidth, setContentWidth] = useState(0)
  const translateX = useRef(new Animated.Value(0)).current
  const reduced = useMotionPreference()
  useEffect(() => {
    translateX.setValue(0)
    const timing = undoTickerTiming(width, contentWidth)
    if (!enabled || reduced || timing == null) return
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(timing.startPause),
        Animated.timing(translateX, {
          toValue: -timing.distance,
          duration: timing.duration,
          easing: value => Easing.linear(value),
          useNativeDriver: true
        }),
        Animated.delay(timing.endPause),
        Animated.timing(translateX, {
          toValue: 0,
          duration: 0,
          useNativeDriver: true
        })
      ])
    )
    animation.start()
    return () => {
      animation.stop()
      translateX.setValue(0)
    }
  }, [text, width, contentWidth, enabled, reduced, translateX])
  return (
    <View
      testID={testID == null ? undefined : `${testID}-viewport`}
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
      }}
      style={{ overflow: 'hidden', minWidth: 0 }}
    >
      <ScrollView
        horizontal
        scrollEnabled={false}
        showsHorizontalScrollIndicator={false}
        showsVerticalScrollIndicator={false}
        onContentSizeChange={setContentWidth}
      >
        <Animated.View
          testID={testID == null ? undefined : `${testID}-motion`}
          style={{ transform: [{ translateX }] }}
        >
          <Text
            testID={testID}
            selectable={false}
            numberOfLines={1}
            ellipsizeMode="clip"
            style={style}
          >
            {text}
          </Text>
        </Animated.View>
      </ScrollView>
    </View>
  )
}
