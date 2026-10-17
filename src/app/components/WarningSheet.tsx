import React from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'

import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'

export interface WarningSheetProps {
  message: string
  detail?: string
  actionLabel: string
  onAction: () => void
  onClose: () => void
  busy?: boolean
  children?: React.ReactNode
}

/** A recoverable access warning, with one centered action at the bottom. */
export function WarningSheet({
  message,
  detail,
  actionLabel,
  onAction,
  onClose,
  busy,
  children
}: WarningSheetProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const insets = useInsets()
  return (
    <Modal transparent visible animationType="slide" onRequestClose={onClose}>
      <View style={styles.scrim}>
        <Pressable
          accessibilityLabel="Close warning"
          accessibilityRole="button"
          onPress={onClose}
          style={styles.behind}
        />
        <View
          testID="warningSheet"
          accessibilityViewIsModal
          style={[
            styles.sheet,
            { paddingBottom: Math.max(insets.bottom, theme.rem(1.5)) }
          ]}
        >
          <Pressable
            accessibilityLabel="Close warning"
            accessibilityRole="button"
            onPress={onClose}
            style={styles.close}
          >
            <Text style={styles.closeText}>×</Text>
          </Pressable>
          <ScrollView style={styles.content}>
            <Text accessibilityRole="alert" style={styles.message}>
              {message}
            </Text>
            {detail != null && <Text style={styles.detail}>{detail}</Text>}
            {children}
          </ScrollView>
          <Button
            label={actionLabel}
            onPress={onAction}
            busy={busy}
            color="#1565C0"
            textColor="#FFFFFF"
            style={styles.action}
          />
        </View>
      </View>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  scrim: { flex: 1, justifyContent: 'flex-end' },
  behind: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    backgroundColor: theme.overlayBackgroundColor
  },
  sheet: {
    width: '100%',
    maxWidth: theme.rem(36),
    maxHeight: '85%',
    alignSelf: 'center',
    backgroundColor: '#FFD54F',
    borderTopLeftRadius: theme.rem(theme.radiusLargeRem),
    borderTopRightRadius: theme.rem(theme.radiusLargeRem),
    padding: theme.rem(1.5),
    shadowColor: '#000000',
    shadowOpacity: 0.18,
    shadowRadius: 8,
    shadowOffset: { width: 0, height: -2 },
    elevation: 5,
    gap: theme.rem(1)
  },
  close: {
    alignSelf: 'flex-end',
    minWidth: 44,
    minHeight: 44,
    alignItems: 'center',
    justifyContent: 'center'
  },
  closeText: { color: '#211B00', fontSize: theme.rem(1.75) },
  content: { flexGrow: 0 },
  message: {
    color: '#211B00',
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1.125),
    textAlign: 'center'
  },
  detail: {
    color: '#211B00',
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    textAlign: 'center',
    marginTop: theme.rem(0.75)
  },
  action: { alignSelf: 'center' }
}))
