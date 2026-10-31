import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Platform, Text, useWindowDimensions, View } from 'react-native'

import { Screen } from '../components'
import { useSceneShown } from '../components/sceneShown'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { ChatArrivalHost } from './ChatArrivalHost'
import { ChatListScreen } from './ChatListScreen'
import {
  CHAT_WIDE_WIDTH,
  type ChatDraftOwner,
  chatDraftOwner,
  type ChatListCaptureResult,
  ChatListNavigationCapture,
  type ChatListPositionCapture,
  type ChatWorkspaceState,
  emptyChatDraft
} from './chatWorkspaceModel'
import { ConversationScreen } from './ConversationScreen'
import type { ConversationListItem } from './engine/engine'
import type { ChatScreenEngine } from './screenEngine'

export interface ChatWorkspaceProps {
  engine: ChatScreenEngine
  userId: string
  state: ChatWorkspaceState
  listNavigation?: ChatListNavigationCapture
  conversationId?: string
  onOpen: (conversation: ConversationListItem) => void
  onMembers: (conversationId: string) => void
  onNewMessage: () => void
  onTitle: (conversationId: string, title: string) => void
}

/**
 * The conversation behind the list keeps its place while it is hidden. In a
 * browser it stays laid out at its own size, invisible and out of reach: a
 * `display: none` history measures every row it mounts as empty, and at the
 * top of a long history its list mounts rows without end until React gives up.
 */
const hiddenPane =
  Platform.OS === 'web'
    ? ({
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        bottom: 0,
        visibility: 'hidden',
        pointerEvents: 'none'
      } as const)
    : ({ display: 'none' } as const)

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
  const localNavigation = useMemo(() => new ChatListNavigationCapture(), [])
  const navigation = props.listNavigation ?? localNavigation
  const positionCapture = useRef<ChatListPositionCapture | undefined>(undefined)
  const widthRevision = useRef(0)
  const live = useRef(true)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
      widthRevision.current += 1
    }
  }, [])
  const registerPositionCapture = useCallback(
    (read: ChatListPositionCapture): (() => void) => {
      positionCapture.current = read
      const detach = navigation.attach(read)
      return () => {
        if (positionCapture.current === read)
          positionCapture.current = undefined
        detach?.()
      }
    },
    [navigation]
  )
  const theme = useTheme()
  const shown = useSceneShown()
  const windowWidth = useWindowDimensions().width
  const [usableWidth, setUsableWidth] = useState(windowWidth)
  const wide = usableWidth >= CHAT_WIDE_WIDTH
  const [remembered, setRemembered] = useState(props.state.selectedId)
  const [readingSession, setReadingSession] = useState(0)
  const messagesVisible = wide || props.conversationId != null
  // Narrow, a chat is a scene of its own over this list: only one this
  // workspace itself showed stays here, hidden. A copy of another's would
  // write its own empty draft over that scene's.
  const [shownHere, setShownHere] = useState(props.conversationId)
  const selected = props.conversationId ?? (wide ? remembered : shownHere)
  useEffect(() => {
    if (messagesVisible) setShownHere(selected)
  }, [messagesVisible, selected])
  useEffect(() => {
    if (props.conversationId == null) return
    props.state.selectedId = props.conversationId
    setRemembered(props.conversationId)
    setReadingSession(value => value + 1)
  }, [props.conversationId, props.state])
  const listVisible = wide || props.conversationId == null
  const draft =
    selected == null
      ? undefined
      : (props.state.drafts.get(selected) ?? emptyChatDraft())
  return (
    <Screen
      overlayContent
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
          const width = event.nativeEvent.layout.width
          if (!Number.isFinite(width) || width <= 0) return
          const revision = ++widthRevision.current
          const read = positionCapture.current
          const applyWidth = (): void => {
            if (live.current && widthRevision.current === revision)
              setUsableWidth(width)
          }
          if (
            wide &&
            width < CHAT_WIDE_WIDTH &&
            props.conversationId != null &&
            read != null
          ) {
            const finish = (result: ChatListCaptureResult): void => {
              if (result !== 'stale' && positionCapture.current === read)
                applyWidth()
            }
            navigation.capture().then(finish, () => {
              finish('unavailable')
            })
          } else applyWidth()
        }}
        style={{
          flex: 1,
          minHeight: 0,
          flexDirection: wide ? 'row' : 'column'
        }}
        testID="chat-workspace"
      >
        <ChatArrivalHost
          engine={props.engine}
          selectedId={selected}
          selectedVisible={messagesVisible}
        />
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
            registerPositionCapture={registerPositionCapture}
            initialOffset={props.state.listOffset}
            initialAnchor={props.state.listAnchor}
            onAnchor={anchor => {
              props.state.listAnchor = anchor
            }}
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
          />
        </View>
        <View
          testID="chat-message-pane"
          style={[
            { flex: 1, minWidth: 0, minHeight: 0 },
            messagesVisible ? undefined : hiddenPane
          ]}
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
              paneHeader={wide}
              // Covered beneath another screen (its info, its members) it is
              // not on show: it marks nothing read until Back shows it.
              active={messagesVisible && shown}
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
