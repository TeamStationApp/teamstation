import React, { useEffect, useState } from 'react'
import { Text, useWindowDimensions, View } from 'react-native'

import { Screen } from '../components'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { ChatListScreen } from './ChatListScreen'
import {
  CHAT_WIDE_WIDTH,
  type ChatDraftOwner,
  chatDraftOwner,
  type ChatWorkspaceState,
  emptyChatDraft
} from './chatWorkspaceModel'
import { ConversationScreen } from './ConversationScreen'
import type { ConversationListItem } from './engine/engine'
import type { ChatScreenEngine } from './screenEngine'

export interface ChatWorkspaceProps {
  engine: ChatScreenEngine
  userId: number
  state: ChatWorkspaceState
  conversationId?: string
  onOpen: (conversation: ConversationListItem) => void
  onMembers: (conversationId: string) => void
  onNewMessage: () => void
  onFollowTeam: () => void
  onTitle: (conversationId: string, title: string) => void
}

/** Selection and drafts survive both pane layouts and route transitions. */
export function ChatWorkspace(props: ChatWorkspaceProps): React.ReactElement {
  const draftOwner = chatDraftOwner(props.state, props.engine, props.userId)
  return (
    <WorkspaceContent key={draftOwner.key} {...props} draftOwner={draftOwner} />
  )
}

function WorkspaceContent(
  props: ChatWorkspaceProps & { draftOwner: ChatDraftOwner }
): React.ReactElement {
  const { draftOwner } = props
  const theme = useTheme()
  const windowWidth = useWindowDimensions().width
  const [usableWidth, setUsableWidth] = useState(windowWidth)
  const wide = usableWidth >= CHAT_WIDE_WIDTH
  const [remembered, setRemembered] = useState(props.state.selectedId)
  const [readingSession, setReadingSession] = useState(0)
  const selected = props.conversationId ?? remembered
  useEffect(() => {
    if (props.conversationId == null) return
    props.state.selectedId = props.conversationId
    setRemembered(props.conversationId)
    setReadingSession(value => value + 1)
  }, [props.conversationId, props.state])
  const messagesVisible = wide || props.conversationId != null
  const listVisible = wide || props.conversationId == null
  const draft =
    selected == null
      ? undefined
      : (props.state.drafts.get(selected) ?? emptyChatDraft())
  return (
    <Screen
      wide
      scroll={false}
      contentStyle={{
        flex: 1,
        paddingHorizontal: 0,
        paddingVertical: 0,
        minHeight: 0
      }}
    >
      <View
        onLayout={event => {
          if (event.nativeEvent.layout.width > 0)
            setUsableWidth(event.nativeEvent.layout.width)
        }}
        style={{
          flex: 1,
          minHeight: 0,
          flexDirection: wide ? 'row' : 'column'
        }}
        testID="chat-workspace"
      >
        <View
          testID="chat-list-pane"
          style={{
            width: wide ? 320 : '100%',
            flex: wide ? undefined : 1,
            display: listVisible ? 'flex' : 'none',
            borderRightWidth: wide ? 1 : 0,
            borderColor: theme.defaultBorderColor
          }}
        >
          <ChatListScreen
            narrow={!wide}
            engine={props.engine}
            embedded
            selectedId={selected}
            selectedVisible={messagesVisible}
            initialOffset={props.state.listOffset}
            onOffset={offset => {
              props.state.listOffset = offset
            }}
            onOpen={conversation => {
              props.state.selectedId = conversation.id
              setRemembered(conversation.id)
              setReadingSession(value => value + 1)
              if (conversation.id !== props.conversationId)
                props.onOpen(conversation)
            }}
            onNewMessage={props.onNewMessage}
            onFollowTeam={props.onFollowTeam}
          />
        </View>
        <View
          testID="chat-message-pane"
          style={{
            flex: 1,
            minWidth: 0,
            minHeight: 0,
            display: messagesVisible ? 'flex' : 'none'
          }}
        >
          {selected == null ? (
            <View
              style={{
                flex: 1,
                alignItems: 'center',
                justifyContent: 'center'
              }}
            >
              <Text
                style={{
                  color: theme.secondaryTextColor,
                  fontFamily: theme.regularTextFont
                }}
              >
                {lstrings.chat_choose_conversation}
              </Text>
            </View>
          ) : (
            <ConversationScreen
              key={selected}
              engine={props.engine}
              conversationId={selected}
              userId={props.userId}
              embedded
              active={messagesVisible}
              readingSession={readingSession}
              draft={draft}
              draftOwner={draftOwner}
              onDraftChange={next => {
                draftOwner.write(selected, next)
              }}
              onMembers={() => {
                props.onMembers(selected)
              }}
              onTitle={title => {
                props.onTitle(selected, title)
              }}
            />
          )}
        </View>
      </View>
    </Screen>
  )
}
