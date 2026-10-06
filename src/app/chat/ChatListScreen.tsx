import React, { useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { Badge, Button, Card, Icon, Screen, SectionHeader } from '../components'
import { lstrings, plural, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { canStartDm, groupChats, timeLabel } from './chatModel'
import { getChatStyles } from './chatStyles'
import type { ConversationListItem } from './engine/engine'
import type { ChatScreenEngine } from './screenEngine'

export interface ChatListScreenProps {
  engine: Pick<ChatScreenEngine, 'refresh' | 'conversations' | 'subscribe'>
  onOpen: (chat: ConversationListItem) => void
  onNewMessage: () => void
  onFollowTeam: () => void
  /** For the times; the clock by default. */
  now?: () => Date
}

/**
 * The Chat tab: every chat the person is in, grouped by league, season and
 * team, then their direct messages, each with its unread count, a Locked
 * badge while this device cannot read its history, and when it last had a
 * message. **New message** shows only for someone who may start one;
 * **Follow a team** opens the follow screen.
 */
export function ChatListScreen(props: ChatListScreenProps): React.ReactElement {
  const { engine, onOpen, onNewMessage, onFollowTeam } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const shared = getChatStyles(theme)
  const [chats, setChats] = useState<ConversationListItem[] | undefined>(
    undefined
  )
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    let live = true
    const unsubscribe = engine.subscribe(event => {
      if (event.type === 'conversations' && live) {
        setChats(engine.conversations())
      }
    })
    engine
      .refresh()
      .then(list => {
        if (live) setChats(list)
      })
      .catch(() => {
        if (live) setFailed(true)
      })
    return () => {
      live = false
      unsubscribe()
    }
  }, [engine])

  const now = props.now?.() ?? new Date()

  return (
    <Screen>
      <View style={shared.actions}>
        {chats != null && canStartDm(chats) && (
          <Button
            label={lstrings.chat_new_message}
            kind="primary"
            icon="edit"
            onPress={onNewMessage}
          />
        )}
        <Button
          label={lstrings.chat_follow_team}
          kind="secondary"
          onPress={onFollowTeam}
        />
      </View>
      {failed && chats == null ? (
        <Text style={shared.error}>{lstrings.chat_cannot_load}</Text>
      ) : chats == null ? (
        <Text style={shared.muted}>{lstrings.common_loading}</Text>
      ) : chats.length === 0 ? (
        <Card>
          <Text style={shared.heading}>{lstrings.chat_empty}</Text>
          <Text style={shared.muted}>{lstrings.chat_empty_detail}</Text>
        </Card>
      ) : (
        groupChats(chats).map(group => (
          <View key={group.key} style={styles.group}>
            <SectionHeader title={group.title ?? lstrings.chat_direct} />
            <Card flush>
              {group.chats.map((chat, index) => (
                <View key={chat.id}>
                  {index > 0 && <View style={shared.divider} />}
                  <Pressable
                    accessibilityRole="button"
                    accessibilityLabel={chat.title}
                    onPress={() => {
                      onOpen(chat)
                    }}
                    style={({ pressed }) => [
                      styles.row,
                      pressed && styles.pressed
                    ]}
                  >
                    <View style={styles.text}>
                      <View style={styles.line}>
                        <Text
                          style={[
                            styles.title,
                            chat.unread > 0 && styles.titleUnread
                          ]}
                          numberOfLines={1}
                        >
                          {chat.title}
                        </Text>
                        <Text style={shared.small}>
                          {timeLabel(chat.lastMessageAt, now)}
                        </Text>
                      </View>
                      <View style={styles.line}>
                        <Text style={[shared.small, styles.detail]}>
                          {chat.lastMessageAt == null
                            ? lstrings.chat_no_messages
                            : plural(
                                chat.memberCount,
                                lstrings.chat_members_count_one,
                                lstrings.chat_members_count_many
                              )}
                        </Text>
                        {chat.locked && (
                          <View style={styles.locked}>
                            <Icon
                              name="lock"
                              size={0.875}
                              color={theme.secondaryTextColor}
                            />
                            <Badge
                              label={lstrings.chat_locked_badge}
                              tone="neutral"
                            />
                          </View>
                        )}
                        {chat.closed && (
                          <Badge
                            label={lstrings.chat_closed_badge}
                            tone="neutral"
                          />
                        )}
                        {chat.unread > 0 && (
                          <View
                            style={styles.unread}
                            accessibilityLabel={sprintf(
                              lstrings.chat_unread_label,
                              chat.unread
                            )}
                          >
                            <Text style={styles.unreadText}>{chat.unread}</Text>
                          </View>
                        )}
                      </View>
                    </View>
                    <Icon
                      name="chevron_right"
                      color={theme.secondaryTextColor}
                    />
                  </Pressable>
                </View>
              ))}
            </Card>
          </View>
        ))
      )}
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  group: {
    gap: theme.rem(theme.spaceSmRem)
  },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem),
    paddingHorizontal: theme.rem(theme.spaceMdRem),
    paddingVertical: theme.rem(theme.spaceSmRem)
  },
  pressed: {
    backgroundColor: theme.containerBackgroundColor
  },
  text: {
    flex: 1,
    gap: theme.rem(0.25)
  },
  line: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  title: {
    flex: 1,
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(1),
    fontWeight: '500',
    color: theme.primaryTextColor
  },
  titleUnread: {
    fontWeight: '700',
    fontFamily: theme.boldTextFont
  },
  detail: {
    flex: 1
  },
  locked: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.25)
  },
  unread: {
    minWidth: theme.rem(1.375),
    height: theme.rem(1.375),
    borderRadius: theme.rem(0.6875),
    paddingHorizontal: theme.rem(0.375),
    alignItems: 'center',
    justifyContent: 'center',
    backgroundColor: theme.primaryButtonColor
  },
  unreadText: {
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(0.75),
    fontWeight: '700',
    color: theme.buttonTextColor
  }
}))
