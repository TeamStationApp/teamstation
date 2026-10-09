import React, { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { lstrings, sprintf } from '../locales/strings'
import { lightHaptic } from '../scoring/lightHaptic'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AttachmentView, type ChatFileOps } from './AttachmentView'
import { type MessagePressGesture, pressPoint } from './chatInteractionModel'
import { type MessageAction, messagePreview, readLine } from './chatModel'
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
  onLongPress: (message: MessageView, anchor?: unknown) => void
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
}

const clock = (iso: string): string =>
  new Date(iso).toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit'
  })

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
  const desktop = isFinePointer()
  const row = useRef<React.ComponentRef<typeof View>>(null)
  const [hovered, setHovered] = useState(false)
  const held = useRef({
    x: 0,
    y: 0,
    generation: 0,
    cancelled: false,
    recognized: false,
    pointer: false
  })
  useEffect(
    () =>
      props.selected === true
        ? undefined
        : bindMessageHover(row.current, setHovered),
    [props.selected]
  )
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
    onLongPress(message)
  }
  const actions =
    props.actions ??
    (message.status === 'ok' ? ['reply', 'react', 'copy', 'pin'] : [])
  const messageGesture: MessagePressGesture | undefined =
    !desktop && props.selected !== true
      ? {
          pressProps: {
            ...immediatePressProps,
            onPressIn: event => {
              const point = pressPoint(event.nativeEvent)
              held.current = {
                x: point?.x ?? 0,
                y: point?.y ?? 0,
                generation: props.gestureGeneration?.current ?? 0,
                cancelled: false,
                recognized: false,
                pointer: point != null
              }
            },
            onTouchMove: event => {
              const point = pressPoint(event.nativeEvent)
              if (
                point == null ||
                Math.hypot(point.x - held.current.x, point.y - held.current.y) >
                  10
              )
                held.current.cancelled = true
            },
            onTouchCancel: () => {
              held.current.cancelled = true
            },
            onLongPress: actions.length > 0 ? openActions : undefined,
            delayLongPress: 500
          },
          canOpen: () =>
            !held.current.cancelled &&
            !held.current.recognized &&
            (!held.current.pointer ||
              held.current.generation ===
                (props.gestureGeneration?.current ?? 0))
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
          <Pressable
            {...immediatePressProps}
            {...messageGesture?.pressProps}
            // The words inside stay their own elements to a screen reader and
            // to the UI tests: no label of its own.
            accessible={false}
            style={[
              styles.bubble,
              message.mine ? styles.bubbleMine : styles.bubbleTheirs,
              said != null && styles.bubbleMuted,
              { maxWidth: props.maxWidth }
            ]}
          >
            {!message.mine && <Text style={styles.sender}>{sender}</Text>}
            {message.quote != null && (
              <ReplyQuote
                quote={message.quote}
                userId={props.userId ?? -1}
                onJump={id => props.onJump?.(id)}
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
            {props.selected === true && message.attachments.length > 0 ? (
              <Text style={styles.body}>
                {messagePreview({ ...message, body: '' })}
              </Text>
            ) : (
              message.attachments.map(attachment => (
                <AttachmentView
                  key={attachment.id}
                  attachment={attachment}
                  engine={props.engine}
                  files={props.files}
                  maxWidth={props.maxWidth}
                  messageGesture={messageGesture}
                />
              ))
            )}
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
          </Pressable>
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
                onLongPress(message)
              }}
              style={{ padding: theme.rem(0.375) }}
            >
              <Text style={styles.meta}>•••</Text>
            </Pressable>
          )}
        </View>
        {message.reactions.length > 0 && (
          <View style={[styles.reactions, message.mine && styles.rowMine]}>
            {message.reactions.map(reaction => (
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
                onPress={() => {
                  if (messageGesture?.canOpen() === false) return
                  props.onToggleReaction(message, reaction.emoji, reaction.mine)
                }}
                style={[styles.reaction, reaction.mine && styles.reactionMine]}
              >
                <Text style={styles.reactionText}>
                  {`${reaction.emoji} ${reaction.userIds.length}`}
                </Text>
              </Pressable>
            ))}
          </View>
        )}
      </View>
    </SwipeToReply>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  bubbleRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.25),
    maxWidth: '100%'
  },
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
    paddingHorizontal: theme.rem(0.75),
    paddingVertical: theme.rem(0.5),
    gap: theme.rem(0.25)
  },
  bubbleMine: {
    backgroundColor: theme.winBadgeBackground
  },
  bubbleTheirs: {
    backgroundColor: theme.cardBackgroundColor,
    borderWidth: 1,
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
