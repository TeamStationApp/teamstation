import React, { useEffect, useRef, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  Text,
  type TextInput,
  View
} from 'react-native'

import type {
  ChatConversation,
  ChatPerson,
  TeamStationClient
} from '../../common/api'
import { asUserId } from '../../common/userId'
import {
  Button,
  Card,
  Icon,
  initialsOf,
  Screen,
  TextField
} from '../components'
import { Emblem } from '../components/Emblem'
import { lstrings, sprintf } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import { DM_MAX_MEMBERS } from './chatModel'
import { getChatStyles } from './chatStyles'
import { reasonOf } from './engine/links'
import { IncludeAdultSheet } from './IncludeAdultSheet'
import type { ChatScreenEngine } from './screenEngine'

/** How long typing pauses before the candidates are asked again. */
export const CANDIDATE_PAUSE_MS = 500

export interface NewDmScreenProps {
  client: Pick<
    TeamStationClient,
    'dmCandidates' | 'createDm' | 'includedAdults'
  >
  engine: Pick<ChatScreenEngine, 'refresh'>
  /** The conversation, started (or the open one-to-one, reused). */
  onCreated: (conversation: ChatConversation) => void
  pauseMs?: number
}

/**
 * Starting a direct message: the people this person may name (exactly the
 * server's `dm-candidates`), searched by name, picked one or several. When
 * the league's SafeSport rule asks for another adult, the server answers
 * `adultRequired` and `IncludeAdultSheet` opens on the players it named.
 */
export function NewDmScreen(props: NewDmScreenProps): React.ReactElement {
  const { client, engine, onCreated } = props
  const pauseMs = props.pauseMs ?? CANDIDATE_PAUSE_MS
  const theme = useTheme()
  const shared = getChatStyles(theme)
  const [query, setQuery] = useState('')
  const input = useRef<React.ComponentRef<typeof TextInput>>(null)
  const generation = useRef(0)
  const [people, setPeople] = useState<ChatPerson[] | undefined>(undefined)
  const [lookupFailed, setLookupFailed] = useState(false)
  const [picked, setPicked] = useState<ChatPerson[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | undefined>(undefined)
  const [adultsFor, setAdultsFor] = useState<string[] | undefined>(undefined)

  const changeQuery = (value: string): void => {
    generation.current += 1
    setQuery(value)
    setPeople(undefined)
    setLookupFailed(false)
    setError(undefined)
  }
  useEffect(() => {
    let live = true
    const version = generation.current
    const asked = query.trim()
    setPeople(undefined)
    setLookupFailed(false)
    const timer = setTimeout(
      () => {
        client
          .dmCandidates(asked)
          .then(found => {
            if (live && version === generation.current) setPeople(found)
          })
          .catch(() => {
            if (live && version === generation.current) {
              setLookupFailed(true)
              setError(lstrings.chat_new_search_failed)
            }
          })
      },
      asked === '' ? 0 : pauseMs
    )
    return () => {
      live = false
      clearTimeout(timer)
    }
  }, [query, client, pauseMs])

  const isPicked = (person: ChatPerson): boolean =>
    picked.some(entry => entry.userId === person.userId)
  const toggle = (person: ChatPerson): void => {
    setError(undefined)
    if (isPicked(person)) {
      setPicked(current =>
        current.filter(entry => entry.userId !== person.userId)
      )
      return
    }
    // The person starting it is one of the twenty.
    if (picked.length + 1 >= DM_MAX_MEMBERS) {
      setError(lstrings.chat_new_too_many)
      return
    }
    setPicked(current => [...current, person])
    if (query !== '') changeQuery('')
    input.current?.focus()
  }

  const start = (extra: string[] = []): void => {
    setBusy(true)
    setError(undefined)
    client
      .createDm([...picked.map(person => person.userId), ...extra])
      .then(async conversation => {
        setAdultsFor(undefined)
        await engine.refresh().catch(() => undefined)
        onCreated(conversation)
      })
      .catch((caught: unknown) => {
        const reason = reasonOf(caught)
        if (reason === 'adultRequired') {
          const details = (caught as { details?: { playerIds?: unknown } })
            .details
          const ids = Array.isArray(details?.playerIds)
            ? details.playerIds.map(asUserId)
            : picked.map(person => person.userId)
          setAdultsFor(ids)
          return
        }
        setAdultsFor(undefined)
        setError(
          reason === 'notCandidate'
            ? sprintf(
                lstrings.chat_new_not_allowed,
                picked.map(person => person.shortName).join(', ')
              )
            : lstrings.chat_new_failed
        )
      })
      .finally(() => {
        setBusy(false)
      })
  }

  return (
    <Screen>
      <TextField
        label={lstrings.chat_new_search}
        value={query}
        inputRef={input}
        onChangeText={value => {
          if (value !== query) changeQuery(value)
        }}
      />
      {picked.length > 0 && (
        <View style={shared.actions}>
          {picked.map(person => (
            <Button
              key={person.userId}
              label={person.shortName}
              accessibilityLabel={sprintf(
                lstrings.chat_new_unpick,
                person.shortName
              )}
              kind="secondary"
              compact
              onPress={() => {
                toggle(person)
              }}
            />
          ))}
        </View>
      )}
      {error != null && <Text style={shared.error}>{error}</Text>}
      <Button
        label={lstrings.chat_new_start}
        kind="primary"
        busy={busy && adultsFor == null}
        disabled={picked.length === 0 || busy}
        onPress={() => {
          start()
        }}
      />
      {lookupFailed ? null : people == null ? (
        <ActivityIndicator accessibilityLabel={lstrings.common_loading} />
      ) : people.length === 0 ? (
        <Text style={shared.muted}>{lstrings.chat_new_none}</Text>
      ) : (
        <Card flush>
          {people.map((person, index) => (
            <View key={person.userId}>
              {index > 0 && <View style={shared.divider} />}
              <Pressable
                accessibilityRole="button"
                accessibilityLabel={sprintf(
                  isPicked(person)
                    ? lstrings.chat_new_unpick
                    : lstrings.chat_new_pick,
                  person.shortName
                )}
                accessibilityState={{ selected: isPicked(person) }}
                onPress={() => {
                  toggle(person)
                }}
                style={[
                  shared.row,
                  {
                    paddingHorizontal: theme.rem(theme.spaceMdRem),
                    paddingVertical: theme.rem(theme.spaceSmRem)
                  }
                ]}
              >
                <Emblem
                  uri={person.avatarUrl}
                  fallback={initialsOf(person.shortName)}
                  shape="circle"
                />
                <Text style={[shared.name, { flex: 1 }]}>
                  {person.shortName}
                </Text>
                {isPicked(person) && (
                  <Icon name="star" color={theme.activeColor} />
                )}
              </Pressable>
            </View>
          ))}
        </Card>
      )}
      {adultsFor != null && (
        <IncludeAdultSheet
          client={client}
          playerIds={adultsFor}
          busy={busy}
          onSubmit={adults => {
            start(adults)
          }}
          onClose={() => {
            setAdultsFor(undefined)
          }}
        />
      )}
    </Screen>
  )
}
