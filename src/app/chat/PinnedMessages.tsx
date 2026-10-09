import React from 'react'
import { Pressable, ScrollView, Text } from 'react-native'

import type { ChatPin } from '../../common/api'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { ChatActionOverlay } from './ChatActionOverlay'
import type { MessageView } from './engine/apply'
import { replyExcerpt } from './engine/reply'

export function PinnedMessages(props: {
  pins: ChatPin[]
  messages: MessageView[]
  onJump: (id: string) => void
  onClose: () => void
}): React.ReactElement {
  const theme = useTheme()
  return (
    <ChatActionOverlay
      label={lstrings.chat_pinned_messages}
      onClose={props.onClose}
    >
      <Text
        style={{
          fontFamily: theme.semiBoldTextFont,
          fontSize: theme.rem(1),
          color: theme.primaryTextColor,
          padding: theme.rem(0.5)
        }}
      >
        {lstrings.chat_pinned_messages}
      </Text>
      <ScrollView
        keyboardShouldPersistTaps="handled"
        style={{ maxHeight: theme.rem(24) }}
      >
        {props.pins.map(pin => {
          const message = props.messages.find(
            message => message.id === pin.messageId
          )
          return (
            <Pressable
              key={pin.messageId}
              accessibilityRole="button"
              accessibilityLabel={replyExcerpt(message)}
              onPress={() => {
                props.onJump(pin.messageId)
              }}
              style={{
                padding: theme.rem(0.75),
                borderBottomWidth: 1,
                borderColor: theme.defaultBorderColor
              }}
            >
              {message != null && (
                <Text
                  style={{
                    fontFamily: theme.semiBoldTextFont,
                    color: theme.activeColor
                  }}
                >
                  {message.mine
                    ? lstrings.chat_you
                    : (message.senderName ?? lstrings.chat_former_member)}
                </Text>
              )}
              <Text
                numberOfLines={3}
                style={{
                  fontFamily: theme.regularTextFont,
                  color: theme.primaryTextColor
                }}
              >
                {replyExcerpt(message)}
              </Text>
            </Pressable>
          )
        })}
        {props.pins.length === 0 && (
          <Text
            style={{
              color: theme.secondaryTextColor,
              padding: theme.rem(0.75)
            }}
          >
            {lstrings.chat_no_pinned_messages}
          </Text>
        )}
      </ScrollView>
    </ChatActionOverlay>
  )
}
