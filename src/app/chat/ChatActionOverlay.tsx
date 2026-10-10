import React, { useEffect, useRef } from 'react'
import {
  BackHandler,
  Pressable,
  ScrollView,
  StyleSheet,
  View
} from 'react-native'

import { GlassView } from '../components/GlassView'
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
}

/** The selected content and controls stay above the blurred backdrop. */
export function ChatActionOverlay(
  props: ChatActionOverlayProps
): React.ReactElement {
  return (
    <ChatOverlayPortal>
      <OverlayFrame {...props} />
    </ChatOverlayPortal>
  )
}

function OverlayFrame(props: ChatActionOverlayProps): React.ReactElement {
  const { onClose } = props
  const theme = useTheme()
  const insets = useInsets()
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
    const stop = bindPopupKeys(panel.current, () => {
      close.current()
    })
    return () => {
      subscription.remove()
      stop()
    }
  }, [])
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
