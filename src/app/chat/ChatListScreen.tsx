import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  FlatList,
  Image,
  type LayoutChangeEvent,
  Platform,
  Pressable,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import { Badge, Button, Icon, Screen } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { lightHaptic } from '../scoring/lightHaptic'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { ChatArrivalHost } from './ChatArrivalHost'
import { pressPoint, pressStamp } from './chatInteractionModel'
import {
  canStartDm,
  conversationPill,
  conversationTitle,
  groupChats,
  timeLabel
} from './chatModel'
import { getChatStyles } from './chatStyles'
import { bindUserScroll, immediatePressProps } from './chatWebInteractions'
import { CHAT_WIDE_WIDTH } from './chatWorkspaceModel'
import { ConversationMenu } from './ConversationMenu'
import type { ConversationListItem } from './engine/engine'
import type { ChatScreenEngine } from './screenEngine'

export interface ChatListScreenProps {
  engine: Pick<ChatScreenEngine, 'refresh' | 'conversations' | 'subscribe'> &
    Pick<Partial<ChatScreenEngine>, 'loadPreview' | 'setPreferences'>
  onOpen: (chat: ConversationListItem) => void
  onNewMessage: () => void
  onFollowTeam: () => void
  now?: () => Date
  embedded?: boolean
  narrow?: boolean
  selectedId?: string
  /** A remembered selection on the narrow list is still offscreen. */
  selectedVisible?: boolean
  initialOffset?: number
  onOffset?: (offset: number) => void
}
type Row =
  | { type: 'heading'; key: string; title: string }
  | { type: 'chat'; key: string; chat: ConversationListItem }

export function ChatListScreen(props: ChatListScreenProps): React.ReactElement {
  const { engine } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const shared = getChatStyles(theme)
  const windowWidth = useWindowDimensions().width
  const narrow = props.narrow ?? windowWidth < CHAT_WIDE_WIDTH
  const [chats, setChats] = useState<ConversationListItem[]>()
  const [failed, setFailed] = useState(false)
  const [menu, setMenu] = useState<ConversationListItem>()
  const list = useRef<FlatList<Row>>(null)
  const visible = useRef<string[]>([])
  const gestureGeneration = useRef(0)
  const restored = useRef(false)
  const scrollOwner = useRef({
    live: true,
    visible: true,
    onOffset: props.onOffset
  })
  const listVisible =
    props.embedded !== true || !narrow || props.selectedVisible !== true
  scrollOwner.current.visible = listVisible
  scrollOwner.current.onOffset = props.onOffset
  useEffect(() => {
    const owner = scrollOwner.current
    owner.live = true
    return () => {
      owner.live = false
    }
  }, [])
  const rememberOffset = (event: {
    nativeEvent: { contentOffset: { y: number } }
  }): void => {
    const owner = scrollOwner.current
    if (owner.live && owner.visible && restored.current)
      owner.onOffset?.(Math.max(0, event.nativeEvent.contentOffset.y))
  }
  // Metadata/preview refreshes produce new arrays without replacing the rows.
  const dataKey =
    chats == null
      ? undefined
      : JSON.stringify(chats.map(chat => chat.id).sort())
  const currentDataKey = useRef(dataKey)
  currentDataKey.current = dataKey
  const listGeometry = useRef({
    height: 0,
    content: 0,
    data: undefined as string | undefined
  })
  const restoreOffset = useRef(props.initialOffset ?? 0)
  const measuredTail = useRef<string | undefined>(undefined)
  const revealProgress = useRef({
    data: undefined as string | undefined,
    offset: -1
  })
  const restoreList = useCallback(() => {
    if (
      !listVisible ||
      !scrollOwner.current.live ||
      !scrollOwner.current.visible ||
      dataKey !== currentDataKey.current ||
      restored.current ||
      chats == null
    )
      return
    const { height, content, data } = listGeometry.current
    if (height <= 0 || content <= 0 || data !== dataKey) return
    if (
      content < height + restoreOffset.current &&
      chats.length > 0 &&
      measuredTail.current !== dataKey
    ) {
      // Without exact item heights, virtualization measures its next window
      // only after scrolling. Advance through current content without
      // consuming the saved target or publishing these intermediate offsets.
      const available = Math.max(0, content - height)
      const progress = revealProgress.current
      if (progress.data !== dataKey || available > progress.offset) {
        revealProgress.current = { data: dataKey, offset: available }
        list.current?.scrollToOffset({ offset: available, animated: false })
      }
      return
    }
    // Refresh can legitimately remove rows; clamp only measured current data.
    const offset = Math.min(
      restoreOffset.current,
      Math.max(0, content - height)
    )
    list.current?.scrollToOffset({
      offset,
      animated: false
    })
    restored.current = true
  }, [chats, dataKey, listVisible])
  useEffect(restoreList, [restoreList])
  useEffect(
    () =>
      bindUserScroll(list.current, () => {
        restored.current = true
        gestureGeneration.current += 1
      }),
    []
  )
  const viewability = useRef({ itemVisiblePercentThreshold: 1 }).current
  const previews = useCallback(
    (ids: string[]): void => {
      for (const id of ids) engine.loadPreview?.(id).catch(() => undefined)
    },
    [engine]
  )
  const onVisible = useCallback(
    ({ viewableItems }: { viewableItems: Array<{ item: Row }> }): void => {
      visible.current = viewableItems.flatMap(token =>
        token.item.type === 'chat' ? [token.item.chat.id] : []
      )
      previews(visible.current)
    },
    [previews]
  )

  useEffect(() => {
    let live = true
    const unsubscribe = engine.subscribe(event => {
      if (!live) return
      if (event.type === 'conversations') setChats(engine.conversations())
    })
    engine
      .refresh()
      .then(next => {
        if (live) {
          setChats(next)
          setFailed(false)
        }
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
      unsubscribe()
    }
  }, [engine, props.selectedId, props.selectedVisible])
  useEffect(() => {
    previews(visible.current)
  }, [chats, previews])
  const target =
    menu == null ? undefined : chats?.find(chat => chat.id === menu.id)
  const rows: Row[] =
    chats == null
      ? []
      : groupChats(chats).flatMap(group => [
          { type: 'heading' as const, key: group.key, title: group.title! },
          ...group.chats.map(chat => ({
            type: 'chat' as const,
            key: chat.id,
            chat
          }))
        ])
  const now = props.now?.() ?? new Date()
  const content = (
    <View style={styles.fill}>
      {props.embedded !== true && (
        <ChatArrivalHost
          engine={engine}
          selectedId={props.selectedId}
          selectedVisible={props.selectedVisible}
        />
      )}
      <FlatList
        ref={list}
        testID="chat-conversation-list"
        data={rows}
        keyExtractor={row => row.key}
        viewabilityConfig={viewability}
        onViewableItemsChanged={onVisible}
        onLayout={event => {
          if (
            !scrollOwner.current.live ||
            !scrollOwner.current.visible ||
            dataKey !== currentDataKey.current
          )
            return
          listGeometry.current.height = event.nativeEvent.layout.height
          restoreList()
        }}
        onContentSizeChange={(_width, height) => {
          if (
            !scrollOwner.current.live ||
            !scrollOwner.current.visible ||
            dataKey !== currentDataKey.current
          )
            return
          listGeometry.current.content = height
          listGeometry.current.data = dataKey
          restoreList()
        }}
        onScroll={rememberOffset}
        onScrollEndDrag={rememberOffset}
        onMomentumScrollEnd={rememberOffset}
        scrollEventThrottle={100}
        onScrollBeginDrag={() => {
          // RNW also emits this for the programmatic restoration steps.
          if (Platform.OS !== 'web') {
            restored.current = true
            gestureGeneration.current += 1
          }
        }}
        keyboardShouldPersistTaps="handled"
        ListHeaderComponent={
          <View style={styles.actions}>
            {chats != null && canStartDm(chats) && (
              <Button
                label={lstrings.chat_new_message}
                kind="primary"
                icon="edit"
                compact
                onPress={props.onNewMessage}
              />
            )}
            <Button
              label={lstrings.chat_follow_team}
              kind="text"
              compact
              onPress={props.onFollowTeam}
            />
          </View>
        }
        ListEmptyComponent={
          <View style={styles.empty}>
            {chats != null && !failed && (
              <Text style={shared.heading}>{lstrings.chat_empty}</Text>
            )}
            <Text style={failed ? shared.error : shared.muted}>
              {failed
                ? lstrings.chat_cannot_load
                : chats == null
                  ? lstrings.common_loading
                  : lstrings.chat_empty_detail}
            </Text>
          </View>
        }
        renderItem={({ item }) =>
          item.type === 'heading' ? (
            <View style={styles.heading}>
              <Text style={shared.heading}>{item.title}</Text>
            </View>
          ) : (
            <ConversationRow
              chat={item.chat}
              onLayout={event => {
                if (
                  !scrollOwner.current.live ||
                  !scrollOwner.current.visible ||
                  dataKey !== currentDataKey.current
                )
                  return
                if (
                  item.chat.id === rows.at(-1)?.key &&
                  event.nativeEvent.layout.height > 0
                ) {
                  measuredTail.current = dataKey
                  restoreList()
                }
              }}
              now={now}
              selected={item.chat.id === props.selectedId}
              narrow={narrow}
              gestureGeneration={gestureGeneration}
              onOpen={() => {
                props.onOpen(item.chat)
              }}
              onMenu={() => {
                setMenu(item.chat)
              }}
            />
          )
        }
      />
      {target != null && (
        <ConversationMenu
          conversation={target}
          engine={engine}
          onClose={() => {
            setMenu(undefined)
          }}
        />
      )}
    </View>
  )
  return props.embedded === true ? (
    content
  ) : (
    <Screen scroll={false} contentStyle={styles.fill}>
      {content}
    </Screen>
  )
}

function ConversationRow(props: {
  chat: ConversationListItem
  now: Date
  selected: boolean
  narrow: boolean
  gestureGeneration: React.RefObject<number>
  onOpen: () => void
  onMenu: () => void
  onLayout?: (event: LayoutChangeEvent) => void
}): React.ReactElement {
  const { chat } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const shared = getChatStyles(theme)
  const ref = useRef<React.ComponentRef<typeof View>>(null)
  const held = useRef({
    x: 0,
    y: 0,
    generation: 0,
    cancelled: false,
    recognized: false,
    pointer: false,
    nativeStart: undefined as ReturnType<typeof pressStamp>
  })
  const title = conversationTitle(chat)
  const pill = conversationPill(chat)
  const unread = chat.unread > 0 || chat.preferences?.manualUnread === true
  const openMenu = (): void => {
    if (
      held.current.cancelled ||
      held.current.recognized ||
      !held.current.pointer ||
      held.current.generation !== props.gestureGeneration.current
    )
      return
    held.current.recognized = true
    lightHaptic(ref.current)
    props.onMenu()
  }
  return (
    <View
      ref={ref}
      collapsable={false}
      onLayout={props.onLayout}
      style={[styles.row, props.selected && styles.selected]}
    >
      <Pressable
        testID={'chat-conversation-' + chat.id}
        {...immediatePressProps}
        style={styles.openRow}
        accessibilityRole="button"
        accessibilityLabel={chat.title}
        accessibilityHint={pill}
        accessibilityActions={[
          { name: 'longpress', label: lstrings.chat_conversation_actions }
        ]}
        onAccessibilityAction={event => {
          if (event.nativeEvent.actionName === 'longpress') props.onMenu()
        }}
        onPressIn={event => {
          const point = pressPoint(event.nativeEvent)
          const nativeStart = pressStamp(event.nativeEvent)
          if (
            nativeStart != null &&
            nativeStart.identifier === held.current.nativeStart?.identifier &&
            nativeStart.timestamp === held.current.nativeStart?.timestamp
          )
            return
          held.current = {
            x: point?.x ?? 0,
            y: point?.y ?? 0,
            generation: props.gestureGeneration.current,
            cancelled: false,
            recognized: false,
            pointer: point != null,
            nativeStart
          }
        }}
        onTouchMove={event => {
          const point = pressPoint(event.nativeEvent)
          if (
            point == null ||
            Math.hypot(point.x - held.current.x, point.y - held.current.y) > 10
          )
            held.current.cancelled = true
        }}
        onTouchCancel={() => {
          held.current.cancelled = true
        }}
        onLongPress={props.narrow ? openMenu : undefined}
        delayLongPress={500}
        onPress={event => {
          const started = held.current.nativeStart
          const released = pressStamp(event.nativeEvent)
          if (props.narrow && started != null && released != null) {
            const point = pressPoint(event.nativeEvent)
            if (
              released.identifier !== started.identifier ||
              released.timestamp < started.timestamp ||
              point == null ||
              Math.hypot(point.x - held.current.x, point.y - held.current.y) >
                10
            )
              held.current.cancelled = true
            else if (released.timestamp - started.timestamp >= 500) openMenu()
          }
          if (
            !held.current.recognized &&
            !held.current.cancelled &&
            (!held.current.pointer ||
              held.current.generation === props.gestureGeneration.current)
          )
            props.onOpen()
        }}
      >
        <View style={styles.avatar}>
          {chat.avatarUrl != null ? (
            <Image
              source={{ uri: chat.avatarUrl }}
              style={styles.avatarImage}
            />
          ) : chat.kind === 'dm' ? (
            <Text style={styles.initials}>
              {title
                .split(/[ ,]+/)
                .filter(Boolean)
                .slice(0, 2)
                .map(word => word[0])
                .join('')}
            </Text>
          ) : (
            <Icon name="group" size={1.5} color={theme.activeColor} />
          )}
        </View>
        <View style={styles.text}>
          <View style={[styles.line, styles.titleLine]}>
            <Text
              style={[styles.title, unread && styles.titleUnread]}
              numberOfLines={1}
            >
              {title}
            </Text>
            {pill != null && (
              <View style={styles.pill}>
                <Text style={styles.pillText}>{pill}</Text>
              </View>
            )}
          </View>
          <View style={styles.line}>
            <Text style={[shared.small, styles.preview]} numberOfLines={2}>
              {chat.locked
                ? lstrings.chat_locked_message
                : (chat.preview ??
                  (chat.lastSeq === 0
                    ? lstrings.chat_no_messages
                    : lstrings.chat_latest_loading))}
            </Text>
            <View style={styles.trailing}>
              <Text style={shared.small}>
                {timeLabel(
                  chat.lastPostAt === undefined
                    ? chat.lastMessageAt
                    : chat.lastPostAt,
                  props.now
                )}
              </Text>
              {unread && (
                <View
                  style={styles.unread}
                  accessibilityLabel={
                    chat.unread > 0
                      ? sprintf(lstrings.chat_unread_label, chat.unread)
                      : lstrings.chat_manual_unread_label
                  }
                >
                  <Text style={styles.unreadText}>
                    {chat.unread > 0 ? chat.unread : '•'}
                  </Text>
                </View>
              )}
            </View>
          </View>
          <View style={styles.badges}>
            {chat.locked && (
              <Badge label={lstrings.chat_locked_badge} tone="neutral" />
            )}
            {chat.closed && (
              <Badge label={lstrings.chat_closed_badge} tone="neutral" />
            )}
            {chat.preferences?.muted === true && (
              <Badge label={lstrings.chat_muted} tone="neutral" />
            )}
          </View>
        </View>
      </Pressable>
      {props.narrow && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel={
            lstrings.chat_conversation_actions + ': ' + chat.title
          }
          onPress={props.onMenu}
          style={styles.more}
        >
          <Text style={styles.moreText}>•••</Text>
        </Pressable>
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  fill: { flex: 1, minHeight: 0 },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(0.5),
    padding: theme.rem(0.75)
  },
  heading: {
    paddingHorizontal: theme.rem(1),
    paddingTop: theme.rem(1),
    paddingBottom: theme.rem(0.5)
  },
  empty: { padding: theme.rem(1) },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    borderRadius: theme.rem(0.75),
    marginHorizontal: theme.rem(0.25)
  },
  selected: { backgroundColor: theme.containerBackgroundColor },
  openRow: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.625),
    paddingHorizontal: theme.rem(0.75),
    paddingVertical: theme.rem(0.75)
  },
  avatar: {
    width: theme.rem(2.5),
    height: theme.rem(2.5),
    borderRadius: theme.rem(1.25),
    backgroundColor: theme.pillBackground,
    alignItems: 'center',
    justifyContent: 'center',
    overflow: 'hidden'
  },
  avatarImage: { width: '100%', height: '100%' },
  initials: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    color: theme.activeColor
  },
  text: { flex: 1, minWidth: 0, gap: theme.rem(0.25) },
  line: { flexDirection: 'row', alignItems: 'center', gap: theme.rem(0.375) },
  titleLine: { flexWrap: 'wrap' },
  title: {
    flexGrow: 1,
    flexShrink: 1,
    flexBasis: theme.rem(6),
    minWidth: theme.rem(6),
    color: theme.primaryTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.9375)
  },
  titleUnread: { fontFamily: theme.boldTextFont, fontWeight: '700' },
  pill: {
    flexShrink: 0,
    borderRadius: theme.rem(2),
    backgroundColor: theme.pillBackground,
    paddingHorizontal: theme.rem(0.375),
    paddingVertical: theme.rem(0.125)
  },
  pillText: {
    color: theme.pillTextColor,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75)
  },
  preview: { flex: 1 },
  trailing: {
    alignItems: 'flex-end',
    minWidth: theme.rem(2.5),
    gap: theme.rem(0.25)
  },
  badges: { flexDirection: 'row', gap: theme.rem(0.25) },
  unread: {
    minWidth: theme.rem(1.25),
    height: theme.rem(1.25),
    borderRadius: theme.rem(0.625),
    backgroundColor: theme.primaryButtonColor,
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: theme.rem(0.375)
  },
  unreadText: {
    color: theme.buttonTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(0.75)
  },
  more: { paddingVertical: theme.rem(1), paddingRight: theme.rem(0.5) },
  moreText: {
    color: theme.secondaryTextColor,
    fontSize: theme.rem(0.75),
    letterSpacing: 1
  },
  announcement: {
    position: 'absolute',
    width: 1,
    height: 1,
    overflow: 'hidden'
  }
}))
