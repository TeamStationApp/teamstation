import React from 'react'
import { Pressable, Text, View } from 'react-native'

import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { AttachmentView, type ChatFileOps } from './AttachmentView'
import { readLine } from './chatModel'
import type { MessageView } from './engine/apply'
import type { ConversationListItem, MemberView } from './engine/engine'
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
  onLongPress: (message: MessageView) => void
  onReply: (message: MessageView) => void
  onToggleReaction: (message: MessageView, emoji: string, mine: boolean) => void
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
    >
      <View style={[styles.row, message.mine && styles.rowMine]}>
        <Pressable
          // The words inside stay their own elements to a screen reader and
          // to the UI tests: no label of its own.
          accessible={false}
          onLongPress={() => {
            onLongPress(message)
          }}
          delayLongPress={400}
          style={[
            styles.bubble,
            message.mine ? styles.bubbleMine : styles.bubbleTheirs,
            said != null && styles.bubbleMuted
          ]}
        >
          {!message.mine && <Text style={styles.sender}>{sender}</Text>}
          {message.quote != null && (
            <View style={styles.quote}>
              <Text style={styles.quoteName}>
                {message.quote.authorName ?? lstrings.chat_former_member}
              </Text>
              <Text style={styles.quoteText} numberOfLines={3}>
                {message.quote.snippet}
              </Text>
            </View>
          )}
          {said != null ? (
            <Text style={styles.status}>{said}</Text>
          ) : (
            message.body !== '' && (
              <Text style={styles.body} selectable>
                {message.body}
              </Text>
            )
          )}
          {message.attachments.map(attachment => (
            <AttachmentView
              key={attachment.id}
              attachment={attachment}
              engine={props.engine}
              files={props.files}
              maxWidth={props.maxWidth}
            />
          ))}
          <View style={styles.footer}>
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
        {message.reactions.length > 0 && (
          <View style={[styles.reactions, message.mine && styles.rowMine]}>
            {message.reactions.map(reaction => (
              <Pressable
                key={reaction.emoji}
                accessibilityRole="button"
                accessibilityLabel={sprintf(
                  lstrings.chat_reaction_label,
                  reaction.emoji,
                  reaction.userIds.length
                )}
                accessibilityState={{ selected: reaction.mine }}
                onPress={() => {
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
  row: {
    alignItems: 'flex-start',
    gap: theme.rem(0.25)
  },
  rowMine: {
    alignItems: 'flex-end'
  },
  bubble: {
    maxWidth: '85%',
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
