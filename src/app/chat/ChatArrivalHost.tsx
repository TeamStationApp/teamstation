import React, { useEffect, useState } from 'react'
import { Text } from 'react-native'

import { lstrings, sprintf } from '../locales/strings'
import { announceChatArrival } from './chatAnnouncements'
import { conversationTitle } from './chatModel'
import type { ChatScreenEngine } from './screenEngine'

/** Remains exposed when a narrow workspace hides its conversation list. */
export function ChatArrivalHost(props: {
  engine: Pick<ChatScreenEngine, 'subscribe' | 'conversations'>
  selectedId?: string
  selectedVisible?: boolean
}): React.ReactElement {
  const [announcement, setAnnouncement] = useState({ text: '', revision: 0 })
  useEffect(
    () =>
      props.engine.subscribe(event => {
        if (
          event.type !== 'messageAlert' ||
          (props.selectedVisible !== false &&
            event.conversationId === props.selectedId)
        )
          return
        const conversation = props.engine
          .conversations()
          .find(chat => chat.id === event.conversationId)
        if (conversation == null) return
        const text = sprintf(
          lstrings.chat_new_message_announcement,
          conversationTitle(conversation)
        )
        announceChatArrival(text)
        setAnnouncement(previous => ({ text, revision: previous.revision + 1 }))
      }),
    [props.engine, props.selectedId, props.selectedVisible]
  )
  return (
    <Text
      accessibilityLiveRegion="polite"
      style={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden' }}
    >
      <Text key={announcement.revision}>{announcement.text}</Text>
    </Text>
  )
}
