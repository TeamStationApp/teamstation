import React from 'react'
import { Pressable, Text, View } from 'react-native'

import type { ChatPin } from '../../common/api'
import { GlassView } from '../components/GlassView'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { orderedPins, pinPreview } from './chatPinsModel'
import type { MessageView } from './engine/apply'

/** A compact personal summary floats above history without owning its scroll. */
export function PinnedMessageSummary(props: {
  pins: readonly ChatPin[]
  messages: readonly MessageView[]
  disabled?: boolean
  onJump: (id: string) => void
  onOpenList: () => void
}): React.ReactElement | null {
  const theme = useTheme()
  const pins = orderedPins(props.pins)
  const first = pins[0]
  if (first == null) return null
  const preview = pinPreview(first, props.messages)
  const label = `${lstrings.chat_pinned_messages}: ${pins.length}`
  const hint = `${preview.sender == null ? '' : preview.sender + ': '}${preview.excerpt}`
  return (
    <GlassView
      radius={theme.rem(1)}
      style={{
        borderRadius: theme.rem(1),
        overflow: 'hidden',
        borderWidth: 1,
        borderColor: theme.glassBorderColor
      }}
    >
      <Pressable
        testID="chat-pinned-summary"
        accessibilityRole="button"
        accessibilityLabel={label}
        accessibilityHint={hint}
        accessibilityState={{ disabled: props.disabled === true }}
        disabled={props.disabled === true}
        onPress={() => {
          if (props.disabled === true) return
          if (pins.length === 1) props.onJump(first.messageId)
          else props.onOpenList()
        }}
        style={{
          minHeight: 48,
          flexDirection: 'row',
          alignItems: 'center',
          gap: theme.rem(0.625),
          paddingHorizontal: theme.rem(0.75),
          paddingVertical: theme.rem(0.5)
        }}
      >
        <Text
          accessibilityElementsHidden
          importantForAccessibility="no"
          style={{ color: theme.activeColor, fontSize: theme.rem(1.5) }}
        >
          ⌖
        </Text>
        <View style={{ flex: 1, minWidth: 0 }}>
          <Text
            numberOfLines={1}
            style={{
              fontFamily: theme.semiBoldTextFont,
              fontSize: theme.rem(0.8125),
              color: theme.activeColor
            }}
          >
            {preview.sender ?? lstrings.chat_pinned_messages}
          </Text>
          <Text
            numberOfLines={1}
            style={{
              fontFamily: theme.regularTextFont,
              fontSize: theme.rem(0.875),
              color: theme.primaryTextColor
            }}
          >
            {preview.excerpt}
          </Text>
        </View>
        {pins.length > 1 && (
          <Text
            testID="chat-pinned-count"
            style={{
              fontFamily: theme.semiBoldTextFont,
              fontSize: theme.rem(0.875),
              color: theme.activeColor
            }}
          >
            {pins.length}
          </Text>
        )}
      </Pressable>
    </GlassView>
  )
}
