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
  initialAnchor?: { id: string; relativeY: number }
  onOffset?: (offset: number) => void
  onAnchor?: (anchor: { id: string; relativeY: number } | undefined) => void
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
    onOffset: props.onOffset,
    onAnchor: props.onAnchor
  })
  const listVisible =
    props.embedded !== true || !narrow || props.selectedVisible !== true
  const visibilityState = useRef({ visible: listVisible, version: 0 })
  if (visibilityState.current.visible !== listVisible) {
    visibilityState.current.visible = listVisible
    visibilityState.current.version += 1
  }
  const visibilityVersion = visibilityState.current.version
  scrollOwner.current.visible = listVisible
  scrollOwner.current.onOffset = props.onOffset
  scrollOwner.current.onAnchor = props.onAnchor
  useEffect(() => {
    const owner = scrollOwner.current
    owner.live = true
    return () => {
      owner.live = false
    }
  }, [])
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
  // Row order is geometry. A same-ID recency/pin reorder invalidates work,
  // while a metadata array that retains that order does not.
  const dataKey =
    chats == null ? undefined : JSON.stringify(rows.map(row => row.key))
  const currentDataKey = useRef(dataKey)
  currentDataKey.current = dataKey
  const listGeometry = useRef({
    height: 0,
    content: 0,
    data: undefined as string | undefined
  })
  const restoreOffset = useRef(props.initialOffset ?? 0)
  const anchor = useRef(props.initialAnchor)
  const anchorOwned = useRef(props.initialAnchor != null)
  const currentOffset = useRef(props.initialOffset ?? 0)
  const acknowledgedOffset = useRef<
    | {
        offset: number
        data: string | undefined
        visibility: number
        generation: number
      }
    | undefined
  >(undefined)
  const [fastRestore, setFastRestore] = useState(props.initialAnchor != null)
  const requested = useRef<number | undefined>(undefined)
  const requestedFinal = useRef(false)
  const requestedVisibility = useRef(visibilityVersion)
  const requestedVersion = useRef(0)
  const rejectedRequest = useRef(false)
  const rowRefs = useRef(new Map<string, React.ComponentRef<typeof View>>())
  const positions = useRef(
    new Map<
      string,
      { y: number; height: number; data: string | undefined; version: number }
    >()
  )
  const measuredTail = useRef<
    { data: string | undefined; end: number; version: number } | undefined
  >(undefined)
  const layoutVersion = useRef(0)
  const revealProgress = useRef({
    data: undefined as string | undefined,
    offset: -1
  })
  const restoration = useRef<() => void>(() => {})
  const measureRows = useRef<(id: string) => void>(() => {})
  const measuring = useRef(false)
  const dirty = useRef(false)
  const seeking = useRef<
    { data: string | undefined; index: number; version: number } | undefined
  >(undefined)
  const validatingGeometry = useRef(false)
  const geometryDirty = useRef(false)
  const geometryValidation = useRef<() => void>(() => {})
  const liveData = (): boolean =>
    scrollOwner.current.live &&
    scrollOwner.current.visible &&
    dataKey === currentDataKey.current &&
    visibilityVersion === visibilityState.current.version
  const rowPosition = async (
    id: string,
    retry = false,
    cancelled: () => boolean = () => !liveData()
  ): Promise<{ y: number; height: number } | undefined> => {
    const deadline = Date.now() + 2000
    while (!cancelled()) {
      const position = await new Promise<
        { y: number; height: number } | undefined
      >(resolve => {
        const row = rowRefs.current.get(id)
        const content = list.current?.getScrollResponder()?.getInnerViewRef()
        if (row == null || content == null) {
          resolve(undefined)
          return
        }
        const timeout = setTimeout(() => {
          resolve(undefined)
        }, 100)
        row.measureLayout(
          content,
          (_x, y, width, height) => {
            clearTimeout(timeout)
            resolve(
              Number.isFinite(y) && width > 0 && height > 0
                ? { y, height }
                : undefined
            )
          },
          () => {
            clearTimeout(timeout)
            resolve(undefined)
          }
        )
      })
      if (position != null || !retry || Date.now() >= deadline) return position
      await new Promise<void>(resolve => setTimeout(resolve, 25))
    }
    return undefined
  }

  const savePosition = (): void => {
    if (!liveData() || !restored.current) return
    const offset = currentOffset.current
    scrollOwner.current.onOffset?.(offset)
    const candidates = [...positions.current].filter(
      ([, p]) =>
        p.data === dataKey &&
        p.version === layoutVersion.current &&
        p.y + p.height > offset &&
        p.y < offset + listGeometry.current.height
    )
    candidates.sort((a, b) => a[1].y - b[1].y)
    const first = candidates[0]
    if (first != null)
      scrollOwner.current.onAnchor?.({
        id: first[0],
        relativeY: first[1].y - offset
      })
  }
  const measureRow = (id: string): void => {
    const version = layoutVersion.current
    const generation = gestureGeneration.current
    rowPosition(id)
      .then(position => {
        if (
          !liveData() ||
          version !== layoutVersion.current ||
          generation !== gestureGeneration.current ||
          position == null
        )
          return
        positions.current.set(id, { ...position, data: dataKey, version })
        if (id === rows.at(-1)?.key)
          measuredTail.current = {
            data: dataKey,
            end: position.y + position.height,
            version
          }
        savePosition()
        restoration.current()
      })
      .catch(() => undefined)
  }
  measureRows.current = measureRow
  const requestOffset = (offset: number, final = false): void => {
    if (
      requested.current === offset &&
      requestedVisibility.current === visibilityVersion &&
      !(
        rejectedRequest.current &&
        requestedVersion.current !== layoutVersion.current
      )
    ) {
      // A reveal already reached this same numeric destination. Validate its
      // final meaning without issuing a duplicate scroll in this visible pane.
      requestedFinal.current = final
      requestedVersion.current = layoutVersion.current
      const acknowledged = acknowledgedOffset.current
      if (
        final &&
        liveData() &&
        acknowledged != null &&
        acknowledged.data === dataKey &&
        acknowledged.visibility === visibilityVersion &&
        acknowledged.generation === gestureGeneration.current &&
        Math.abs(acknowledged.offset - offset) <= 1
      ) {
        restored.current = true
        setFastRestore(false)
        savePosition()
      }
      return
    }
    requested.current = offset
    requestedFinal.current = final
    requestedVisibility.current = visibilityVersion
    requestedVersion.current = layoutVersion.current
    rejectedRequest.current = false
    if (final) restored.current = false
    list.current?.scrollToOffset({ offset, animated: false })
  }
  const seekAnchor = (index: number): void => {
    const previous = seeking.current
    if (
      previous != null &&
      previous.data === dataKey &&
      previous.index === index &&
      previous.version === layoutVersion.current
    )
      return
    restored.current = false
    setFastRestore(true)
    requestedFinal.current = false
    seeking.current = { data: dataKey, index, version: layoutVersion.current }
    list.current?.scrollToIndex({ index, animated: false, viewPosition: 0.5 })
  }
  const revalidateGeometry = (): void => {
    if (
      !liveData() ||
      dataKey == null ||
      listGeometry.current.data == null ||
      listGeometry.current.data === dataKey
    )
      return
    if (validatingGeometry.current) {
      geometryDirty.current = true
      return
    }
    validatingGeometry.current = true
    geometryDirty.current = false
    const deadline = Date.now() + 2000
    const generation = gestureGeneration.current
    const validate = async (): Promise<void> => {
      while (
        liveData() &&
        generation === gestureGeneration.current &&
        listGeometry.current.data !== dataKey &&
        Date.now() < deadline
      ) {
        const version = layoutVersion.current
        const size = await new Promise<
          { width: number; height: number } | undefined
        >(resolve => {
          const content = list.current?.getScrollResponder()?.getInnerViewRef()
          if (content == null) {
            resolve(undefined)
            return
          }
          const timer = setTimeout(() => {
            resolve(undefined)
          }, 100)
          content.measure((_x, _y, width, height) => {
            clearTimeout(timer)
            resolve(width > 0 && height > 0 ? { width, height } : undefined)
          })
        })
        if (!liveData() || generation !== gestureGeneration.current) return
        if (size != null && version === layoutVersion.current) {
          listGeometry.current.content = size.height
          listGeometry.current.data = dataKey
          restoration.current()
          for (const id of visible.current) measureRows.current(id)
          return
        }
        await new Promise<void>(resolve => setTimeout(resolve, 25))
      }
    }
    validate()
      .catch(() => undefined)
      .finally(() => {
        validatingGeometry.current = false
        if (
          geometryDirty.current &&
          scrollOwner.current.live &&
          scrollOwner.current.visible
        ) {
          geometryDirty.current = false
          geometryValidation.current()
        }
      })
  }
  geometryValidation.current = revalidateGeometry
  const restoreList = (): void => {
    if (
      !liveData() ||
      chats == null ||
      (restored.current && !anchorOwned.current)
    )
      return
    const { height, content, data } = listGeometry.current
    if (height <= 0 || content <= 0 || data !== dataKey) return
    const saved = anchor.current
    const savedIndex =
      saved == null ? -1 : rows.findIndex(row => row.key === saved.id)
    if (savedIndex >= 0 && !rowRefs.current.has(saved!.id)) {
      seekAnchor(savedIndex)
      return
    }
    if (
      saved != null &&
      rows.some(row => row.key === saved.id) &&
      rowRefs.current.has(saved.id)
    ) {
      if (measuring.current) {
        dirty.current = true
        return
      }
      measuring.current = true
      dirty.current = false
      const version = layoutVersion.current
      const generation = gestureGeneration.current
      rowPosition(
        saved.id,
        true,
        () =>
          !liveData() ||
          version !== layoutVersion.current ||
          generation !== gestureGeneration.current ||
          !anchorOwned.current
      )
        .then(position => {
          if (
            !liveData() ||
            generation !== gestureGeneration.current ||
            anchor.current !== saved ||
            !anchorOwned.current ||
            version !== layoutVersion.current ||
            dirty.current
          )
            return
          if (position == null) {
            if (listGeometry.current.content >= height + restoreOffset.current)
              requestOffset(restoreOffset.current, true)
            return
          }
          const target = Math.max(0, position.y - saved.relativeY)
          restoreOffset.current = target
          // A mounted tail is not proof that its preceding content callback
          // has measured the same complete content coordinates.
          if (target > Math.max(0, listGeometry.current.content - height)) {
            const available = Math.max(0, listGeometry.current.content - height)
            requestOffset(available)
            return
          }
          positions.current.set(saved.id, {
            ...position,
            data: dataKey,
            version
          })
          requestOffset(target, true)
        })
        .catch(() => undefined)
        .finally(() => {
          measuring.current = false
          if (dirty.current && liveData()) {
            dirty.current = false
            restoration.current()
          }
        })
    }
    const tail = measuredTail.current
    const complete =
      tail != null &&
      tail.data === dataKey &&
      tail.version === layoutVersion.current &&
      Math.abs(tail.end - content) <= 1
    if (
      content < height + restoreOffset.current &&
      chats.length > 0 &&
      !complete
    ) {
      const available = Math.max(0, content - height)
      const progress = revealProgress.current
      if (progress.data !== dataKey || available > progress.offset) {
        revealProgress.current = { data: dataKey, offset: available }
        requestOffset(available)
      }
      return
    }
    if (saved != null && rows.some(row => row.key === saved.id)) {
      if (!rowRefs.current.has(saved.id))
        requestOffset(
          Math.min(restoreOffset.current, Math.max(0, content - height))
        )
      return
    }
    anchorOwned.current = false
    anchor.current = undefined
    requestOffset(
      Math.min(restoreOffset.current, Math.max(0, content - height)),
      true
    )
  }
  restoration.current = restoreList
  const userScrolled = (): void => {
    if (!scrollOwner.current.live || !scrollOwner.current.visible) return
    restored.current = true
    setFastRestore(false)
    anchorOwned.current = false
    anchor.current = undefined
    gestureGeneration.current += 1
  }
  const rememberOffset = (event: {
    nativeEvent: { contentOffset: { y: number } }
  }): void => {
    if (!liveData()) return
    const offset = Math.max(0, event.nativeEvent.contentOffset.y)
    currentOffset.current = offset
    acknowledgedOffset.current = {
      offset,
      data: dataKey,
      visibility: visibilityVersion,
      generation: gestureGeneration.current
    }
    if (
      !restored.current &&
      requestedFinal.current &&
      requestedVersion.current === layoutVersion.current &&
      requested.current != null &&
      Math.abs(offset - requested.current) <= 1
    ) {
      restored.current = true
      setFastRestore(false)
    }
    if (
      !restored.current &&
      requestedFinal.current &&
      requested.current != null &&
      Math.abs(offset - requested.current) > 1
    )
      rejectedRequest.current = true
    savePosition()
    if (!restored.current || anchorOwned.current) restoration.current()
    for (const id of visible.current) measureRow(id)
  }
  useEffect(() => {
    geometryValidation.current()
    restoration.current()
  }, [chats, dataKey, listVisible])
  useEffect(() => bindUserScroll(list.current, userScrolled), [])
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
      for (const id of visible.current) measureRows.current(id)
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
          if (!liveData()) return
          layoutVersion.current += 1
          listGeometry.current.height = event.nativeEvent.layout.height
          for (const id of visible.current) measureRows.current(id)
          revalidateGeometry()
          restoreList()
          const last = rows.at(-1)?.key
          if (last != null) measureRow(last)
        }}
        onContentSizeChange={(_width, height) => {
          if (!liveData()) return
          layoutVersion.current += 1
          listGeometry.current.content = height
          listGeometry.current.data = dataKey
          restoreList()
          for (const id of visible.current) measureRows.current(id)
          const last = rows.at(-1)?.key
          if (last != null) measureRow(last)
        }}
        onScrollToIndexFailed={info => {
          const seek = seeking.current
          if (
            !liveData() ||
            seek == null ||
            seek.data !== dataKey ||
            seek.index !== info.index ||
            !anchorOwned.current
          )
            return
          const available = Math.max(
            0,
            listGeometry.current.content - listGeometry.current.height
          )
          const estimated =
            info.averageItemLength > 0
              ? info.averageItemLength * info.index
              : available
          requestOffset(Math.min(available, estimated))
        }}
        // Keep the normal virtual window, but fill it in larger bounded
        // batches while a browser return seeks its already saved reader.
        maxToRenderPerBatch={
          Platform.OS === 'web' && fastRestore ? 50 : undefined
        }
        // Web batches remain bounded; queue them directly for the interaction
        // scheduler instead of adding a timer between restoration steps.
        updateCellsBatchingPeriod={Platform.OS === 'web' ? 0 : undefined}
        onScroll={rememberOffset}
        onScrollEndDrag={rememberOffset}
        onMomentumScrollEnd={rememberOffset}
        scrollEventThrottle={100}
        onScrollBeginDrag={() => {
          // RNW also emits this for the programmatic restoration steps.
          if (Platform.OS !== 'web' && liveData()) {
            userScrolled()
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
              onRef={node => {
                if (node == null) rowRefs.current.delete(item.chat.id)
                else rowRefs.current.set(item.chat.id, node)
              }}
              onLayout={event => {
                if (!liveData()) return
                layoutVersion.current += 1
                measureRow(item.chat.id)
                for (const id of visible.current) measureRows.current(id)
                revalidateGeometry()
                const last = rows.at(-1)?.key
                if (last != null && last !== item.chat.id) measureRow(last)
                restoreList()
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
  onRef?: (node: React.ComponentRef<typeof View> | null) => void
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
      ref={node => {
        ref.current = node
        props.onRef?.(node)
      }}
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
