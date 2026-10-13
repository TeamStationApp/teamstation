import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Text } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { EventInfo } from '../../common/eventInfo'
import { Button, Screen } from '../components'
import { EventDetailsForm } from './EventDetailsForm'
import { GameFormScreen, type GameSettingsResult } from './GameFormScreen'

/** Both event kinds share the existing settings URL; games keep their consent flow. */
export function EventSettingsScreen({
  client,
  gameId,
  onSaved,
  onCancel
}: {
  client: TeamStationClient
  gameId: string
  onSaved: (result: GameSettingsResult) => void
  onCancel: () => void
}): React.ReactElement {
  const [kind, setKind] = useState<'game' | 'event'>()
  const [info, setInfo] = useState<EventInfo>()
  const [error, setError] = useState('')
  const [retry, setRetry] = useState(0)
  const visit = useRef<object | undefined>(undefined)
  const currentVisit = useMemo(() => ({ client, gameId }), [client, gameId])
  useEffect(() => {
    visit.current = currentVisit
    return () => {
      visit.current = undefined
    }
  }, [currentVisit])
  useEffect(() => {
    let active = true
    setKind(undefined)
    setInfo(undefined)
    setError('')
    const load = async (): Promise<void> => {
      const game = await client.game(gameId)
      const info =
        game.eventKind === 'event' ? await client.eventInfo(gameId) : undefined
      if (active) {
        setKind(game.eventKind ?? 'game')
        setInfo(info)
      }
    }
    load().catch((caught: unknown) => {
      if (active)
        setError(
          caught instanceof Error
            ? caught.message
            : 'Event settings could not load.'
        )
    })
    return () => {
      active = false
    }
  }, [client, gameId, retry])
  if (kind === 'game')
    return (
      <GameFormScreen
        client={client}
        mode={{ kind: 'edit', gameId }}
        onSaved={onSaved}
        onCancel={onCancel}
      />
    )
  return (
    <Screen>
      {info?.canManage === true ? (
        <EventDetailsForm
          key={info.id}
          client={client}
          info={info}
          onCancel={onCancel}
          onSaved={id => {
            if (visit.current === currentVisit)
              onSaved({ id, gameId: id, status: 'eventUpdated' })
          }}
        />
      ) : (
        <>
          <Text accessibilityRole={error === '' ? undefined : 'alert'}>
            {error !== ''
              ? error
              : kind == null
                ? 'Loading event settings…'
                : 'You need administrator access to change this event.'}
          </Text>
          {error !== '' && (
            <Button
              label="Retry event settings"
              onPress={() => {
                setRetry(value => value + 1)
              }}
            />
          )}
          <Button label="Back" kind="secondary" onPress={onCancel} />
        </>
      )}
    </Screen>
  )
}
