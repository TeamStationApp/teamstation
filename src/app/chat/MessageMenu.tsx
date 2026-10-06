import React, { useState } from 'react'
import { Modal, Pressable, Text, View } from 'react-native'

import { Button } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { type MessageAction, QUICK_REACTIONS } from './chatModel'
import { getChatStyles } from './chatStyles'
import type { MessageView } from './engine/apply'

export interface MessageMenuProps {
  message: MessageView
  actions: MessageAction[]
  onReply: () => void
  onReact: (emoji: string) => void
  onMoreEmoji: () => void
  onEdit: () => void
  onDelete: () => void
  onDeleteForEveryone: () => void
  /** Confirmed: report the message to the site administrators. */
  onReport: () => void
  onClose: () => void
}

/**
 * What a long press on a message offers: six quick reactions and the full
 * picker, Reply, Edit and Delete on the person's own, Delete for everyone
 * for a moderator on someone else's, and Report on someone else's, which
 * asks first, since it lets the site administrators read that message.
 */
export function MessageMenu(props: MessageMenuProps): React.ReactElement {
  const { message, actions, onClose } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const shared = getChatStyles(theme)
  const [confirming, setConfirming] = useState(false)
  const has = (action: MessageAction): boolean => actions.includes(action)
  const name = message.mine
    ? lstrings.chat_you
    : (message.senderName ?? lstrings.chat_former_member)

  if (confirming) {
    return (
      <Modal transparent animationType="fade" visible onRequestClose={onClose}>
        <View style={shared.scrim}>
          <Pressable
            style={shared.behind}
            onPress={onClose}
            accessibilityRole="button"
            accessibilityLabel={lstrings.chat_cancel}
          />
          <View
            style={[shared.sheet, styles.menu]}
            accessibilityLabel={lstrings.chat_report_title}
          >
            <Text style={shared.heading}>{lstrings.chat_report_title}</Text>
            <Text style={shared.muted}>
              {sprintf(lstrings.chat_report_detail, name)}
            </Text>
            <Button
              label={lstrings.chat_report_send}
              kind="text"
              textColor={theme.dangerColor}
              onPress={props.onReport}
            />
            <Button
              label={lstrings.chat_cancel}
              kind="text"
              onPress={onClose}
            />
          </View>
        </View>
      </Modal>
    )
  }

  return (
    <Modal transparent animationType="fade" visible onRequestClose={onClose}>
      <View style={shared.scrim}>
        <Pressable
          style={shared.behind}
          onPress={onClose}
          accessibilityRole="button"
          accessibilityLabel={lstrings.chat_cancel}
        />
        <View
          style={[shared.sheet, styles.menu]}
          accessibilityLabel={sprintf(lstrings.chat_message_actions, name)}
        >
          {has('react') && (
            <View style={styles.reactions}>
              {QUICK_REACTIONS.map(emoji => (
                <Pressable
                  key={emoji}
                  accessibilityRole="button"
                  accessibilityLabel={sprintf(lstrings.chat_react, emoji)}
                  onPress={() => {
                    props.onReact(emoji)
                  }}
                  style={({ pressed }) => [
                    styles.reaction,
                    pressed && styles.pressed
                  ]}
                >
                  <Text style={styles.emoji}>{emoji}</Text>
                </Pressable>
              ))}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={lstrings.chat_more_emoji}
                onPress={props.onMoreEmoji}
                style={({ pressed }) => [
                  styles.reaction,
                  pressed && styles.pressed
                ]}
              >
                <Text style={styles.more}>＋</Text>
              </Pressable>
            </View>
          )}
          {has('reply') && (
            <Button
              label={lstrings.chat_reply}
              kind="text"
              onPress={props.onReply}
            />
          )}
          {has('edit') && (
            <Button
              label={lstrings.chat_edit}
              kind="text"
              onPress={props.onEdit}
            />
          )}
          {has('delete') && (
            <Button
              label={lstrings.chat_delete}
              kind="text"
              textColor={theme.dangerColor}
              onPress={props.onDelete}
            />
          )}
          {has('deleteForEveryone') && (
            <Button
              label={lstrings.chat_delete_for_everyone}
              kind="text"
              textColor={theme.dangerColor}
              onPress={props.onDeleteForEveryone}
            />
          )}
          {has('report') && (
            <Button
              label={lstrings.chat_report}
              kind="text"
              textColor={theme.dangerColor}
              onPress={() => {
                setConfirming(true)
              }}
            />
          )}
          <Button label={lstrings.chat_cancel} kind="text" onPress={onClose} />
        </View>
      </View>
    </Modal>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  menu: {
    width: '100%',
    maxWidth: theme.rem(22),
    alignItems: 'stretch'
  },
  reactions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    justifyContent: 'space-between',
    gap: theme.rem(0.25)
  },
  reaction: {
    width: theme.rem(2.5),
    height: theme.rem(2.5),
    borderRadius: theme.rem(1.25),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.containerBackgroundColor
  },
  pressed: {
    opacity: 0.6
  },
  emoji: {
    fontSize: theme.rem(1.375),
    color: theme.primaryTextColor
  },
  more: {
    fontSize: theme.rem(1.125),
    color: theme.secondaryTextColor
  }
}))
