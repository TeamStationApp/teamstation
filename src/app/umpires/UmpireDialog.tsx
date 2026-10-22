import React from 'react'
import {
  Modal,
  Pressable,
  ScrollView,
  useWindowDimensions,
  View
} from 'react-native'

import { CancelAction } from '../components/CancelAction'
import { useTheme } from '../theme/ThemeContext'
import { UmpireHeading } from './shared'
export function UmpireDialog({
  title,
  onClose,
  children,
  minContentWidth = 0
}: {
  title: string
  onClose: () => void
  children: React.ReactNode
  minContentWidth?: number
}): React.ReactElement {
  const t = useTheme()
  const { width } = useWindowDimensions()
  return (
    <Modal transparent visible animationType="slide" onRequestClose={onClose}>
      <View
        style={{
          flex: 1,
          justifyContent: 'flex-end',
          backgroundColor: t.overlayBackgroundColor
        }}
      >
        <Pressable
          accessibilityLabel="Close dialog"
          onPress={onClose}
          style={{ position: 'absolute', inset: 0 }}
        />
        <View
          accessibilityViewIsModal
          style={{
            width: '100%',
            maxWidth: t.rem(38),
            maxHeight: '85%',
            alignSelf: 'center',
            padding: t.rem(1.5),
            paddingHorizontal: Math.max(
              0,
              Math.min(t.rem(1.5), (width - minContentWidth) / 2)
            ),
            borderTopLeftRadius: t.rem(1),
            borderTopRightRadius: t.rem(1),
            gap: t.rem(1),
            backgroundColor: t.cardBackgroundColor
          }}
        >
          <UmpireHeading>{title}</UmpireHeading>
          <ScrollView contentContainerStyle={{ gap: t.rem(1) }}>
            {children}
          </ScrollView>
          <CancelAction onPress={onClose} />
        </View>
      </View>
    </Modal>
  )
}
