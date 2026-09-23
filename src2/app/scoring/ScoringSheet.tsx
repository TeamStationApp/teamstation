import React from 'react'
import { Modal, Pressable, ScrollView, Text, View } from 'react-native'

export function ScoringButton({
  label,
  text,
  onPress,
  disabled = false,
  color = '#28624b'
}: {
  label: string
  text?: string
  onPress: () => void
  disabled?: boolean
  color?: string
}): React.ReactElement {
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      disabled={disabled}
      onPress={onPress}
      style={{
        minHeight: 44,
        padding: 10,
        justifyContent: 'center',
        borderRadius: 6,
        backgroundColor: color,
        opacity: disabled ? 0.4 : 1
      }}
    >
      <Text style={{ color: 'white', textAlign: 'center' }}>
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
  return (
    <Modal transparent animationType="slide" onRequestClose={onClose}>
      <View style={{ flex: 1, justifyContent: 'flex-end' }}>
        <Pressable
          accessibilityLabel="Dismiss sheet"
          onPress={onClose}
          style={{ position: 'absolute', inset: 0, backgroundColor: '#0008' }}
        />
        <View
          accessibilityViewIsModal
          style={{
            maxHeight: '92%',
            backgroundColor: '#15382e',
            borderTopLeftRadius: 20,
            borderTopRightRadius: 20,
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
                fontSize: 22,
                fontWeight: '700',
                color: 'white',
                flex: 1
              }}
            >
              {title}
            </Text>
            <ScoringButton label="Cancel" onPress={onClose} />
          </View>
          <ScrollView
            keyboardShouldPersistTaps="handled"
            contentContainerStyle={{ gap: 12 }}
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
  return message == null ? null : (
    <Text accessibilityRole="alert" style={{ color: '#ffb7b7' }}>
      {message}
    </Text>
  )
}
