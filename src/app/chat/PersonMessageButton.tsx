import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type {
  ChatConversation,
  MessageReach,
  TeamStationClient
} from '../../common/api'
import { PillButton } from '../components/PillTabs'
import { useSceneShown } from '../components/sceneShown'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { lstrings, sprintf } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { useChatAge, useChatAgeAsk } from './ChatAgeGate'
import { reasonOf } from './engine/links'
import { GuardianPickerModal } from './GuardianPickerModal'
import { IncludeAdultSheet } from './IncludeAdultSheet'

export interface PersonMessageButtonProps {
  client: TeamStationClient
  userId: string
  /** The person's name, for the button's label and the picker. */
  name: string
  /**
   * How the viewer can message them, when the caller already knows (a people
   * list's `message`); read from the server when left out.
   */
  reach?: MessageReach | null
  onOpenChat: (chat: { id: string; title: string }) => void | Promise<void>
}

/**
 * The Message pill: the top tab bar's `PillButton`, at its size. A person the
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
  const given = props.reach !== undefined
  useEffect(() => {
    const current = reading()
    writing()
    pending.current = false
    setRead(undefined)
    setPlayers(undefined)
    setPicking(false)
    setFailed(false)
    setBusy(false)
    if (given) return
    client
      .dmReach(userId)
      .then(found => {
        if (current()) setRead(found)
      })
      .catch(() => undefined)
  }, [client, userId, given, reading, writing])
  // A sheet asked for by this button goes with it.
  useEffect(
    () => () => {
      asking.current?.()
    },
    []
  )
  const reach = given ? props.reach : read

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
      <PillButton
        testID="person-message"
        label={lstrings.chat_message}
        accessibilityLabel={sprintf(lstrings.chat_message_named, name)}
        size="regular"
        selected={false}
        disabled={busy || waiting != null}
        onPress={() => {
          if (reach === 'proxies') setPicking(true)
          else press(userId)
        }}
      />
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

/**
 * A people list's Message pill for each row the reader can message (its
 * `message`), opening the DM, or the picker, through `onOpenChat`.
 */
export function personMessageAction(
  client: TeamStationClient,
  onOpenChat: PersonMessageButtonProps['onOpenChat']
): (person: {
  userId: string
  shortName: string
  message?: MessageReach
}) => React.ReactNode {
  return person =>
    person.message == null ? null : (
      <PersonMessageButton
        key={person.userId}
        client={client}
        userId={person.userId}
        name={person.shortName}
        reach={person.message}
        onOpenChat={onOpenChat}
      />
    )
}
