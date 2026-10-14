import React, { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import { Button } from '../components'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { ChatAnchoredMenu } from './ChatAnchoredMenu'
import type { MessageSource } from './chatMessageSource'
import { type MessageAction, QUICK_REACTIONS } from './chatModel'
import { focusPopupControl } from './chatWebInteractions'
import type { MessageView } from './engine/apply'
import { MessageActionOverlay } from './MessageActionOverlay'

export interface MessageMenuProps {
  message: MessageView
  actions: MessageAction[]
  desktop?: boolean
  anchor?: unknown
  selected?: React.ReactNode
  source?: MessageSource
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
  const live = useRef(true)
  const latest = useRef(props)
  latest.current = {
    ...props,
    onReply: props.onReply,
    onReact: props.onReact,
    onMoreEmoji: props.onMoreEmoji,
    onCopy: props.onCopy,
    onPin: props.onPin,
    onDelete: props.onDelete,
    onDeleteForEveryone: props.onDeleteForEveryone,
    onClose: props.onClose
  }
  const [closing, setClosing] = useState(false)
  const [focusHandoff, setFocusHandoff] = useState(false)
  const closingNow = useRef(false)
  const afterClose = useRef<(() => void) | undefined>(undefined)
  const permissionKey = `${props.message.id}:${props.message.status}:${props.actions.join('|')}`
  const initialPermissions = useRef(permissionKey)
  useEffect(() => {
    live.current = true
    return () => {
      live.current = false
    }
  }, [])
  useEffect(() => {
    if (permissionKey !== initialPermissions.current) latest.current.onClose()
  }, [permissionKey])
  const finish = (): void => {
    if (!live.current) return
    const after = afterClose.current
    afterClose.current = undefined
    latest.current.onClose()
    after?.()
  }
  const dismiss = (after?: () => void): void => {
    if (!live.current || closingNow.current) return
    closingNow.current = true
    afterClose.current = after
    if (latest.current.desktop === true) finish()
    else setClosing(true)
  }
  const has = (action: MessageAction): boolean => props.actions.includes(action)
  const invoke = (
    action: MessageAction,
    work: () => void,
    focus = false
  ): void => {
    if (closingNow.current || !latest.current.actions.includes(action)) return
    // Reply's focus and clipboard calls stay inside the trusted activation.
    if (focus) setFocusHandoff(true)
    work()
    dismiss()
  }
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
            invoke('react', () => {
              latest.current.onReact(emoji)
            })
          }}
          style={styles.reaction}
        >
          <Text style={styles.emoji}>{emoji}</Text>
        </Pressable>
      ))}
      <Pressable
        accessibilityRole="button"
        accessibilityLabel={lstrings.chat_more_emoji}
        onPress={() => {
          if (has('react'))
            dismiss(() => {
              latest.current.onMoreEmoji()
            })
        }}
        style={styles.reaction}
      >
        <Text style={styles.emoji}>＋</Text>
      </Pressable>
    </View>
  )
  const children = confirming ? (
    <DeleteConfirmation
      onClose={() => {
        dismiss()
      }}
      onDelete={() => {
        const action = has('delete') ? 'delete' : 'deleteForEveryone'
        invoke(action, () => {
          if (action === 'delete') latest.current.onDelete()
          else latest.current.onDeleteForEveryone?.()
        })
      }}
    />
  ) : (
    <>
      {props.desktop !== true && has('reply') && (
        <Button
          label={lstrings.chat_reply}
          kind="text"
          onPress={() => {
            invoke(
              'reply',
              () => {
                latest.current.onReply()
              },
              true
            )
          }}
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
            if (closingNow.current || !latest.current.actions.includes('copy'))
              return
            setError(false)
            setCopying(true)
            // Invoke before teardown: browser clipboard requires this user gesture.
            let work: Promise<void> | undefined
            try {
              work = latest.current.onCopy?.()
            } catch {
              work = undefined
            }
            if (work == null) {
              setCopying(false)
              setError(true)
              return
            }
            work
              .then(() => {
                dismiss()
              })
              .catch(() => {
                if (live.current && !closingNow.current) setError(true)
              })
              .finally(() => {
                if (live.current && !closingNow.current) setCopying(false)
              })
          }}
        />
      )}
      {(has('pin') || has('unpin')) && (
        <Button
          label={has('unpin') ? lstrings.chat_unpin : lstrings.chat_pin}
          kind="text"
          onPress={() => {
            invoke(has('unpin') ? 'unpin' : 'pin', () =>
              latest.current.onPin?.(!has('unpin'))
            )
          }}
        />
      )}
      {(has('delete') || has('deleteForEveryone')) && (
        <Button
          label={lstrings.chat_delete}
          kind="text"
          textColor={theme.dangerColor}
          onPress={() => {
            if (!closingNow.current) setConfirming(true)
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
      onClose={() => {
        dismiss()
      }}
    >
      {children}
    </ChatAnchoredMenu>
  ) : (
    <MessageActionOverlay
      label={label}
      source={props.source}
      mine={props.message.mine}
      closing={closing}
      focusHandoff={focusHandoff}
      onClose={() => {
        dismiss()
      }}
      onClosed={finish}
      reactions={!confirming && has('react') ? reactions : undefined}
      selected={
        <>
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
    </MessageActionOverlay>
  )
}
/** The confirmation mounts inside the portal, after its controls exist. */
function DeleteConfirmation(props: {
  onClose: () => void
  onDelete: () => void
}): React.ReactElement {
  const theme = useTheme()
  const styles = getStyles(theme)
  const cancel = useRef<React.ComponentRef<typeof View>>(null)
  useEffect(() => {
    focusPopupControl(cancel.current)
  }, [])
  return (
    <>
      <Text style={styles.detail}>{lstrings.chat_delete_confirm}</Text>
      <Button
        label={lstrings.chat_delete}
        kind="text"
        textColor={theme.dangerColor}
        onPress={props.onDelete}
      />
      <View ref={cancel}>
        <Button
          label={lstrings.chat_cancel}
          kind="text"
          onPress={props.onClose}
        />
      </View>
    </>
  )
}
const getStyles = cacheStyles((theme: Theme) => ({
  reactions: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    borderRadius: theme.rem(1.5),
    backgroundColor: theme.cardBackgroundColor,
    padding: theme.rem(0.25),
    minHeight: theme.rem(3)
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
