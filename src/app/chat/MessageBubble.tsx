import React, { useEffect, useRef, useState } from 'react'
import {
  type GestureResponderEvent,
  Image,
  Pressable,
  Text,
  View
} from 'react-native'

import { lstrings, sprintf } from '../locales/strings'
import { lightHaptic } from '../scoring/lightHaptic'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  AttachmentView,
  type ChatFileOps,
  type LoadedChatPicture
} from './AttachmentView'
import { ChatAvatar } from './ChatAvatar'
import { memberIdentity } from './chatIdentityModel'
import {
  type MessagePressGesture,
  pressPoint,
  pressStamp
} from './chatInteractionModel'
import { captureMessageBounds, type MessageSource } from './chatMessageSource'
import {
  type MessageAction,
  messagePreview,
  placeholderSize,
  readLine
} from './chatModel'
import {
  bindMessageHover,
  immediatePressProps,
  isFinePointer
} from './chatWebInteractions'
import type { MessageView } from './engine/apply'
import type { ConversationListItem, MemberView } from './engine/engine'
import { MessageActions } from './MessageActions'
import { ReplyQuote } from './ReplyQuote'
import type { ChatScreenEngine } from './screenEngine'
import { SwipeToReply } from './SwipeToReply'

export interface MessageBubbleProps {
  message: MessageView
  conversation: ConversationListItem
  members: MemberView[]
  engine: Pick<ChatScreenEngine, 'openAttachment'>
  files: ChatFileOps
  maxWidth: number
  swipe: boolean
  onLongPress: (
    message: MessageView,
    anchor?: unknown,
    source?: MessageSource
  ) => void
  onReply: (message: MessageView) => void
  onToggleReaction: (message: MessageView, emoji: string, mine: boolean) => void
  onReact?: (message: MessageView) => void
  onJump?: (id: string) => void
  userId?: number
  actions?: MessageAction[]
  pinned?: boolean
  highlighted?: boolean
  gestureGeneration?: React.RefObject<number>
  selected?: boolean
  showSenderAvatar?: boolean
  pictures?: ReadonlyMap<string, LoadedChatPicture>
}

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  })

const BUBBLE_PADDING_REM = 0.75
const RECEIVED_BUBBLE_BORDER = 1

/** What a message that cannot be read says instead of its words. */
function statusText(message: MessageView): string | undefined {
  switch (message.status) {
    case 'removed':
      return message.removedBy === 'moderator'
        ? lstrings.chat_removed_moderator
        : lstrings.chat_removed_author
    case 'locked':
      return lstrings.chat_locked_message
    case 'lost':
      return lstrings.chat_lost_message
    case 'invalid':
      return lstrings.chat_invalid_message
    default:
      return undefined
  }
}

/**
 * One message: who sent it (someone who has left is a Former member), the
 * message it replies to, its words, attachments and reactions, and — on the
 * person's own — who has read it. A long press opens its menu; on a phone a
 * drag to the right replies.
 */
export function MessageBubble(props: MessageBubbleProps): React.ReactElement {
  const { message, conversation, members, onLongPress, onReply } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const [laidOutWidth, setLaidOutWidth] = useState<number>()
  useEffect(() => {
    setLaidOutWidth(undefined)
  }, [props.maxWidth])
  // maxWidth caps the complete bubble, so media uses only its inner box.
  // Adjacent actions can shrink that box further on a narrow viewport.
  const attachmentWidth = Math.max(
    0,
    Math.min(props.maxWidth, laidOutWidth ?? props.maxWidth) -
      2 *
        (theme.rem(BUBBLE_PADDING_REM) +
          (message.mine ? 0 : RECEIVED_BUBBLE_BORDER))
  )
  const desktop = isFinePointer()
  const BubbleContainer = props.selected === true ? View : Pressable
  const row = useRef<React.ComponentRef<typeof View>>(null)
  const bubble = useRef<React.ComponentRef<typeof View>>(null)
  const live = useRef(true)
  const latest = useRef(props)
  latest.current = props
  const capture = useRef(0)
  const cancelCapture = useRef<(() => void) | undefined>(undefined)
  const pictures = useRef(new Map<string, LoadedChatPicture>())
  useEffect(() => {
    live.current = true
    const shownPictures = pictures.current
    return () => {
      live.current = false
      capture.current += 1
      cancelCapture.current?.()
      shownPictures.clear()
    }
  }, [])
  const [hovered, setHovered] = useState(false)
  const held = useRef({
    x: 0,
    y: 0,
    generation: 0,
    cancelled: false,
    recognized: false,
    pointer: false,
    nativeStart: undefined as ReturnType<typeof pressStamp>
  })
  useEffect(
    () =>
      props.selected === true
        ? undefined
        : bindMessageHover(row.current, setHovered),
    [props.selected]
  )
  const presentActions = (fromHold: boolean): void => {
    cancelCapture.current?.()
    const version = ++capture.current
    const generation = props.gestureGeneration?.current ?? 0
    const signature = props.actions?.join('|')
    const valid = (): boolean =>
      live.current &&
      version === capture.current &&
      latest.current.message.id === message.id &&
      latest.current.message.status === message.status &&
      latest.current.actions?.join('|') === signature &&
      (latest.current.gestureGeneration?.current ?? 0) === generation &&
      (!fromHold || !held.current.cancelled)
    cancelCapture.current = captureMessageBounds(
      bubble.current,
      valid,
      bounds => {
        if (!valid()) return
        const source: MessageSource | undefined =
          bounds == null
            ? undefined
            : {
                bounds,
                measure: accept =>
                  captureMessageBounds(bubble.current, valid, accept),
                pictures: () => (valid() ? pictures.current : undefined)
              }
        latest.current.onLongPress(latest.current.message, undefined, source)
      }
    )
  }
  const openActions = (): void => {
    if (
      held.current.cancelled ||
      !held.current.pointer ||
      held.current.recognized ||
      held.current.generation !== (props.gestureGeneration?.current ?? 0)
    )
      return
    held.current.recognized = true
    lightHaptic(row.current)
    presentActions(true)
  }
  const actions =
    props.actions ??
    (message.status === 'ok' ? ['reply', 'react', 'copy', 'pin'] : [])
  const recognizeReleasedHold = (event?: GestureResponderEvent): void => {
    if (event == null || actions.length === 0) return
    const started = held.current.nativeStart
    const released = pressStamp(event.nativeEvent)
    if (started == null || released == null) return
    if (
      released.identifier !== started.identifier ||
      released.timestamp < started.timestamp
    ) {
      held.current.cancelled = true
      return
    }
    if (released.timestamp - started.timestamp < 500) return
    const point = pressPoint(event.nativeEvent)
    if (
      point == null ||
      Math.hypot(point.x - held.current.x, point.y - held.current.y) > 10
    ) {
      held.current.cancelled = true
      return
    }
    openActions()
  }
  const cancelMovedHold = (event: GestureResponderEvent): void => {
    const point = pressPoint(event.nativeEvent)
    if (
      point == null ||
      Math.hypot(point.x - held.current.x, point.y - held.current.y) > 10
    )
      held.current.cancelled = true
  }
  const messageGesture: MessagePressGesture | undefined =
    !desktop && props.selected !== true
      ? {
          pressProps: {
            ...immediatePressProps,
            onPressIn: event => {
              const point = pressPoint(event.nativeEvent)
              const nativeStart = pressStamp(event.nativeEvent)
              // Nested/parent starts for the same contact must not restart it.
              if (
                nativeStart != null &&
                nativeStart.identifier ===
                  held.current.nativeStart?.identifier &&
                nativeStart.timestamp === held.current.nativeStart.timestamp
              )
                return
              cancelCapture.current?.()
              capture.current += 1
              held.current = {
                x: point?.x ?? 0,
                y: point?.y ?? 0,
                generation: props.gestureGeneration?.current ?? 0,
                cancelled: false,
                recognized: false,
                pointer: point != null,
                nativeStart
              }
            },
            // PressOut can be delayed by Pressability's minimum JS duration.
            // Real release activation is therefore the final native-time gate.
            onPress: recognizeReleasedHold,
            onPressOut: event => {
              // RNW normalizes the release contact, while onPress gets raw click.
              // Termination and keyboard events are not contact releases.
              if (
                'type' in event.nativeEvent &&
                (event.nativeEvent.type === 'mouseup' ||
                  event.nativeEvent.type === 'touchend')
              )
                recognizeReleasedHold(event)
            },
            onPressMove: event => {
              if (
                'type' in event.nativeEvent &&
                event.nativeEvent.type === 'mousemove'
              )
                cancelMovedHold(event)
            },
            onTouchMove: cancelMovedHold,
            onTouchCancel: () => {
              held.current.cancelled = true
            },
            onLongPress: actions.length > 0 ? openActions : undefined,
            delayLongPress: 500
          },
          canOpen: event => {
            recognizeReleasedHold(event)
            return (
              !held.current.cancelled &&
              !held.current.recognized &&
              (!held.current.pointer ||
                held.current.generation ===
                  (props.gestureGeneration?.current ?? 0))
            )
          }
        }
      : undefined
  const sender = message.mine
    ? lstrings.chat_you
    : (message.senderName ?? lstrings.chat_former_member)
  const said = statusText(message)
  const read = message.mine
    ? readLine(message, conversation, members, lstrings.chat_former_member)
    : undefined

  return (
    <SwipeToReply
      enabled={props.swipe && message.status === 'ok'}
      onReply={() => {
        onReply(message)
      }}
      onStart={() => {
        held.current.cancelled = true
      }}
    >
      <View
        ref={row}
        collapsable={false}
        testID={`chat-message-${message.id}`}
        style={[
          styles.row,
          message.mine && styles.rowMine,
          props.highlighted === true && {
            backgroundColor: theme.pillBackground,
            borderRadius: theme.rem(1)
          }
        ]}
      >
        <View style={[styles.bubbleRow, message.mine && styles.bubbleRowMine]}>
          {desktop &&
            props.selected !== true &&
            actions.length > 0 &&
            message.mine && (
              <MessageActions
                visible={hovered}
                reply={actions.includes('reply')}
                react={actions.includes('react')}
                onReply={() => {
                  onReply(message)
                }}
                onReact={() => props.onReact?.(message)}
                onMore={anchor => {
                  onLongPress(message, anchor)
                }}
              />
            )}
          {!message.mine && props.selected !== true && (
            <View
              testID={`chat-avatar-lane-${message.id}`}
              style={styles.avatarLane}
            >
              {props.showSenderAvatar !== false && (
                <ChatAvatar
                  identity={memberIdentity(
                    members.find(
                      member => member.userId === message.senderUserId
                    )
                  )}
                  size={1.75}
                />
              )}
            </View>
          )}
          <BubbleContainer
            ref={bubble}
            collapsable={false}
            testID={'chat-bubble-' + message.id}
            onLayout={event => {
              const width = event.nativeEvent.layout.width
              if (width > 0 && Number.isFinite(width))
                setLaidOutWidth(previous =>
                  previous != null && Math.abs(previous - width) < 0.5
                    ? previous
                    : width
                )
            }}
            {...immediatePressProps}
            {...messageGesture?.pressProps}
            // The words inside stay their own elements to a screen reader and
            // to the UI tests: no label of its own.
            accessible={false}
            style={[
              styles.bubble,
              message.mine ? styles.bubbleMine : styles.bubbleTheirs,
              said != null && styles.bubbleMuted,
              { maxWidth: props.maxWidth },
              props.selected === true && { width: props.maxWidth }
            ]}
          >
            {!message.mine && <Text style={styles.sender}>{sender}</Text>}
            {message.quote != null && (
              <ReplyQuote
                quote={message.quote}
                userId={props.userId ?? -1}
                onJump={props.selected === true ? undefined : props.onJump}
                messageGesture={messageGesture}
              />
            )}
            {said != null ? (
              <Text style={styles.status}>{said}</Text>
            ) : (
              message.body !== '' && (
                <Text
                  style={styles.body}
                  selectable={desktop && props.selected !== true}
                >
                  {message.body}
                </Text>
              )
            )}
            {message.attachments.map(attachment => {
              if (props.selected === true) {
                const picture = props.pictures?.get(attachment.id)
                if (picture?.attachment === attachment && picture.valid()) {
                  const size = placeholderSize(
                    picture.width,
                    picture.height,
                    attachmentWidth,
                    theme.rem(20)
                  )
                  return (
                    <Image
                      key={attachment.id}
                      accessibilityLabel={attachment.fileName}
                      source={{ uri: picture.uri }}
                      style={[
                        size,
                        { borderRadius: theme.rem(theme.radiusRem) }
                      ]}
                      resizeMode="cover"
                    />
                  )
                }
                return (
                  <Text key={attachment.id} style={styles.body}>
                    {messagePreview({
                      ...message,
                      body: '',
                      attachments: [attachment]
                    })}
                  </Text>
                )
              }
              return (
                <AttachmentView
                  key={attachment.id}
                  attachment={attachment}
                  engine={props.engine}
                  files={props.files}
                  maxWidth={attachmentWidth}
                  messageGesture={messageGesture}
                  onPicture={picture => {
                    if (picture == null) pictures.current.delete(attachment.id)
                    else pictures.current.set(attachment.id, picture)
                  }}
                />
              )
            })}
            <View style={styles.footer}>
              {props.pinned === true && (
                <Text
                  style={styles.meta}
                  accessibilityLabel={lstrings.chat_message_pinned}
                >
                  ⌖ {lstrings.chat_pinned}
                </Text>
              )}
              <Text style={styles.meta}>{clock(message.sentAt)}</Text>
              {message.edited && message.status === 'ok' && (
                <Text style={styles.meta}>{lstrings.chat_edited}</Text>
              )}
              {read != null && (
                <Text style={styles.meta}>
                  {read.kind === 'sent'
                    ? `✓ ${lstrings.chat_sent}`
                    : read.kind === 'count'
                      ? `✓✓ ${sprintf(lstrings.chat_seen_by, read.count)}`
                      : `✓✓ ${sprintf(lstrings.chat_read_by, read.names.join(', '))}`}
                </Text>
              )}
            </View>
            {message.sentBeforeSafetyNumberChange && (
              <Text style={styles.meta}>
                {sprintf(lstrings.chat_sent_before_change, sender)}
              </Text>
            )}
          </BubbleContainer>
          {desktop &&
            props.selected !== true &&
            actions.length > 0 &&
            !message.mine && (
              <MessageActions
                visible={hovered}
                reply={actions.includes('reply')}
                react={actions.includes('react')}
                onReply={() => {
                  onReply(message)
                }}
                onReact={() => props.onReact?.(message)}
                onMore={anchor => {
                  onLongPress(message, anchor)
                }}
              />
            )}
          {!desktop && props.selected !== true && actions.length > 0 && (
            <Pressable
              accessibilityRole="button"
              accessibilityLabel={lstrings.chat_more_message_actions}
              onPress={() => {
                presentActions(false)
              }}
              style={{ padding: theme.rem(0.375) }}
            >
              <Text style={styles.meta}>•••</Text>
            </Pressable>
          )}
        </View>
        {message.reactions.length > 0 && (
          <View
            style={[
              styles.reactions,
              message.mine && styles.rowMine,
              !message.mine &&
                props.selected !== true && { marginLeft: theme.rem(2) }
            ]}
          >
            {message.reactions.map(reaction =>
              props.selected === true ? (
                <View
                  key={reaction.emoji}
                  accessible
                  accessibilityLabel={sprintf(
                    lstrings.chat_reaction_label,
                    reaction.emoji,
                    reaction.userIds.length
                  )}
                  style={[
                    styles.reaction,
                    reaction.mine && styles.reactionMine
                  ]}
                >
                  <Text style={styles.reactionText}>
                    {`${reaction.emoji} ${reaction.userIds.length}`}
                  </Text>
                </View>
              ) : (
                <Pressable
                  key={reaction.emoji}
                  {...messageGesture?.pressProps}
                  accessibilityRole="button"
                  accessibilityLabel={sprintf(
                    lstrings.chat_reaction_label,
                    reaction.emoji,
                    reaction.userIds.length
                  )}
                  accessibilityState={{ selected: reaction.mine }}
                  onPress={event => {
                    if (messageGesture?.canOpen(event) === false) return
                    props.onToggleReaction(
                      message,
                      reaction.emoji,
                      reaction.mine
                    )
                  }}
                  style={[
                    styles.reaction,
                    reaction.mine && styles.reactionMine
                  ]}
                >
                  <Text style={styles.reactionText}>
                    {`${reaction.emoji} ${reaction.userIds.length}`}
                  </Text>
                </Pressable>
              )
            )}
          </View>
        )}
      </View>
    </SwipeToReply>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  bubbleRow: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    gap: theme.rem(0.25),
    maxWidth: '100%'
  },
  avatarLane: { width: theme.rem(1.75), flexShrink: 0 },
  bubbleRowMine: { justifyContent: 'flex-end' },
  row: {
    alignItems: 'flex-start',
    gap: theme.rem(0.25)
  },
  rowMine: {
    alignItems: 'flex-end'
  },
  bubble: {
    flexShrink: 1,
    borderRadius: theme.rem(1),
    paddingHorizontal: theme.rem(BUBBLE_PADDING_REM),
    paddingVertical: theme.rem(0.5),
    gap: theme.rem(0.25)
  },
  bubbleMine: {
    backgroundColor: theme.winBadgeBackground
  },
  bubbleTheirs: {
    backgroundColor: theme.cardBackgroundColor,
    borderWidth: RECEIVED_BUBBLE_BORDER,
    borderColor: theme.defaultBorderColor
  },
  bubbleMuted: {
    backgroundColor: theme.containerBackgroundColor
  },
  sender: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600',
    color: theme.secondaryTextColor
  },
  quote: {
    borderLeftWidth: 3,
    borderLeftColor: theme.activeColor,
    paddingLeft: theme.rem(0.5),
    paddingVertical: theme.rem(0.125)
  },
  quoteName: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '600',
    color: theme.activeColor
  },
  quoteText: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  body: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(1),
    color: theme.primaryTextColor
  },
  status: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    fontStyle: 'italic',
    color: theme.secondaryTextColor
  },
  footer: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(0.375),
    justifyContent: 'flex-end'
  },
  meta: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.6875),
    color: theme.secondaryTextColor
  },
  reactions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: theme.rem(0.25)
  },
  reaction: {
    borderRadius: theme.rem(0.75),
    borderWidth: 1,
    borderColor: theme.defaultBorderColor,
    backgroundColor: theme.cardBackgroundColor,
    paddingHorizontal: theme.rem(0.5),
    paddingVertical: theme.rem(0.125)
  },
  reactionMine: {
    borderColor: theme.activeColor
  },
  reactionText: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.primaryTextColor
  }
}))
