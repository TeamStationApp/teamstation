import React from 'react'
import {
  KeyboardAvoidingView,
  Modal,
  Platform,
  ScrollView,
  View
} from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'

/**
 * The dialog a picker opens in, over the dimmed screen: a calendar, a time or
 * a wheel. It rises above the keyboard, which a calendar's Year field raises,
 * so the day grid and its buttons stay in reach, and a tap on them while the
 * keyboard is up reaches them rather than only putting the keyboard away.
 */
export function PickerDialog(props: {
  onClose: () => void
  /** The widest the dialog is drawn, in rem. */
  maxWidthRem?: number
  children: React.ReactNode
}): React.ReactElement {
  const { onClose, maxWidthRem = 28, children } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <KeyboardAvoidingView
        style={styles.backdrop}
        // Android draws the modal's window edge to edge, and that window does
        // not shrink for the keyboard (seen on a Pixel 10, 2026-10-16: the
        // dialog sits just above the keyboard, its day grid whole), so the
        // view must shrink itself: `height`.
        behavior={
          Platform.OS === 'ios'
            ? 'padding'
            : Platform.OS === 'android'
              ? 'height'
              : undefined
        }
      >
        <View
          accessibilityViewIsModal
          style={[styles.dialog, { maxWidth: theme.rem(maxWidthRem) }]}
        >
          <ScrollView style={styles.scroll} keyboardShouldPersistTaps="handled">
            {children}
          </ScrollView>
        </View>
      </KeyboardAvoidingView>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  backdrop: {
    flex: 1,
    backgroundColor: '#00000066',
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    padding: theme.rem(1)
  },
  dialog: {
    backgroundColor: theme.backgroundColor,
    padding: theme.rem(1),
    borderRadius: theme.rem(theme.radiusRem),
    width: '100%' as const,
    maxHeight: '95%' as const
  },
  scroll: { flexShrink: 1 }
}))
