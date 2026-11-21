import React, { useEffect, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type {
  ChatConversation,
  MessageReach,
  TeamStationClient
} from '../../common/api'
import { ButtonIcon } from '../components/ButtonIcon'
import { useSceneShown } from '../components/sceneShown'
import { useBreakpoint } from '../components/useBreakpoint'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { lstrings, sprintf } from '../locales/strings'
import { pillPadding, pillShadow } from '../theme/pill'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import { useChatAge, useChatAgeAsk } from './ChatAgeGate'
import { reasonOf } from './engine/links'
import { GuardianPickerModal } from './GuardianPickerModal'
import { IncludeAdultSheet } from './IncludeAdultSheet'

export interface PersonMessageButtonProps {
  client: TeamStationClient
  userId: string
  /** The person's name, for the button's label and the picker. */
  name: string
  onOpenChat: (chat: { id: string; title: string }) => void | Promise<void>
}

/**
 * The Message pill: a chat icon and "Message" at the size of a people row's
 * role badge (`Badge`, e.g. "League admin"), raised so it reads as a button,
 * with a 44-point target; on a phone, the icon alone. A person the
 * viewer may message gets a DM with them; a player who cannot sign in opens
 * the picker of whom to message for them instead. Who that is comes from the
 * DM rules alone, never profile visibility.
 */
export function PersonMessageButton(
  props: PersonMessageButtonProps
): React.ReactElement | null {
  const { client, userId, name } = props
  const { access } = useChatAge()
  const askAge = useChatAgeAsk()
  const asking = useRef<(() => void) | undefined>(undefined)
  const theme = useTheme()
  const styles = getStyles(theme)
  const iconOnly = useBreakpoint() === 'phone'
  const [read, setRead] = useState<MessageReach | null>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  /** A press made while the age answer was pending: who it was for. */
  const [waiting, setWaiting] = useState<string>()
  const [players, setPlayers] = useState<string[]>()
  /** Whom the include-an-adult sheet starts the DM with. */
  const [recipient, setRecipient] = useState<string>()
  const [picking, setPicking] = useState(false)
  const reading = useLatestRequest()
  const writing = useLatestRequest()
  const pending = useRef(false)
  const opened = useRef(props.onOpenChat)
  opened.current = props.onOpenChat
  useEffect(() => {
    const current = reading()
    writing()
    pending.current = false
    setRead(undefined)
    setPlayers(undefined)
    setPicking(false)
    setFailed(false)
    setBusy(false)
    client
      .dmReach(userId)
      .then(found => {
        if (current()) setRead(found)
      })
      .catch(() => undefined)
  }, [client, userId, reading, writing])
  // A sheet asked for by this button goes with it.
  useEffect(
    () => () => {
      asking.current?.()
    },
    []
  )
  const reach = read

  const start = async (
    target: string,
    adults: string[] = []
  ): Promise<void> => {
    if (pending.current) return
    pending.current = true
    const current = writing()
    setBusy(true)
    setFailed(false)
    setRecipient(target)
    try {
      const chat: ChatConversation = await client.createDm([target, ...adults])
      if (!current()) return
      setPlayers(undefined)
      await opened.current({ id: chat.id, title: chat.title ?? '' })
    } catch (error) {
      if (!current()) return
      setPlayers(undefined)
      if (reasonOf(error) === 'adultRequired') {
        const ids = (error as { details?: { playerIds?: unknown } }).details
          ?.playerIds
        if (
          Array.isArray(ids) &&
          ids.every(id => typeof id === 'string') &&
          ids.length > 0
        )
          setPlayers(ids)
        else setFailed(true)
      } else setFailed(true)
    } finally {
      if (current()) {
        pending.current = false
        setBusy(false)
      }
    }
  }

  /** The DM with `target`, or, until chat is unlocked, the age sheet first. */
  const message = (target: string): void => {
    if (access === 'allowed') {
      start(target).catch(() => undefined)
      return
    }
    // No DM is made until the age sheet is agreed to.
    asking.current?.()
    asking.current = askAge({
      onDecline: () => {
        asking.current = undefined
      },
      onAgreed: () => {
        asking.current = undefined
        start(target).catch(() => undefined)
      }
    })
  }
  /** Before the age answer is in, the press waits for it (below). */
  const press = (target: string): void => {
    if (access === 'pending') setWaiting(target)
    else message(target)
  }
  const latestMessage = useRef(message)
  latestMessage.current = message
  // A held press is for the screen on show: covered or left, it is dropped.
  const shown = useSceneShown()
  useEffect(() => {
    if (!shown) setWaiting(undefined)
  }, [shown])
  useEffect(() => {
    if (waiting == null || !shown || access === 'pending') return
    setWaiting(undefined)
    latestMessage.current(waiting)
  }, [access, waiting, shown])

  if (reach == null) return null
  return (
    <View
      style={{
        alignItems: 'flex-end',
        maxWidth: theme.rem(16),
        gap: theme.rem(theme.spaceSmRem)
      }}
    >
      <Pressable
        testID="person-message"
        accessibilityRole="button"
        accessibilityLabel={
          name === ''
            ? lstrings.chat_message
            : sprintf(lstrings.chat_message_named, name)
        }
        accessibilityState={{ disabled: busy || waiting != null }}
        disabled={busy || waiting != null}
        hitSlop={
          iconOnly
            ? { top: 10, bottom: 10, left: 10, right: 10 }
            : { top: 10, bottom: 10, left: 4, right: 4 }
        }
        onPress={() => {
          if (reach === 'proxies') setPicking(true)
          else press(userId)
        }}
        style={({ pressed }) => [
          styles.pill,
          pressed && styles.pressed,
          iconOnly && styles.iconOnly,
          (busy || waiting != null) && styles.disabled
        ]}
      >
        <ButtonIcon
          name="chat"
          size={0.875}
          color={theme.neutralBadgeTextColor}
        />
        {!iconOnly && (
          <Text selectable={false} numberOfLines={1} style={styles.label}>
            {lstrings.chat_message}
          </Text>
        )}
      </Pressable>
      {failed && (
        <Text
          accessibilityRole="alert"
          style={{ color: theme.dangerColor, textAlign: 'right' }}
        >
          {lstrings.chat_new_failed}
        </Text>
      )}
      {picking && (
        <GuardianPickerModal
          client={client}
          userId={userId}
          name={name}
          onChoose={target => {
            setPicking(false)
            press(target)
          }}
          onClose={() => {
            setPicking(false)
          }}
        />
      )}
      {players != null && recipient != null && (
        <IncludeAdultSheet
          client={client}
          playerIds={players}
          busy={busy}
          onSubmit={adults => {
            start(recipient, adults).catch(() => undefined)
          }}
          onClose={() => {
            if (!pending.current) setPlayers(undefined)
          }}
        />
      )}
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
  // The role badge's shell and label (`Badge`), on the same neutral colours.
  pill: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.rem(0.25),
    height: theme.rem(1.5),
    minHeight: theme.rem(1.5),
    paddingHorizontal: pillPadding(theme.rem(1.5)),
    borderRadius: theme.radiusPill,
    backgroundColor: theme.neutralBadgeBackground,
    ...pillShadow(theme)
  },
  label: {
    fontFamily: theme.semiBoldTextFont,
    fontSize: theme.rem(0.8125),
    fontWeight: '600',
    color: theme.neutralBadgeTextColor
  },
  // A circle around the icon, the badge's height across.
  iconOnly: {
    width: theme.rem(1.5),
    paddingHorizontal: 0,
    justifyContent: 'center'
  },
  pressed: { opacity: 0.85 },
  disabled: { opacity: 0.5 }
}))
