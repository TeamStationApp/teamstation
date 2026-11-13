import React, { useEffect, useRef, useState } from 'react'
import {
  AccessibilityInfo,
  Animated,
  Easing,
  Platform,
  type StyleProp,
  Text,
  type TextStyle,
  View
} from 'react-native'

/** Wider than any line a ticker draws. */
const TICKER_STRIP_WIDTH = 10000

/** A single accessible label that reveals overflow with a gentle, paused pan. */
export function TickerText({
  children,
  style,
  selectable
}: {
  children: string
  style?: StyleProp<TextStyle>
  /** Whether the text can be selected; unset leaves the platform's default. */
  selectable?: boolean
}): React.ReactElement {
  const [width, setWidth] = useState(0)
  const [textWidth, setTextWidth] = useState(0)
  const [reduceMotion, setReduceMotion] = useState(true)
  const text = useRef<React.ComponentRef<typeof Text>>(null)
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
  // A browser reads the line's full width even where it is cut: its text's
  // own extent, fractions rounded up so the panned line never ellipsizes.
  const measureWeb = (fallback?: number): void => {
    const node = text.current as unknown as HTMLElement | null
    if (node == null) return
    const range = document.createRange()
    range.selectNodeContents(node)
    // A test page's range has no layout.
    const full =
      typeof range.getBoundingClientRect === 'function'
        ? range.getBoundingClientRect().width
        : 0
    if (full > 0) setTextWidth(Math.ceil(full))
    else if (fallback != null) setTextWidth(fallback)
  }
  // A new line, or a new size, in an unchanged box fires no layout.
  useEffect(() => {
    if (Platform.OS === 'web') measureWeb()
  })
  // Nor does a web font that arrives after the line was first read.
  const measureLatest = useRef(measureWeb)
  measureLatest.current = measureWeb
  useEffect(() => {
    if (Platform.OS !== 'web') return
    let live = true
    const measure = (): void => {
      if (live) measureLatest.current()
    }
    const { fonts } = document as { fonts?: FontFaceSet }
    fonts?.ready.then(measure).catch(() => undefined)
    fonts?.addEventListener('loadingdone', measure)
    return () => {
      live = false
      fonts?.removeEventListener('loadingdone', measure)
    }
  }, [])
  const overflow = textWidth - width
  // The line pans only when it overflows and motion is allowed; otherwise it
  // is the box's own line, cut with an ellipsis where it does not fit.
  const panning = !reduceMotion && width > 0 && overflow > 1
  useEffect(() => {
    offset.setValue(0)
    if (!panning) return
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
  }, [children, offset, overflow, panning])
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
          maxWidth: panning ? undefined : '100%',
          // Panning, the line is as wide as it reads in full.
          width: panning ? textWidth : undefined,
          flexShrink: panning ? 0 : 1,
          transform: [{ translateX: offset }]
        }}
      >
        <Text
          ref={text}
          testID="ticker-text-content"
          accessible={false}
          numberOfLines={1}
          selectable={selectable}
          onLayout={event => {
            if (Platform.OS === 'web')
              measureWeb(event.nativeEvent.layout.width)
          }}
          style={[style, { flexShrink: panning ? 0 : 1 }]}
        >
          {children}
        </Text>
      </Animated.View>
      {Platform.OS !== 'web' && (
        // A phone lays text out no wider than its parent, so the line's full
        // width is read from an unseen copy on a strip wider than any name.
        <View
          pointerEvents="none"
          accessibilityElementsHidden
          importantForAccessibility="no-hide-descendants"
          style={{
            position: 'absolute',
            left: 0,
            top: 0,
            width: TICKER_STRIP_WIDTH,
            flexDirection: 'row',
            opacity: 0
          }}
        >
          <Text
            testID="ticker-text-measure"
            accessible={false}
            numberOfLines={1}
            onLayout={event => {
              setTextWidth(event.nativeEvent.layout.width)
            }}
            style={[style, { flexShrink: 0 }]}
          >
            {children}
          </Text>
        </View>
      )}
    </View>
  )
}
