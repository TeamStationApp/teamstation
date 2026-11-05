import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { ChatConversation, TeamStationClient } from '../../common/api'
import { Button } from '../components'
import { useSceneShown } from '../components/sceneShown'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { useChatAge, useChatAgeAsk } from './ChatAgeGate'
import { reasonOf } from './engine/links'
import { IncludeAdultSheet } from './IncludeAdultSheet'

export interface PersonMessageButtonProps {
  client: TeamStationClient
  userId: string
  onOpenChat: (chat: { id: string; title: string }) => void | Promise<void>
}

/** Eligibility comes from the same rules as New message, never profile visibility. */
export function PersonMessageButton(
  props: PersonMessageButtonProps
): React.ReactElement | null {
  const { client, userId } = props
  const { access } = useChatAge()
  const askAge = useChatAgeAsk()
  const asking = useRef<(() => void) | undefined>(undefined)
  const theme = useTheme()
  const [recipient, setRecipient] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
  /** A press made while the age answer was pending, acted on once it is in. */
  const [waiting, setWaiting] = useState(false)
  const [players, setPlayers] = useState<string[]>()
  const reading = useLatestRequest()
  const writing = useLatestRequest()
  const pending = useRef(false)
  const opened = useRef(props.onOpenChat)
  opened.current = props.onOpenChat
  useEffect(() => {
    const current = reading()
    writing()
    pending.current = false
    setRecipient(undefined)
    setPlayers(undefined)
    setFailed(false)
    setBusy(false)
    client
      .dmCandidates('', userId)
      .then(found => {
        if (current())
          setRecipient(found.find(person => person.userId === userId)?.userId)
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

  const start = async (adults: string[] = []): Promise<void> => {
    if (pending.current || recipient == null) return
    pending.current = true
    const current = writing()
    setBusy(true)
    setFailed(false)
    try {
      const chat: ChatConversation = await client.createDm([
        recipient,
        ...adults
      ])
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

  /** The DM, or, until chat is unlocked, the age sheet first. */
  const press = (): void => {
    if (access === 'allowed') {
      start().catch(() => undefined)
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
        start().catch(() => undefined)
      }
    })
  }
  const latestPress = useRef(press)
  latestPress.current = press
  // A held press is for the screen on show: covered or left, it is dropped.
  const shown = useSceneShown()
  useEffect(() => {
    if (!shown) setWaiting(false)
  }, [shown])
  useEffect(() => {
    if (!waiting || !shown || access === 'pending') return
    setWaiting(false)
    latestPress.current()
  }, [access, waiting, shown])

  if (recipient == null) return null
  return (
    <View style={{ alignItems: 'flex-end', gap: theme.rem(theme.spaceSmRem) }}>
      <Button
        label="Message"
        icon="chat"
        kind="secondary"
        busy={busy || waiting}
        disabled={busy || waiting}
        testID="person-message"
        onPress={() => {
          // Before the age answer is in, the press waits for it (below).
          if (access === 'pending') setWaiting(true)
          else press()
        }}
      />
      {failed && (
        <Text accessibilityRole="alert" style={{ color: theme.dangerColor }}>
          {lstrings.chat_new_failed}
        </Text>
      )}
      {players != null && (
        <IncludeAdultSheet
          client={client}
          playerIds={players}
          busy={busy}
          onSubmit={adults => {
            start(adults).catch(() => undefined)
          }}
          onClose={() => {
            if (!pending.current) setPlayers(undefined)
          }}
        />
      )}
    </View>
  )
}
