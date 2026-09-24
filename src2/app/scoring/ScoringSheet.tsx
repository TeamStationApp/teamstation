import React, { useState } from 'react'
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
  shape,
  submenuRight = false,
  submenu = false
}: {
  label: string
  text?: string
  onPress: () => void
  disabled?: boolean
  color?: string
  row?: boolean
  shape?: 'pill' | 'circle'
  submenuRight?: boolean
  submenu?: boolean
}): React.ReactElement {
  const theme = useTheme()
  const [active, setActive] = useState(false)
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onHoverIn={() => {
        setActive(true)
      }}
      onHoverOut={() => {
        setActive(false)
      }}
      onFocus={() => {
        setActive(true)
      }}
      onBlur={() => {
        setActive(false)
      }}
      onPressIn={() => {
        setActive(true)
      }}
      onPressOut={() => {
        setActive(false)
      }}
      style={({ pressed }) => ({
        shadowColor: row ? undefined : theme.buttonShadowColor,
        shadowOpacity: row ? 0 : 1,
        shadowRadius: row ? 0 : pressed ? 4 : 8,
        shadowOffset: { width: 0, height: pressed ? 1 : 3 },
        elevation: row ? 0 : pressed ? 1 : 3,
        minHeight: 44,
        flexDirection: submenuRight ? 'row' : undefined,
        alignItems: submenuRight ? 'center' : undefined,
        padding: 10,
        justifyContent: 'center',
        borderRadius:
          shape != null
            ? theme.radiusPill
            : row
              ? 0
              : theme.rem(theme.radiusRem),
        width: shape === 'circle' ? 44 : undefined,
        borderBottomWidth: row ? 1 : 0,
        borderBottomColor: theme.defaultBorderColor,
        backgroundColor:
          color ??
          (row
            ? (pressed || active) && !disabled
              ? theme.scoringMenuActiveBackground
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
                ? active && !disabled
                  ? theme.scoringMenuActiveText
                  : theme.primaryTextColor
                : theme.buttonTextColor,
          flex: submenuRight ? 1 : undefined,
          textAlign: row ? 'left' : 'center'
        }}
      >
        {submenu && !submenuRight ? '‹  ' : ''}
        {text ?? label}
      </Text>
      {submenuRight && (
        <Text
          aria-hidden
          style={{
            color: active ? theme.scoringMenuActiveText : theme.primaryTextColor
          }}
        >
          ›
        </Text>
      )}
    </Pressable>
  )
}
export function ScoringSheet({
  title,
  textCancel = false,
  onClose,
  children
}: {
  title: string
  textCancel?: boolean
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
            {textCancel ? (
              <Pressable
                accessibilityRole="button"
                accessibilityLabel="Cancel"
                onPress={onClose}
                style={{
                  minHeight: 44,
                  paddingHorizontal: 10,
                  justifyContent: 'center'
                }}
              >
                <Text
                  style={{
                    fontFamily: theme.semiBoldTextFont,
                    color: theme.dangerColor
                  }}
                >
                  Cancel
                </Text>
              </Pressable>
            ) : (
              <ScoringButton label="Cancel" onPress={onClose} />
            )}
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
