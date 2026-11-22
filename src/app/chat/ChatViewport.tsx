import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Dimensions,
  Keyboard,
  Platform,
  useWindowDimensions,
  View
} from 'react-native'

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
  softwareKeyboardOpen: boolean
  dockedKeyboardWidth?: number
  attachmentHandoff: boolean
  attachmentPanelHeight: number
  returningToKeyboard: boolean
  returnToKeyboard: () => void
  keyboardReturnSettled: () => void
}

export function useChatViewport(
  options: {
    paneHeader?: number
    composer?: number
    measuredDrawer?: number
    pins?: number
    attachmentPanel?: boolean
    handoffWidth?: number
  } = {}
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
  const [returningToKeyboard, setReturningToKeyboard] = useState(false)
  // iPad floating keyboards and hardware accessory bars do not occupy a dock.
  const docked = useRef(
    new Map<
      number,
      {
        bottom: number
        height: number
        hiddenWindowHeight?: number
      }
    >()
  )
  const nativePanel =
    Platform.OS !== 'web' &&
    (options.attachmentPanel === true || returningToKeyboard)
  const attachmentHandoff = nativePanel && options.handoffWidth === window.width
  const holdingDock = useRef(false)
  holdingDock.current = attachmentHandoff
  const pendingDock = useRef<{ bounds: boolean; animation: boolean } | null>(
    null
  )
  const ready = useCallback((part: 'bounds' | 'animation') => {
    const pending = pendingDock.current
    if (pending == null) return
    pending[part] = true
    if (pending.bounds && pending.animation) {
      pendingDock.current = null
      setReturningToKeyboard(false)
    }
  }, [])
  const keyboardReturnSettled = useCallback(() => {
    ready('animation')
  }, [ready])
  const returnToKeyboard = useCallback(() => {
    if (Platform.OS !== 'web' && docked.current.has(window.width)) {
      if (Platform.OS === 'android' && holdingDock.current)
        pendingDock.current ??= { bounds: false, animation: false }
      setReturningToKeyboard(true)
    }
  }, [window.width])
  useEffect(() => {
    if (!returningToKeyboard) return
    // A hardware keyboard or a lost focus request may never deliver a show event.
    const release = setTimeout(
      () => {
        pendingDock.current = null
        setReturningToKeyboard(false)
      },
      pendingDock.current != null
        ? 2000
        : nativeKeyboardTop == null
          ? 500
          : 1500
    )
    return () => {
      clearTimeout(release)
    }
  }, [returningToKeyboard, nativeKeyboardTop])
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
        const { screenY, width, height } = event.endCoordinates
        const windowWidth = Dimensions.get('window').width
        const fullWidth = width >= windowWidth - 2
        if (height > 80 && fullWidth)
          docked.current.set(windowWidth, { bottom: screenY + height, height })
        // A floating iPad keyboard can sit anywhere over the history.
        setNativeKeyboardTop(width > 0 && !fullWidth ? undefined : screenY)
        // Android's window bounds and IME animation can settle in either order.
        if (Platform.OS !== 'ios') {
          if (pendingDock.current != null) ready('bounds')
          else setReturningToKeyboard(false)
        }
        measure()
      }
    )
    const settled =
      Platform.OS === 'ios'
        ? Keyboard.addListener('keyboardDidShow', () => {
            setReturningToKeyboard(false)
          })
        : undefined
    const hidden = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        const app = Dimensions.get('window')
        const dock = docked.current.get(app.width)
        if (dock != null) dock.hiddenWindowHeight = app.height
        setNativeKeyboardTop(undefined)
        measure()
      }
    )
    return () => {
      shown.remove()
      settled?.remove()
      hidden.remove()
    }
  }, [measure, ready])
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
      insets.bottom,
      slot.bannerHeight
    ),
    // On a wide window the offline banner, with no capsule, sits on the inset.
    safeBottom: insets.bottom + (slot.bannerHeight ?? 0),
    keyboardOpen: keyboardTop != null || nativePanel,
    // A docked keyboard covers the source panel as it slides off and back on.
    // Both occupy the same area below the field throughout the handoff.
    keyboardOverlap: attachmentHandoff
      ? 0
      : keyboardOverlap(frameBottom, keyboardTop),
    gap: theme.rem(1)
  }
  const closed = chatLayout({ ...input, keyboardOpen: false })
  const closedBottom =
    nativePanel && !attachmentHandoff ? input.gap / 2 : closed.composerBottom
  const remembered = docked.current.get(window.width)
  // Before a docked keyboard is measured, the drawer belongs to the app's
  // frame, which may occupy only part of the display in split screen.
  let screenBottom = remembered?.bottom ?? frameBottom
  const hiddenHeight = remembered?.hiddenWindowHeight
  if (
    hiddenHeight != null &&
    !returningToKeyboard &&
    window.height !== hiddenHeight
  ) {
    // Dismissing an Android IME can still grow the window toward the measured
    // dock. A shrinking window after dismissal is a resize of the app itself.
    screenBottom =
      window.height < hiddenHeight
        ? window.height
        : Math.max(screenBottom, window.height)
  }
  useEffect(() => {
    if (remembered?.hiddenWindowHeight == null || returningToKeyboard) return
    remembered.hiddenWindowHeight = window.height
    remembered.bottom = screenBottom
  }, [remembered, returningToKeyboard, screenBottom, window.height])
  const controlsHeight = Math.max(
    theme.rem(4),
    input.composer -
      (options.measuredDrawer ?? 0) +
      input.gap / 2 +
      theme.rem(theme.spaceXsRem)
  )
  const maxHeight = Math.max(
    0,
    screenBottom - closed.readableTop - controlsHeight
  )
  const requestedHeight = Math.min(remembered?.height ?? 260, maxHeight)
  // A handoff reserves the full dock so the keyboard can slide over its controls.
  // An Android frame already resized by the IME therefore adds no second inset.
  const attachmentPanelHeight = Math.max(
    0,
    keyboardOverlap(frameBottom, screenBottom - requestedHeight) -
      input.keyboardOverlap -
      (attachmentHandoff ? theme.rem(theme.spaceXsRem) : 0)
  )
  return {
    ...chatLayout(input),
    frame,
    measure,
    header: slot.headerHeight,
    softwareKeyboardOpen: keyboardTop != null,
    dockedKeyboardWidth:
      remembered != null &&
      keyboardTop != null &&
      Math.abs(remembered.bottom - remembered.height - keyboardTop) < 2
        ? window.width
        : undefined,
    attachmentHandoff,
    attachmentPanelHeight,
    returningToKeyboard,
    returnToKeyboard,
    keyboardReturnSettled,
    closedClearance: closedBottom + input.gap,
    keyboardOffset:
      closedBottom - input.gap / 2 + Math.max(0, window.height - frameBottom)
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
