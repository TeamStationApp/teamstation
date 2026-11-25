import React, { useLayoutEffect, useRef, useState } from 'react'
import {
  Animated,
  Pressable,
  type StyleProp,
  Text,
  View,
  type ViewStyle
} from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { useMotionPreference } from './useMotionPreference'

export interface OfflineBannerProps {
  /** The line: offline and what waits, or what is still being sent. */
  text?: string
  /** Why the action just pressed did nothing, while it cannot be done. */
  refusal?: string
  /**
   * Opens the list of what the server stopped: with it, the line is a
   * button. Only while something is held.
   */
  onOpenHeld?: () => void
  onLayout?: (height: number) => void
  /** The space currently occupied by the strip, including intermediate frames. */
  onPresentedHeight?: (height: number) => void
  /** Where the shell puts it: the bottom of the window, on the safe area. */
  style?: StyleProp<ViewStyle>
}

/** The strip's fill, the same in every theme: a dark yellow under white. */
export const OFFLINE_BANNER_BACKGROUND = '#6B3E00'
/** Every line on it, a refusal included. */
export const OFFLINE_BANNER_TEXT = '#ffffff'

/**
 * The strip at the bottom of the phone, under the tab bar and above the
 * home indicator, that says the server cannot be reached and how many edits
 * wait on the phone, and why a create pressed offline did not open. While
 * the server holds edits, its line opens the list of them. Nothing at all
 * when there is nothing to say.
 */
export function OfflineBanner(
  props: OfflineBannerProps
): React.ReactElement | null {
  const styles = getStyles(useTheme())
  const { onOpenHeld, onLayout, onPresentedHeight, style } = props
  const shown = props.text != null || props.refusal != null
  const [last, setLast] =
    useState<Pick<OfflineBannerProps, 'text' | 'refusal'>>()
  const [measured, setMeasured] = useState(0)
  const height = useRef(new Animated.Value(0)).current
  const reduced = useMotionPreference()
  useLayoutEffect(() => {
    if (shown) setLast({ text: props.text, refusal: props.refusal })
  }, [shown, props.text, props.refusal])
  useLayoutEffect(() => {
    onPresentedHeight?.(0)
    const id = height.addListener(({ value }) => onPresentedHeight?.(value))
    return () => {
      height.removeListener(id)
    }
  }, [height, onPresentedHeight])
  useLayoutEffect(() => {
    if (measured === 0) {
      if (!shown) setLast(undefined)
      return
    }
    const motion = Animated.timing(height, {
      toValue: shown ? measured : 0,
      duration: reduced ? 90 : 160,
      useNativeDriver: false
    })
    motion.start(({ finished }) => {
      if (finished && !shown) setLast(undefined)
    })
    return () => {
      motion.stop()
    }
  }, [height, measured, reduced, shown])
  const content = shown ? props : last
  if (content == null) return null
  const { text, refusal } = content
  const line = text != null && (
    <Text
      testID="offlineBannerText"
      accessibilityRole="text"
      style={[styles.text, onOpenHeld != null && styles.held]}
    >
      {text}
    </Text>
  )
  return (
    <Animated.View
      testID="offlineBanner"
      accessibilityLiveRegion={shown ? 'polite' : 'none'}
      aria-hidden={!shown}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      pointerEvents={shown ? 'auto' : 'none'}
      style={[
        styles.strip,
        style,
        {
          height,
          opacity: height.interpolate({
            inputRange: [0, Math.max(1, measured)],
            outputRange: [0, 1],
            extrapolate: 'clamp'
          })
        }
      ]}
    >
      <View
        testID="offlineBannerContent"
        style={styles.content}
        onLayout={event => {
          const natural = event.nativeEvent.layout.height
          setMeasured(natural)
          onLayout?.(natural)
        }}
      >
        {line !== false && onOpenHeld != null ? (
          // On iOS the button stands for the line inside it: find it by its
          // own id and label, not the line's.
          <Pressable
            testID="offlineBannerButton"
            accessibilityRole="button"
            accessibilityLabel="Edits not sent"
            accessibilityHint={text}
            onPress={() => {
              onOpenHeld()
            }}
          >
            {line}
          </Pressable>
        ) : (
          line
        )}
        {refusal != null && (
          <Text
            testID="offlineCreateMessage"
            accessibilityRole="alert"
            style={[styles.text, styles.refusal]}
          >
            {refusal}
          </Text>
        )}
      </View>
    </Animated.View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  // Solid, and the same dark yellow in every theme, so white reads on it.
  strip: {
    backgroundColor: OFFLINE_BANNER_BACKGROUND,
    overflow: 'hidden'
  },
  // Measure the lines at the available width, independently of the animated clip.
  content: {
    position: 'absolute',
    bottom: 0,
    left: 0,
    right: 0,
    paddingHorizontal: theme.rem(1),
    paddingVertical: theme.rem(0.5),
    gap: theme.rem(0.25)
  },
  text: {
    color: OFFLINE_BANNER_TEXT,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.875),
    textAlign: 'center'
  },
  refusal: {
    fontFamily: theme.boldTextFont
  },
  // The line that opens what can be done about what is held.
  held: {
    textDecorationLine: 'underline' as const
  }
}))
