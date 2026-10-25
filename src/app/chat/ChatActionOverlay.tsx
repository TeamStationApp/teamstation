import React, { useEffect, useRef, useState } from 'react'
import {
  Animated,
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  useWindowDimensions,
  View
} from 'react-native'

import { AppHeader } from '../components/AppHeader'
import { Button } from '../components/Button'
import { GlassView } from '../components/GlassView'
import { useBreakpoint } from '../components/useBreakpoint'
import { useMotionPreference } from '../components/useMotionPreference'
import { edgeMarginRem } from '../layout/margins'
import { lstrings } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { useTheme } from '../theme/ThemeContext'
import { ChatOverlayPortal } from './ChatOverlayHost'
import { bindPopupKeys } from './chatWebInteractions'

export interface ChatActionOverlayProps {
  children: React.ReactNode
  selected?: React.ReactNode
  onClose: () => void
  label: string
  initialField?: boolean
  keyboardRows?: string
  /** A chooser owns a full same-window scene with the shared header. */
  scene?: boolean
  closing?: boolean
  focusHandoff?: boolean
  onClosed?: () => void
  /** The scene has arrived and is at rest. */
  onEntered?: () => void
}

/** The selected content and controls stay above the blurred backdrop. */
export function ChatActionOverlay(
  props: ChatActionOverlayProps
): React.ReactElement {
  return (
    <ChatOverlayPortal modal={props.focusHandoff !== true}>
      <OverlayFrame {...props} />
    </ChatOverlayPortal>
  )
}

function OverlayFrame(props: ChatActionOverlayProps): React.ReactElement {
  const { onClose, initialField, keyboardRows } = props
  const theme = useTheme()
  const insets = useInsets()
  const breakpoint = useBreakpoint()
  const window = useWindowDimensions()
  const margin = theme.rem(edgeMarginRem(theme, breakpoint))
  const [headerHeight, setHeaderHeight] = useState(insets.top + theme.rem(3))
  const reduced = useMotionPreference()
  const entrance = useRef(new Animated.Value(0)).current
  const closed = useRef(props.onClosed)
  closed.current = props.onClosed
  const entered = useRef(props.onEntered)
  entered.current = props.onEntered
  useEffect(() => {
    if (props.scene !== true) return
    let live = true
    const animation = Animated.timing(entrance, {
      toValue: props.closing === true ? 0 : 1,
      duration: reduced ? 80 : 200,
      useNativeDriver: true
    })
    animation.start(result => {
      if (!live || !result.finished) return
      if (props.closing === true) closed.current?.()
      else entered.current?.()
    })
    return () => {
      live = false
      animation.stop()
    }
  }, [props.scene, props.closing, reduced, entrance])
  const panel = useRef<React.ComponentRef<typeof View>>(null)
  const close = useRef(onClose)
  close.current = onClose
  useEffect(() => {
    const subscription = BackHandler.addEventListener(
      'hardwareBackPress',
      () => {
        close.current()
        return true
      }
    )
    const stop = bindPopupKeys(
      panel.current,
      () => {
        close.current()
      },
      true,
      initialField === true,
      keyboardRows
    )
    return () => {
      subscription.remove()
      stop()
    }
  }, [initialField, keyboardRows])
  if (props.scene === true)
    return (
      <View
        ref={panel}
        testID="chat-picker-scene"
        accessibilityLabel={props.label}
        accessibilityViewIsModal={props.focusHandoff !== true}
        aria-hidden={props.closing === true}
        accessibilityElementsHidden={props.closing === true}
        importantForAccessibility={
          props.closing === true ? 'no-hide-descendants' : 'auto'
        }
        pointerEvents={props.closing === true ? 'box-only' : 'auto'}
        onAccessibilityEscape={() => {
          close.current()
        }}
        style={[
          StyleSheet.absoluteFill,
          {
            zIndex: 100,
            elevation: 30,
            backgroundColor: theme.cardBackgroundColor
          }
        ]}
      >
        {/* The same-window scene preserves the composer's trusted focus handoff. */}
        <Animated.View
          testID="chat-picker-transition"
          style={{
            flex: 1,
            opacity: entrance,
            transform: reduced
              ? undefined
              : [
                  {
                    translateY: entrance.interpolate({
                      inputRange: [0, 1],
                      outputRange: [window.height, 0]
                    })
                  }
                ]
          }}
        >
          <ScrollView
            testID="chat-picker-content"
            keyboardShouldPersistTaps="handled"
            automaticallyAdjustKeyboardInsets
            style={{ flex: 1 }}
            contentContainerStyle={{
              paddingTop: headerHeight + theme.rem(1),
              paddingBottom: insets.bottom + theme.rem(1),
              paddingLeft: Math.max(margin, insets.left),
              paddingRight: Math.max(margin, insets.right),
              gap: theme.rem(0.75)
            }}
          >
            {props.children}
          </ScrollView>
          <View
            testID="chat-picker-header"
            style={{ position: 'absolute', top: 0, left: 0, right: 0 }}
          >
            <AppHeader
              title={props.label}
              navMinWidth={theme.rem(6) * Math.max(1, window.fontScale)}
              contentHeight={Math.max(
                theme.rem(3),
                theme.rem(2.25) * window.fontScale
              )}
              onHeight={setHeaderHeight}
              nav={
                <Button
                  label={lstrings.chat_cancel}
                  kind="text"
                  small
                  style={{
                    minWidth: theme.rem(6) * Math.max(1, window.fontScale),
                    flexShrink: 0
                  }}
                  textColor={theme.dangerColor}
                  onPress={() => {
                    close.current()
                  }}
                />
              }
            />
          </View>
        </Animated.View>
      </View>
    )
  return (
    <>
      <View
        style={[StyleSheet.absoluteFill, { zIndex: 100, elevation: 30 }]}
        accessibilityViewIsModal
        onAccessibilityEscape={() => {
          close.current()
        }}
      >
        <GlassView androidBlur style={StyleSheet.absoluteFill} />
        <ScrollView
          keyboardShouldPersistTaps="handled"
          automaticallyAdjustKeyboardInsets
          style={{ flex: 1 }}
          contentContainerStyle={{
            flexGrow: 1,
            alignItems: 'center',
            justifyContent: 'center',
            paddingTop: insets.top + theme.rem(1),
            paddingBottom: insets.bottom + theme.rem(1),
            paddingHorizontal: theme.rem(1)
          }}
        >
          <Pressable
            style={StyleSheet.absoluteFill}
            onPress={props.onClose}
            accessibilityRole="button"
            accessibilityLabel={lstrings.chat_cancel}
          />
          <View
            ref={panel}
            accessibilityLabel={props.label}
            style={{
              width: '100%',
              maxWidth: theme.rem(28),
              gap: theme.rem(0.75)
            }}
          >
            {props.selected}
            <View
              style={{
                backgroundColor: theme.cardBackgroundColor,
                borderRadius: theme.rem(1.25),
                borderColor: theme.defaultBorderColor,
                borderWidth: 1,
                padding: theme.rem(0.5),
                gap: theme.rem(0.25)
              }}
            >
              {props.children}
            </View>
          </View>
        </ScrollView>
      </View>
    </>
  )
}
