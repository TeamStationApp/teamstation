import React from 'react'
import { Pressable, ScrollView, Text } from 'react-native'

import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { Button } from './Button'
import { ButtonIcon } from './ButtonIcon'
import { Sheet } from './Sheet'

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
  return (
    <Sheet
      onClose={onClose}
      closeLabel="Close warning"
      closeRole="button"
      style={styles.sheet}
      testID="warningSheet"
    >
      <Pressable
        accessibilityLabel="Close warning"
        accessibilityRole="button"
        onPress={onClose}
        style={styles.close}
      >
        <ButtonIcon name="close">
          <Text style={styles.closeText}>×</Text>
        </ButtonIcon>
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
    </Sheet>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  sheet: {
    maxHeight: '85%',
    backgroundColor: '#FFD54F',
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
