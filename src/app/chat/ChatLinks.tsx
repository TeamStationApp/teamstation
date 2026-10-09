import React from 'react'
import { View } from 'react-native'

import { Button } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { getChatStyles } from './chatStyles'

/** A chat a team or season page links to. */
export interface ChatLink {
  id: string
  title: string
}

export interface ChatLinksProps {
  chats: ChatLink[]
  onOpen: (chat: ChatLink) => void
}

/** The chats of a team or season the person is in, one button each. */
export function ChatLinks(props: ChatLinksProps): React.ReactElement | null {
  const { chats, onOpen } = props
  const shared = getChatStyles(useTheme())
  if (chats.length === 0) return null
  return (
    <View style={shared.actions} accessibilityLabel={lstrings.chat_team_chats}>
      {chats.map(chat => (
        <Button
          key={chat.id}
          label={chat.title}
          accessibilityLabel={sprintf(lstrings.chat_open_chat, chat.title)}
          icon="chat"
          kind="secondary"
          compact
          onPress={() => {
            onOpen(chat)
          }}
        />
      ))}
    </View>
  )
}
