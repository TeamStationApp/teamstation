import React, { useEffect, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  Animated,
  Easing,
  type StyleProp,
  Text,
  type TextStyle,
  View
} from 'react-native'

/** A single accessible label that reveals overflow with a gentle, paused pan. */
export function TickerText({
  children,
  style
}: {
  children: string
  style?: StyleProp<TextStyle>
}): React.ReactElement {
  const [width, setWidth] = useState(0)
  const [textWidth, setTextWidth] = useState(0)
  const [reduceMotion, setReduceMotion] = useState(true)
  const offset = useRef(new Animated.Value(0)).current
  useEffect(() => {
    let live = true
    let changed = false
    const subscription = AccessibilityInfo.addEventListener(
      'reduceMotionChanged',
      value => {
        changed = true
        setReduceMotion(value)
      }
    )
    AccessibilityInfo.isReduceMotionEnabled()
      .then(value => {
        if (live && !changed) setReduceMotion(value)
      })
      .catch(() => undefined)
    return () => {
      live = false
      subscription.remove()
    }
  }, [])
  useEffect(() => {
    offset.setValue(0)
    const overflow = textWidth - width
    if (reduceMotion || width <= 0 || overflow <= 1) return
    const animation = Animated.loop(
      Animated.sequence([
        Animated.delay(1500),
        Animated.timing(offset, {
          toValue: -overflow,
          duration: Math.max(1200, (overflow / 24) * 1000),
          easing: value => Easing.linear(value),
          useNativeDriver: true
        }),
        Animated.delay(1500),
        Animated.timing(offset, {
          toValue: 0,
          duration: Math.max(1200, (overflow / 24) * 1000),
          easing: value => Easing.linear(value),
          useNativeDriver: true
        })
      ])
    )
    animation.start()
    return () => {
      animation.stop()
      offset.setValue(0)
    }
  }, [children, offset, reduceMotion, textWidth, width])
  return (
    <View
      testID="ticker-text"
      accessible
      accessibilityLabel={children}
      onLayout={event => {
        setWidth(event.nativeEvent.layout.width)
      }}
      style={{ overflow: 'hidden', maxWidth: '100%' }}
    >
      <Animated.View
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          flexDirection: 'row',
          alignSelf: 'flex-start',
          flexShrink: 0,
          transform: [{ translateX: offset }]
        }}
      >
        <Text
          testID="ticker-text-content"
          accessible={false}
          numberOfLines={1}
          onLayout={event => {
            setTextWidth(event.nativeEvent.layout.width)
          }}
          style={[style, { flexShrink: 0 }]}
        >
          {children}
        </Text>
      </Animated.View>
    </View>
  )
}
