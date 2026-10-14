import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { ChatAvatar } from './ChatAvatar'
import { conversationIdentity } from './chatIdentityModel'
import { conversationPill, conversationTitle } from './chatModel'
import type { ConversationListItem } from './engine/engine'

export function ChatConversationIdentity(props: {
  conversation: ConversationListItem
  onPress: () => void
}): React.ReactElement {
  const theme = useTheme()
  const title = conversationTitle(props.conversation)
  const subtitle =
    conversationPill(props.conversation) ?? lstrings.chat_direct_conversation
  return (
    <Pressable
      testID="chat-conversation-identity"
      accessibilityRole="button"
      accessibilityLabel={`${title}, ${subtitle}`}
      accessibilityHint={lstrings.chat_information}
      onPress={props.onPress}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: theme.rem(0.5),
        minHeight: theme.rem(2.75),
        minWidth: 0,
        flex: 1
      }}
    >
      <ChatAvatar
        identity={conversationIdentity(props.conversation)}
        size={1.875}
      />
      <View style={{ flex: 1, minWidth: 0 }}>
        <Text
          numberOfLines={1}
          style={{
            fontFamily: theme.boldTextFont,
            fontWeight: '700',
            fontSize: theme.rem(1.125),
            lineHeight: theme.rem(1.375),
            color: theme.headerTextColor
          }}
        >
          {title}
        </Text>
        <Text
          numberOfLines={1}
          style={{
            fontFamily: theme.regularTextFont,
            fontSize: theme.rem(0.75),
            lineHeight: theme.rem(0.875),
            color: theme.secondaryTextColor
          }}
        >
          {subtitle}
        </Text>
      </View>
    </Pressable>
  )
}
