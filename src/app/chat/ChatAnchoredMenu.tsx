import React, { useEffect, useLayoutEffect, useRef, useState } from 'react'
import {
  Animated,
  Pressable,
  StyleSheet,
  useWindowDimensions,
  View
} from 'react-native'

import { useMotionPreference } from '../components/useMotionPreference'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { type ChatBounds, menuPosition } from './chatInteractionModel'
import { ChatOverlayPortal } from './ChatOverlayHost'
import { bindPopupKeys, watchMessageAnchor } from './chatWebInteractions'

interface AnchoredMenuProps {
  anchor: unknown
  label: string
  closing: boolean
  onClose: () => void
  onClosed: () => void
  children: React.ReactNode
}

export function ChatAnchoredMenu(props: AnchoredMenuProps): React.ReactElement {
  return (
    <ChatOverlayPortal modal={!props.closing}>
      <AnchoredFrame {...props} />
    </ChatOverlayPortal>
  )
}
function AnchoredFrame(props: AnchoredMenuProps): React.ReactElement {
  const theme = useTheme()
  const viewport = useWindowDimensions()
  const [bounds, setBounds] = useState<ChatBounds>({
    x: 8,
    y: 8,
    width: 0,
    height: 0
  })
  const [size, setSize] = useState({ width: 224, height: 160 })
  const panel = useRef<React.ComponentRef<typeof View>>(null)
  const close = useRef(props.onClose)
  close.current = props.onClose
  useEffect(
    () =>
      watchMessageAnchor(
        props.anchor,
        next => {
          setBounds(previous =>
            JSON.stringify(previous) === JSON.stringify(next) ? previous : next
          )
        },
        () => {
          close.current()
        }
      ),
    [props.anchor]
  )
  useEffect(
    () =>
      props.closing
        ? undefined
        : bindPopupKeys(
            panel.current,
            () => {
              close.current()
            },
            true,
            false,
            undefined,
            props.anchor
          ),
    [props.anchor, props.closing]
  )
  const reduced = useMotionPreference()
  const progress = useRef(new Animated.Value(0)).current
  const closed = useRef(props.onClosed)
  closed.current = props.onClosed
  useLayoutEffect(() => {
    const host = panel.current
    if (host != null && 'inert' in host) host.inert = props.closing
    const transition = Animated.timing(progress, {
      toValue: props.closing ? 0 : 1,
      duration: reduced ? 85 : 150,
      useNativeDriver: false
    })
    transition.start(({ finished }) => {
      if (finished && props.closing) closed.current()
    })
    return () => {
      transition.stop()
    }
  }, [progress, reduced, props.closing])
  const position = menuPosition(bounds, size, viewport)
  return (
    <View
      style={[StyleSheet.absoluteFill, { zIndex: 100 }]}
      pointerEvents={props.closing ? 'none' : 'auto'}
      aria-hidden={props.closing}
      accessibilityViewIsModal={!props.closing}
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={lstrings.chat_cancel}
        onPress={props.onClose}
      />
      <Animated.View
        ref={panel}
        accessibilityLabel={props.closing ? undefined : props.label}
        onLayout={event => {
          setSize(event.nativeEvent.layout)
        }}
        style={{
          opacity: progress,
          position: 'absolute',
          ...position,
          width: Math.min(224, viewport.width - 16),
          maxHeight: viewport.height - 16,
          backgroundColor: theme.cardBackgroundColor,
          borderColor: theme.defaultBorderColor,
          borderWidth: 1,
          borderRadius: theme.rem(0.75),
          padding: theme.rem(0.25),
          gap: theme.rem(0.125),
          boxShadow: '0 4px 20px rgba(0,0,0,0.16)'
        }}
      >
        {props.children}
      </Animated.View>
    </View>
  )
}
