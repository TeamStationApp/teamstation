import React, { useState } from 'react'
import { Text, View } from 'react-native'

import { Button } from '../components'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { ChatActionOverlay } from './ChatActionOverlay'
import { conversationPill, conversationTitle } from './chatModel'
import type { ConversationListItem } from './engine/engine'
import type { ChatScreenEngine } from './screenEngine'

export function ConversationMenu(props: {
  conversation: ConversationListItem
  engine: Pick<ChatScreenEngine, 'setPreferences'>
  onClose: () => void
}): React.ReactElement {
  const { conversation, onClose } = props
  const theme = useTheme()
  const [error, setError] = useState(false)
  const [busy, setBusy] = useState(false)
  const action = (patch: {
    pinned?: boolean
    muted?: boolean
    manualUnread?: boolean
  }): void => {
    setBusy(true)
    setError(false)
    const work =
      props.engine.setPreferences?.(conversation.id, patch) ??
      Promise.reject(new Error('Unavailable'))
    work
      .then(onClose)
      .catch(() => {
        setError(true)
      })
      .finally(() => {
        setBusy(false)
      })
  }
  return (
    <ChatActionOverlay
      label={lstrings.chat_conversation_actions}
      onClose={onClose}
      selected={
        <View
          style={{
            backgroundColor: theme.cardBackgroundColor,
            borderRadius: theme.rem(1),
            padding: theme.rem(1),
            gap: theme.rem(0.25)
          }}
        >
          <Text
            style={{
              color: theme.primaryTextColor,
              fontFamily: theme.boldTextFont,
              fontSize: theme.rem(1)
            }}
          >
            {conversationTitle(conversation)}
          </Text>
          {conversationPill(conversation) != null && (
            <Text style={{ color: theme.secondaryTextColor }}>
              {conversationPill(conversation)}
            </Text>
          )}
          {conversation.preview != null && (
            <Text style={{ color: theme.secondaryTextColor }} numberOfLines={2}>
              {conversation.preview}
            </Text>
          )}
        </View>
      }
    >
      <Button
        kind="text"
        label={lstrings.chat_mark_unread}
        disabled={busy}
        onPress={() => {
          action({ manualUnread: true })
        }}
      />
      <Button
        kind="text"
        label={
          conversation.preferences?.muted === true
            ? lstrings.chat_unmute
            : lstrings.chat_mute
        }
        disabled={busy}
        onPress={() => {
          action({ muted: conversation.preferences?.muted !== true })
        }}
      />
      <Button
        kind="text"
        label={
          conversation.preferences?.pinned === true
            ? lstrings.chat_unpin
            : lstrings.chat_pin
        }
        disabled={busy}
        onPress={() => {
          action({ pinned: conversation.preferences?.pinned !== true })
        }}
      />
      {error && (
        <Text
          accessibilityLiveRegion="polite"
          style={{ color: theme.dangerColor }}
        >
          {lstrings.chat_preference_failed}
        </Text>
      )}
    </ChatActionOverlay>
  )
}
