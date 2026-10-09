import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { Button } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { ChatActionOverlay } from './ChatActionOverlay'
import { ChatAnchoredMenu } from './ChatAnchoredMenu'
import { type MessageAction, QUICK_REACTIONS } from './chatModel'
import type { MessageView } from './engine/apply'

export interface MessageMenuProps {
  message: MessageView
  actions: MessageAction[]
  desktop?: boolean
  anchor?: unknown
  selected?: React.ReactNode
  onReply: () => void
  onReact: (emoji: string) => void
  onMoreEmoji: () => void
  onCopy?: () => Promise<void>
  onPin?: (pinned: boolean) => void
  onDelete: () => void
  onDeleteForEveryone?: () => void
  onClose: () => void
}

/** The personal actions available for this current message and permission set. */
export function MessageMenu(props: MessageMenuProps): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const [confirming, setConfirming] = useState(false)
  const [error, setError] = useState(false)
  const [copying, setCopying] = useState(false)
  const has = (action: MessageAction): boolean => props.actions.includes(action)
  const name = props.message.mine
    ? lstrings.chat_you
    : (props.message.senderName ?? lstrings.chat_former_member)
  const label = sprintf(lstrings.chat_message_actions, name)
  const reactions = has('react') && (
    <View style={styles.reactions}>
      {QUICK_REACTIONS.map(emoji => (
        <Pressable
          key={emoji}
          accessibilityRole="button"
          accessibilityLabel={sprintf(lstrings.chat_react, emoji)}
          onPress={() => {
            props.onReact(emoji)
          }}
          style={styles.reaction}
        >
          <Text style={styles.emoji}>{emoji}</Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={lstrings.chat_more_emoji}
        onPress={props.onMoreEmoji}
        style={styles.reaction}
      >
        <Text style={styles.emoji}>＋</Text>
      </Pressable>
    </View>
  )
  const children = confirming ? (
    <>
      <Text style={styles.detail}>{lstrings.chat_delete_confirm}</Text>
      <Button
        label={lstrings.chat_delete}
        kind="text"
        textColor={theme.dangerColor}
        onPress={() => {
          if (has('delete')) props.onDelete()
          else props.onDeleteForEveryone?.()
        }}
      />
      <Button
        label={lstrings.chat_cancel}
        kind="text"
        onPress={props.onClose}
      />
    </>
  ) : (
    <>
      {props.desktop !== true && has('reply') && (
        <Button
          label={lstrings.chat_reply}
          kind="text"
          onPress={props.onReply}
        />
      )}
      {has('copy') && (
        <Button
          label={
            props.desktop === true
              ? lstrings.chat_copy_text
              : lstrings.chat_copy
          }
          kind="text"
          disabled={copying}
          onPress={() => {
            setError(false)
            setCopying(true)
            // Invoke before teardown: browser clipboard requires this user gesture.
            const work = props.onCopy?.()
            if (work == null) {
              setCopying(false)
              setError(true)
              return
            }
            work
              .then(props.onClose)
              .catch(() => {
                setError(true)
              })
              .finally(() => {
                setCopying(false)
              })
          }}
        />
      )}
      {(has('pin') || has('unpin')) && (
        <Button
          label={has('unpin') ? lstrings.chat_unpin : lstrings.chat_pin}
          kind="text"
          onPress={() => props.onPin?.(!has('unpin'))}
        />
      )}
      {(has('delete') || has('deleteForEveryone')) && (
        <Button
          label={lstrings.chat_delete}
          kind="text"
          textColor={theme.dangerColor}
          onPress={() => {
            setConfirming(true)
          }}
        />
      )}
      {error && (
        <Text style={styles.error} accessibilityLiveRegion="polite">
          {lstrings.chat_copy_failed}
        </Text>
      )}
    </>
  )
  return props.desktop === true ? (
    <ChatAnchoredMenu
      anchor={props.anchor}
      label={label}
      onClose={props.onClose}
    >
      {children}
    </ChatAnchoredMenu>
  ) : (
    <ChatActionOverlay
      label={label}
      onClose={props.onClose}
      selected={
        <>
          {!confirming && reactions}
          {props.selected ?? (
            <View style={styles.selected}>
              <Text style={styles.detail}>{name}</Text>
              <Text style={styles.detail} numberOfLines={5}>
                {props.message.body}
              </Text>
            </View>
          )}
        </>
      }
    >
      {children}
    </ChatActionOverlay>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  reactions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderRadius: theme.rem(1.5),
    backgroundColor: theme.cardBackgroundColor,
    padding: theme.rem(0.25),
    marginBottom: theme.rem(0.5)
  },
  reaction: {
    width: theme.rem(2.5),
    height: theme.rem(2.5),
    alignItems: 'center',
    justifyContent: 'center'
  },
  emoji: { fontSize: theme.rem(1.375), color: theme.primaryTextColor },
  selected: {
    borderRadius: theme.rem(1),
    backgroundColor: theme.cardBackgroundColor,
    padding: theme.rem(0.75),
    gap: theme.rem(0.25)
  },
  detail: {
    color: theme.primaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    padding: theme.rem(0.25)
  },
  error: {
    color: theme.dangerColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  }
}))
