import React, { useEffect, useRef, useState } from 'react'
import { Text, View } from 'react-native'

import type { ChatConversation, TeamStationClient } from '../../common/api'
import { Button } from '../components'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
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
  const theme = useTheme()
  const [recipient, setRecipient] = useState<string>()
  const [busy, setBusy] = useState(false)
  const [failed, setFailed] = useState(false)
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

  if (recipient == null) return null
  return (
    <View style={{ alignItems: 'flex-end', gap: theme.rem(theme.spaceSmRem) }}>
      <Button
        label="Message"
        icon="chat"
        kind="secondary"
        busy={busy}
        disabled={busy}
        testID="person-message"
        onPress={() => {
          start().catch(() => undefined)
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
