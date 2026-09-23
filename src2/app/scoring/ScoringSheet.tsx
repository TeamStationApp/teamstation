import React from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import { useMenuEscape } from './useMenuEscape'

export function ScoringButton({
  label,
  text,
  onPress,
  disabled = false,
  color,
  row = false,
  submenu = false
}: {
  label: string
  text?: string
  onPress: () => void
  disabled?: boolean
  color?: string
  row?: boolean
  submenu?: boolean
}): React.ReactElement {
  const theme = useTheme()
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      style={({ pressed }) => ({
        minHeight: 44,
        padding: 10,
        justifyContent: 'center',
        borderRadius: row ? 0 : theme.rem(theme.radiusRem),
        borderBottomWidth: row ? 1 : 0,
        borderBottomColor: theme.defaultBorderColor,
        backgroundColor:
          color ??
          (row
            ? pressed
              ? theme.inactiveBackgroundColor
              : theme.backgroundColor
            : theme.primaryButtonColor),
        opacity: disabled ? 0.4 : 1
      })}
      onPress={onPress}
    >
      <Text
        selectable={false}
        style={{
          fontFamily: theme.semiBoldTextFont,
          color:
            color != null
              ? theme.scoringDecisionText
              : row
                ? theme.primaryTextColor
                : theme.buttonTextColor,
          textAlign: row ? 'left' : 'center'
        }}
      >
        {submenu ? '‹  ' : ''}
        {text ?? label}
      </Text>
    </Pressable>
  )
}
export function ScoringSheet({
  title,
  onClose,
  children
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
}): React.ReactElement {
  const theme = useTheme()
  useMenuEscape(true, onClose, '')
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          accessibilityLabel="Dismiss sheet"
          onPress={onClose}
          style={{
            position: 'absolute',
            inset: 0,
            backgroundColor: theme.overlayBackgroundColor
          }}
        />
        <View
          accessibilityViewIsModal
          style={{
            maxHeight: '92%',
            backgroundColor: theme.backgroundColor,
            borderTopLeftRadius: theme.rem(theme.radiusLargeRem),
            borderTopRightRadius: theme.rem(theme.radiusLargeRem),
            padding: 16,
            gap: 12
          }}
        >
          <View
            style={{
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'space-between',
              gap: 12
            }}
          >
            <Text
              accessibilityRole="header"
              style={{
                fontFamily: theme.boldTextFont,
                fontSize: 22,
                color: theme.primaryTextColor,
                flex: 1
              }}
            >
              {title}
            </Text>
            <ScoringButton label="Cancel" onPress={onClose} />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: 0 }}
          >
            {children}
          </ScrollView>
        </View>
      </View>
    </Modal>
  )
}
export function ScoringError({
  message
}: {
  message?: string
}): React.ReactElement | null {
  const theme = useTheme()
  return message == null ? null : (
    <Text
      accessibilityRole="alert"
      style={{ color: theme.dangerColor, fontFamily: theme.regularTextFont }}
    >
      {message}
    </Text>
  )
}
