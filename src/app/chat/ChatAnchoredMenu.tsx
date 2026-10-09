import React, { useEffect, useRef, useState } from 'react'
import { Pressable, StyleSheet, useWindowDimensions, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { type ChatBounds, menuPosition } from './chatInteractionModel'
import { ChatOverlayPortal } from './ChatOverlayHost'
import { bindPopupKeys, watchMessageAnchor } from './chatWebInteractions'

export function ChatAnchoredMenu(props: {
  anchor: unknown
  label: string
  onClose: () => void
  children: React.ReactNode
}): React.ReactElement {
  return (
    <ChatOverlayPortal>
      <AnchoredFrame {...props} />
    </ChatOverlayPortal>
  )
}
function AnchoredFrame(props: {
  anchor: unknown
  label: string
  onClose: () => void
  children: React.ReactNode
}): React.ReactElement {
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
  useEffect(
    () =>
      watchMessageAnchor(
        props.anchor,
        next => {
          setBounds(previous =>
            JSON.stringify(previous) === JSON.stringify(next) ? previous : next
          )
        },
        props.onClose
      ),
    [props.anchor, props.onClose]
  )
  useEffect(() => bindPopupKeys(panel.current, props.onClose), [props.onClose])
  const position = menuPosition(bounds, size, viewport)
  return (
    <View
      style={[StyleSheet.absoluteFill, { zIndex: 100 }]}
      accessibilityViewIsModal
    >
      <Pressable
        style={StyleSheet.absoluteFill}
        accessibilityRole="button"
        accessibilityLabel={lstrings.chat_cancel}
        onPress={props.onClose}
      />
      <View
        ref={panel}
        accessibilityLabel={props.label}
        onLayout={event => {
          setSize(event.nativeEvent.layout)
        }}
        style={{
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
      </View>
    </View>
  )
}
