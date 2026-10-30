import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Keyboard, Platform, useWindowDimensions, View } from 'react-native'

import { FLOATING_BOTTOM_REM, FLOATING_HEIGHT_REM } from '../components/AppNav'
import { useHeaderSlot } from '../components/headerSlot'
import { floatingNavBottom } from '../components/navClearance'
import { useBreakpoint } from '../components/useBreakpoint'
import { useInsets } from '../platform/safeArea'
import { useTheme } from '../theme/ThemeContext'
import { chatLayout, keyboardOverlap } from './chatLayoutModel'
import { useChatVisualViewport } from './useChatVisualViewport'

export type ChatViewportState = ReturnType<typeof chatLayout> & {
  frame: React.RefObject<React.ComponentRef<typeof View> | null>
  measure: () => void
  header: number
  /** The clearance below the composer and above it, with no keyboard. */
  closedClearance: number
  /** The part of a keyboard's height that the closed clearance covers. */
  keyboardOffset: number
}

export function useChatViewport(
  options: { paneHeader?: number; composer?: number; pins?: number } = {}
): ChatViewportState {
  const theme = useTheme()
  const slot = useHeaderSlot()
  const insets = useInsets()
  const breakpoint = useBreakpoint()
  const window = useWindowDimensions()
  const frame = useRef<React.ComponentRef<typeof View>>(null)
  const live = useRef(true)
  const measurement = useRef(0)
  const [frameBottom, setFrameBottom] = useState(window.height)
  const [nativeKeyboardTop, setNativeKeyboardTop] = useState<number>()
  const visual = useChatVisualViewport(Platform.OS === 'web')
  const measure = useCallback(() => {
    const version = ++measurement.current
    frame.current?.measureInWindow((_x, y, width, height) => {
      if (
        live.current &&
        version === measurement.current &&
        width > 0 &&
        height > 0
      )
        setFrameBottom(y + height)
    })
  }, [])
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      measurement.current += 1
    }
  }, [])
  useEffect(measure, [measure, window.height, window.width, visual])
  useEffect(() => {
    const shown = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      event => {
        setNativeKeyboardTop(event.endCoordinates.screenY)
        measure()
      }
    )
    const hidden = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setNativeKeyboardTop(undefined)
        measure()
      }
    )
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [measure])
  const keyboardTop =
    visual?.keyboardOpen === true ? visual.bottom : nativeKeyboardTop
  const navigation =
    breakpoint === 'phone'
      ? (slot.navigationHeight ?? theme.rem(FLOATING_HEIGHT_REM))
      : 0
  const input = {
    header: slot.headerHeight,
    paneHeader: options.paneHeader ?? 0,
    pins: options.pins ?? 0,
    composer: options.composer ?? 0,
    navigation,
    navigationBottom: floatingNavBottom(
      Platform.OS,
      theme.rem(FLOATING_BOTTOM_REM),
      insets.bottom
    ),
    safeBottom: insets.bottom,
    keyboardOpen: keyboardTop != null,
    keyboardOverlap: keyboardOverlap(frameBottom, keyboardTop),
    gap: theme.rem(1)
  }
  const closed = chatLayout({ ...input, keyboardOpen: false })
  return {
    ...chatLayout(input),
    frame,
    measure,
    header: slot.headerHeight,
    closedClearance: closed.composerBottom + input.gap,
    keyboardOffset:
      closed.composerBottom -
      input.gap / 2 +
      Math.max(0, window.height - frameBottom)
  }
}

/** The overlays and the full-height scroll viewport share one measured frame. */
export function ChatViewport(props: {
  viewport: ReturnType<typeof useChatViewport>
  children: React.ReactNode
}): React.ReactElement {
  return (
    <View
      ref={props.viewport.frame}
      onLayout={() => {
        props.viewport.measure()
      }}
      testID="chat-viewport"
      style={{ flex: 1, minHeight: 0 }}
    >
      {props.children}
    </View>
  )
}
