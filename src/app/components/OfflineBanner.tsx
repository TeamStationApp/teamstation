import React, { useCallback, useLayoutEffect, useRef, useState } from 'react'
import {
  Animated,
  Platform,
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
  /** Native reports each frame. A composited browser transition commits its layout once. */
  onPresentedHeight?: (height: number, duration?: number) => void
  /** Where the shell puts it: the bottom of the window, on the safe area. */
  style?: StyleProp<ViewStyle>
}

/** Commit the bottom clearance once, then let the browser move the docked controls. */
export function useOfflineBannerHeight(): {
  height: number
  shell: React.RefObject<React.ComponentRef<typeof View> | null>
  report: (next: number, duration?: number) => void
} {
  const [height, setHeight] = useState(0)
  const shell = useRef<React.ComponentRef<typeof View>>(null)
  const pending = useRef<{
    duration: number
    docks: Array<{ node: HTMLElement; bottom: number }>
  }>(undefined)
  const motions = useRef(new WeakMap<HTMLElement, Animation>())
  const report = useCallback((next: number, duration?: number) => {
    if (duration != null && shell.current != null) {
      const pane = shell.current as unknown as HTMLElement
      pending.current = {
        duration,
        docks: Array.from(
          pane.querySelectorAll<HTMLElement>('[data-offline-banner-dock]'),
          node => ({ node, bottom: parseFloat(getComputedStyle(node).bottom) })
        )
      }
    }
    setHeight(next)
  }, [])
  useLayoutEffect(() => {
    const update = pending.current
    pending.current = undefined
    if (update == null) return
    for (const { node, bottom } of update.docks) {
      if (!node.isConnected) continue
      const delta = parseFloat(getComputedStyle(node).bottom) - bottom
      // A second change can arrive with the previous transform still on screen.
      const presented = node.getBoundingClientRect().top
      motions.current.get(node)?.cancel()
      const offset = presented - node.getBoundingClientRect().top + delta
      if (offset === 0) continue
      const animation = node.animate(
        [{ translate: `0 ${offset}px` }, { translate: '0 0px' }],
        { duration: update.duration, easing: 'ease-in-out' }
      )
      motions.current.set(node, animation)
    }
  }, [height])
  return { height, shell, report }
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
  const strip = useRef<React.ComponentRef<typeof View>>(null)
  const previous = useRef({ target: 0, natural: 0 })
  const webMotion = useRef<Animation>(undefined)
  const composited =
    Platform.OS === 'web' &&
    typeof HTMLElement !== 'undefined' &&
    typeof HTMLElement.prototype.animate === 'function'
  useLayoutEffect(
    () => () => {
      webMotion.current?.cancel()
    },
    []
  )
  useLayoutEffect(() => {
    if (shown) setLast({ text: props.text, refusal: props.refusal })
  }, [shown, props.text, props.refusal])
  useLayoutEffect(() => {
    onPresentedHeight?.(0)
    if (composited) return
    const id = height.addListener(({ value }) => onPresentedHeight?.(value))
    return () => {
      height.removeListener(id)
    }
  }, [height, onPresentedHeight, composited])
  useLayoutEffect(() => {
    if (measured === 0) {
      if (!shown) setLast(undefined)
      return
    }
    const target = shown ? measured : 0
    const duration = reduced ? 90 : 160
    if (composited && strip.current != null) {
      const node = strip.current as unknown as HTMLElement
      const old = previous.current
      const current = webMotion.current
      const from =
        current == null
          ? old.target
          : Number(getComputedStyle(node).opacity) * old.natural
      current?.cancel()
      previous.current = { target, natural: measured }
      onPresentedHeight?.(target, duration)
      const pose = (visible: number): Keyframe => ({
        transform: `translateY(${measured - visible}px)`,
        opacity: Math.min(1, visible / measured)
      })
      const animation = node.animate([pose(from), pose(target)], {
        duration,
        easing: 'ease-in-out'
      })
      webMotion.current = animation
      animation.onfinish = () => {
        if (webMotion.current !== animation) return
        webMotion.current = undefined
        if (!shown) setLast(undefined)
      }
      return
    }
    const motion = Animated.timing(height, {
      toValue: target,
      duration,
      useNativeDriver: false
    })
    motion.start(({ finished }) => {
      if (finished && !shown) setLast(undefined)
    })
    return () => {
      motion.stop()
    }
  }, [height, measured, reduced, shown, composited, onPresentedHeight])
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
      ref={strip}
      testID="offlineBanner"
      accessibilityLiveRegion={shown ? 'polite' : 'none'}
      aria-hidden={!shown}
      accessibilityElementsHidden={!shown}
      importantForAccessibility={shown ? 'auto' : 'no-hide-descendants'}
      pointerEvents={shown ? 'auto' : 'none'}
      style={[
        styles.strip,
        style,
        composited
          ? { height: measured, opacity: shown ? 1 : 0 }
          : {
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
