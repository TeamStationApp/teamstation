import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Keyboard,
  Platform,
  ScrollView,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import { MAX_ATTACHMENT_SIZE } from '../../common/chatContent'
import {
  Button,
  FLOATING_BOTTOM_REM,
  Icon,
  NAV_CLEARANCE_REM,
  Screen
} from '../components'
import { navClearanceAboveInset } from '../components/navClearance'
import { lstrings, plural, sprintf } from '../locales/strings'
import { useInsets } from '../platform/safeArea'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import type { ChatFileOps } from './AttachmentView'
import * as platformFiles from './chatFiles'
import type { PickedFile, PickSource } from './chatFileTypes'
import { actionsFor, approvalsIn, typingNames } from './chatModel'
import { getChatStyles } from './chatStyles'
import { Composer } from './Composer'
import { EmojiPicker } from './EmojiPicker'
import type { MessageView } from './engine/apply'
import type { ConversationView, GrantApproval } from './engine/engine'
import { MessageBubble } from './MessageBubble'
import { MessageMenu } from './MessageMenu'
import type { ChatScreenEngine } from './screenEngine'

/** What the screen needs of the platform's file twin. */
export interface ConversationFiles extends ChatFileOps {
  PICK_SOURCES: PickSource[]
  pickFiles: (source: PickSource) => Promise<PickedFile[]>
}

export interface ConversationScreenProps {
  engine: ChatScreenEngine
  conversationId: string
  /** The signed-in person, who is never asked to approve their own reset. */
  userId: number
  /** The members and safety numbers, from the header's Members button. */
  onMembers: () => void
  /** The chat's title once it is known, for the header. */
  onTitle?: (title: string) => void
  /** The platform's attachments; `chatFiles` by default. */
  files?: ConversationFiles
  /** Swipe a message right to reply; on phones by default. */
  swipe?: boolean
}

/**
 * How tall the phone's keyboard stands, 0 when it is down (and always in a
 * browser, which has none of its own).
 */
export function useKeyboardHeight(): number {
  const [height, setHeight] = useState(0)
  useEffect(() => {
    const shown = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillShow' : 'keyboardDidShow',
      event => {
        setHeight(event.endCoordinates.height)
      }
    )
    const hidden = Keyboard.addListener(
      Platform.OS === 'ios' ? 'keyboardWillHide' : 'keyboardDidHide',
      () => {
        setHeight(0)
      }
    )
    return () => {
      shown.remove()
      hidden.remove()
    }
  }, [])
  return height
}

/** How often a chat not open yet is tried again, and how many times. */
export const OPEN_RETRY_MS = 2000
export const OPEN_TRIES = 8

/** A notice in the stream: a safety number change, or where history ends. */
type Notice =
  | { kind: 'lost'; key: string }
  | { kind: 'safety'; key: string; name: string | undefined }

/**
 * One chat. Messages in bubbles with who sent them and, on the person's
 * own, who has read them; a typing line; banners for locked history, a
 * chain break and an unverified membership record; a long-press menu
 * (reply, react, edit, delete, and Delete for everyone for moderators);
 * swipe-to-reply on phones; and the composer, which shows only where the
 * person may post and is held off while history is locked.
 */
export function ConversationScreen(
  props: ConversationScreenProps
): React.ReactElement {
  const { engine, conversationId, userId, onMembers, onTitle } = props
  const files = props.files ?? platformFiles
  const swipe = props.swipe ?? Platform.OS !== 'web'
  const theme = useTheme()
  const styles = getStyles(theme)
  const shared = getChatStyles(theme)
  const window = useWindowDimensions()
  const bubbleWidth = Math.min(window.width * 0.7, theme.rem(22))
  const insets = useInsets()
  const keyboard = useKeyboardHeight()
  // The keyboard rises over the capsule's clearance under the column; the
  // composer is lifted by what is left of it, so it stays above the keys.
  const clearance =
    navClearanceAboveInset(
      Platform.OS,
      theme.rem(NAV_CLEARANCE_REM),
      theme.rem(FLOATING_BOTTOM_REM)
    ) + insets.bottom
  const lift = Math.max(0, keyboard - clearance)

  const [view, setView] = useState<ConversationView | undefined>(undefined)
  const [failed, setFailed] = useState(false)
  const [text, setText] = useState('')
  const [replyTo, setReplyTo] = useState<MessageView | undefined>(undefined)
  const [editing, setEditing] = useState<MessageView | undefined>(undefined)
  const [picked, setPicked] = useState<PickedFile[]>([])
  const [sending, setSending] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [reported, setReported] = useState(false)
  const [menu, setMenu] = useState<MessageView | undefined>(undefined)
  const [reacting, setReacting] = useState<MessageView | undefined>(undefined)
  const [approvals, setApprovals] = useState<GrantApproval[]>([])
  const scroller = useRef<React.ComponentRef<typeof ScrollView>>(null)
  // Where the list is, to keep it on the newest message while the person
  // is there: a list read at its bottom follows what arrives, one scrolled
  // up to older messages stays put.
  const scrolled = useRef({ offset: 0, height: 0, content: 0 })
  const atBottom = useRef(true)

  // Open the chat, and keep its view current from the engine's events. A
  // chat the list does not hold yet (a newcomer, a moment before the server
  // has added them) is opened again as soon as the list brings it, and
  // every few seconds until then.
  useEffect(() => {
    let live = true
    let opened = false
    let opening = false
    let tries = 0
    setView(undefined)
    setFailed(false)
    const waiting = (): GrantApproval[] =>
      approvalsIn(engine.approvals(), conversationId, userId)
    setApprovals(waiting())
    // Until it is open, the chat as the list last described it: its title,
    // and whether this device holds its key (History is locked) or not.
    const listed = (): void => {
      const known = engine.view(conversationId)
      if (known != null && live) setView(known)
    }
    const tryOpen = (): void => {
      if (opened || opening || !live) return
      listed()
      opening = true
      tries += 1
      engine
        .open(conversationId)
        .then(next => {
          opened = true
          if (live) {
            setView(next)
            setFailed(false)
          }
        })
        .catch(() => {
          if (live && tries >= OPEN_TRIES) setFailed(true)
        })
        .finally(() => {
          opening = false
        })
    }
    const unsubscribe = engine.subscribe(event => {
      if (!live) return
      if (event.type === 'approvals') setApprovals(waiting())
      if (
        (event.type === 'conversation' &&
          event.conversationId === conversationId) ||
        event.type === 'conversations'
      ) {
        if (!opened) {
          tryOpen()
          return
        }
        const next = engine.view(conversationId)
        if (next != null) setView(next)
      }
    })
    tryOpen()
    const timer = setInterval(tryOpen, OPEN_RETRY_MS)
    return () => {
      live = false
      clearInterval(timer)
      unsubscribe()
      engine.close(conversationId)
    }
  }, [engine, conversationId, userId])

  const title = view?.conversation.title
  useEffect(() => {
    if (title != null && title !== '') onTitle?.(title)
  }, [onTitle, title])

  // What is on the screen has been read.
  const newest = view?.messages.at(-1)?.seq ?? 0
  const unread = view?.conversation.unread ?? 0
  useEffect(() => {
    if (newest === 0 && unread === 0) return
    engine.markRead(conversationId).catch(() => undefined)
  }, [engine, conversationId, newest, unread])

  const run = useCallback(
    (work: () => Promise<unknown>, failure = lstrings.chat_send_failed) => {
      setError(undefined)
      setReported(false)
      work().catch(() => {
        setError(failure)
      })
    },
    []
  )

  if (failed && view == null) {
    return (
      <Screen>
        <Text style={shared.error}>{lstrings.chat_cannot_load}</Text>
      </Screen>
    )
  }
  if (view == null) {
    return (
      <Screen>
        <Text style={shared.muted}>{lstrings.common_loading}</Text>
      </Screen>
    )
  }

  const send = (): void => {
    const body = text.trim()
    const tooLarge = picked.find(
      file => file.bytes.length > MAX_ATTACHMENT_SIZE
    )
    if (tooLarge != null) {
      setError(sprintf(lstrings.chat_too_large, tooLarge.fileName))
      return
    }
    setSending(true)
    setError(undefined)
    const work = async (): Promise<unknown> => {
      if (editing != null) {
        await engine.edit(conversationId, editing.id, body)
        return
      }
      const quote = replyTo == null ? {} : { quoteId: replyTo.id }
      if (picked.length > 0) {
        return await engine.attach(conversationId, picked, body, quote)
      }
      return await engine.sendText(conversationId, body, quote)
    }
    work()
      .then(() => {
        setText('')
        setReplyTo(undefined)
        setEditing(undefined)
        setPicked([])
        atBottom.current = true
      })
      .catch(() => {
        setError(lstrings.chat_send_failed)
      })
      .finally(() => {
        setSending(false)
      })
  }

  const onText = (next: string): void => {
    setText(next)
    if (next !== '' && view.composer === 'enabled') {
      engine.typing(conversationId)
    }
  }

  const react = (message: MessageView, emoji: string, remove = false): void => {
    run(async () => {
      await engine.react(conversationId, message.id, emoji, remove)
    })
  }

  const nameOf = (message: MessageView): string =>
    message.mine
      ? lstrings.chat_you
      : (message.senderName ?? lstrings.chat_former_member)

  // Where a notice falls among the messages: a safety number change by its
  // time, and the end of what can be opened after the last lost message.
  const notices = new Map<number, Notice[]>()
  const addNotice = (index: number, notice: Notice): void => {
    notices.set(index, [...(notices.get(index) ?? []), notice])
  }
  if (view.earlierLost) {
    let lastLost = -1
    view.messages.forEach((message, index) => {
      if (message.status === 'lost') lastLost = index
    })
    addNotice(lastLost + 1, { kind: 'lost', key: 'lost' })
  }
  for (const change of view.safetyChanges) {
    let index = view.messages.findIndex(
      message => Date.parse(message.sentAt) > change.at
    )
    if (index === -1) index = view.messages.length
    addNotice(index, {
      kind: 'safety',
      key: `safety-${change.seq}`,
      name: change.name
    })
  }

  const renderNotice = (notice: Notice): React.ReactElement => (
    <View key={notice.key} style={styles.notice}>
      <Text style={styles.noticeText}>
        {notice.kind === 'lost'
          ? lstrings.chat_earlier_lost
          : sprintf(
              lstrings.chat_safety_changed,
              notice.name ?? lstrings.chat_former_member
            )}
      </Text>
    </View>
  )

  const typing = typingNames(view.typing, lstrings.chat_someone)

  return (
    <Screen scroll={false} contentStyle={styles.column}>
      <View style={[styles.fill, { paddingBottom: lift }]}>
        <View style={styles.top}>
          <Text style={styles.count}>
            {plural(
              view.conversation.memberCount,
              lstrings.chat_members_count_one,
              lstrings.chat_members_count_many
            )}
          </Text>
          <Button
            label={lstrings.chat_members}
            kind="text"
            compact
            icon="group"
            onPress={onMembers}
          />
        </View>
        {view.historyLocked && (
          <View style={[shared.banner, shared.bannerWarning]}>
            <Icon name="lock" color={theme.warningColor} />
            <Text style={shared.bannerText}>
              {lstrings.chat_history_locked}
            </Text>
          </View>
        )}
        {approvals.map(approval => (
          <View key={approval.requestId} style={shared.banner}>
            <Text style={shared.bannerText}>
              {sprintf(
                lstrings.chat_approval_request,
                approval.name ?? lstrings.chat_former_member
              )}
            </Text>
            <Button
              label={lstrings.chat_review}
              kind="secondary"
              compact
              onPress={onMembers}
            />
          </View>
        ))}
        {view.unverified && (
          <View style={[shared.banner, shared.bannerWarning]}>
            <Text style={shared.bannerText}>{lstrings.chat_unverified}</Text>
          </View>
        )}
        <ScrollView
          ref={scroller}
          style={styles.fill}
          contentContainerStyle={styles.messages}
          keyboardShouldPersistTaps="handled"
          onScroll={event => {
            const { contentOffset, layoutMeasurement } = event.nativeEvent
            scrolled.current.offset = contentOffset.y
            scrolled.current.height = layoutMeasurement.height
          }}
          onLayout={event => {
            scrolled.current.height = event.nativeEvent.layout.height
          }}
          scrollEventThrottle={100}
          onContentSizeChange={(_width, height) => {
            const { offset, content } = scrolled.current
            // At the bottom of what was there before it grew (or asked to
            // go there by a send): follow it down.
            const following =
              atBottom.current ||
              content === 0 ||
              offset + scrolled.current.height >= content - 48
            scrolled.current.content = height
            atBottom.current = false
            if (following) scroller.current?.scrollToEnd({ animated: false })
          }}
        >
          {view.hasEarlier && (
            <Button
              label={lstrings.chat_load_earlier}
              kind="text"
              onPress={() => {
                atBottom.current = false
                run(async () => {
                  await engine.loadEarlier(conversationId)
                })
              }}
            />
          )}
          {view.messages.length === 0 && !view.earlierLost && (
            <Text style={[shared.muted, styles.empty]}>
              {lstrings.chat_no_messages}
            </Text>
          )}
          {view.messages.map((message, index) => (
            <React.Fragment key={message.id}>
              {notices.get(index)?.map(renderNotice)}
              <MessageBubble
                message={message}
                conversation={view.conversation}
                members={view.members}
                engine={engine}
                files={files}
                maxWidth={bubbleWidth}
                swipe={swipe && view.composer === 'enabled'}
                onLongPress={pressed => {
                  if (actionsFor(pressed, view).length > 0) setMenu(pressed)
                }}
                onReply={pressed => {
                  setEditing(undefined)
                  setReplyTo(pressed)
                }}
                onToggleReaction={(pressed, emoji, mine) => {
                  if (view.composer === 'closed') return
                  react(pressed, emoji, mine)
                }}
              />
            </React.Fragment>
          ))}
          {notices.get(view.messages.length)?.map(renderNotice)}
        </ScrollView>
        {typing.length > 0 && (
          <Text style={shared.small} accessibilityLiveRegion="polite">
            {typing.length === 1
              ? sprintf(lstrings.chat_typing_one, typing[0])
              : sprintf(lstrings.chat_typing_many, typing.join(', '))}
          </Text>
        )}
        {error != null && <Text style={shared.error}>{error}</Text>}
        {reported && (
          <Text style={shared.muted} accessibilityLiveRegion="polite">
            {lstrings.chat_reported}
          </Text>
        )}
        {view.composer === 'closed' ? (
          <View style={shared.banner}>
            <Text style={shared.bannerText}>{lstrings.chat_closed_notice}</Text>
          </View>
        ) : view.composer === 'readOnly' ? (
          <View style={shared.banner}>
            <Text style={shared.bannerText}>{lstrings.chat_read_only}</Text>
          </View>
        ) : (
          <Composer
            text={text}
            onText={onText}
            enabled={view.composer === 'enabled'}
            sending={sending}
            context={
              editing != null
                ? { kind: 'edit' }
                : replyTo != null
                  ? {
                      kind: 'reply',
                      name: nameOf(replyTo),
                      snippet: replyTo.body
                    }
                  : undefined
            }
            onCancelContext={() => {
              if (editing != null) setText('')
              setEditing(undefined)
              setReplyTo(undefined)
            }}
            attachments={picked}
            onRemoveAttachment={index => {
              setPicked(current => current.filter((_, at) => at !== index))
            }}
            sources={editing == null ? files.PICK_SOURCES : []}
            onAttach={source => {
              run(async () => {
                const chosen = await files.pickFiles(source)
                if (chosen.length > 0) {
                  setPicked(current => [...current, ...chosen])
                }
              }, lstrings.chat_attachment_failed)
            }}
            onSend={send}
          />
        )}
      </View>
      {menu != null && (
        <MessageMenu
          message={menu}
          actions={actionsFor(menu, view)}
          onClose={() => {
            setMenu(undefined)
          }}
          onReply={() => {
            setEditing(undefined)
            setReplyTo(menu)
            setMenu(undefined)
          }}
          onReact={emoji => {
            const already = menu.reactions.find(
              reaction => reaction.emoji === emoji
            )?.mine
            react(menu, emoji, already === true)
            setMenu(undefined)
          }}
          onMoreEmoji={() => {
            setReacting(menu)
            setMenu(undefined)
          }}
          onEdit={() => {
            setReplyTo(undefined)
            setEditing(menu)
            setPicked([])
            setText(menu.body)
            setMenu(undefined)
          }}
          onDelete={() => {
            const target = menu
            setMenu(undefined)
            run(async () => {
              await engine.deleteMessage(conversationId, target.id)
            })
          }}
          onDeleteForEveryone={() => {
            const target = menu
            setMenu(undefined)
            run(async () => {
              await engine.moderatorDelete(conversationId, target.id)
            })
          }}
          onReport={() => {
            const target = menu
            setMenu(undefined)
            run(async () => {
              await engine.report(conversationId, target.id)
              setReported(true)
            }, lstrings.chat_report_failed)
          }}
        />
      )}
      {reacting != null && (
        <View style={styles.reactPicker}>
          <EmojiPicker
            onPick={emoji => {
              react(reacting, emoji)
              setReacting(undefined)
            }}
            onClose={() => {
              setReacting(undefined)
            }}
          />
        </View>
      )}
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  // The screen's own column, grown to the window; its bottom padding is
  // what keeps the composer clear of the floating capsule on a phone.
  column: {
    flex: 1,
    // Centred in a wide window, as every other chat screen is.
    alignSelf: 'center',
    gap: theme.rem(theme.spaceSmRem)
  },
  fill: {
    flex: 1,
    gap: theme.rem(theme.spaceSmRem)
  },
  top: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between'
  },
  count: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor
  },
  messages: {
    gap: theme.rem(theme.spaceSmRem),
    paddingVertical: theme.rem(theme.spaceSmRem)
  },
  empty: {
    textAlign: 'center',
    paddingVertical: theme.rem(theme.spaceLgRem)
  },
  notice: {
    alignSelf: 'center',
    borderRadius: theme.rem(1),
    backgroundColor: theme.containerBackgroundColor,
    paddingHorizontal: theme.rem(0.75),
    paddingVertical: theme.rem(0.25)
  },
  noticeText: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.8125),
    color: theme.secondaryTextColor,
    textAlign: 'center'
  },
  reactPicker: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0
  }
}))
