import React, { useCallback, useEffect, useState } from 'react'
import { View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { type UmpireLevel, umpireLevelHint } from '../../common/umpires'
import { Button, ListCard, ListRow, Screen, TextField } from '../components'
import { ChoiceSheet } from '../components/ChoiceSheet'
import {
  UmpireError,
  UmpireHeading,
  useUmpireStyles,
  useUmpireWork
} from './shared'
export function UmpireLevelsScreen({
  client,
  league
}: {
  client: TeamStationClient
  league: string
}): React.ReactElement {
  const s = useUmpireStyles()
  const { error, busy, run, live } = useUmpireWork(league)
  const [levels, setLevels] = useState<UmpireLevel[]>([])
  const [name, setName] = useState('')
  const [removing, setRemoving] = useState<UmpireLevel>()
  const refresh = useCallback(async (): Promise<void> => {
    const next = await client.umpireLevels(league)
    if (live()) setLevels(next)
  }, [client, league, live])
  useEffect(() => {
    run(refresh)
  }, [refresh, run])
  return (
    <Screen>
      <View style={s.page}>
        <UmpireHeading>Create Umpire Levels</UmpireHeading>
        <ListCard>
          {levels.map(level => (
            <ListRow
              key={level.id}
              title={level.name}
              end={
                <Button
                  label="Remove"
                  accessibilityLabel={`Remove ${level.name}`}
                  kind="text"
                  disabled={busy}
                  onPress={() => {
                    if (level.inUse) setRemoving(level)
                    else
                      run(async () => {
                        await client.removeUmpireLevel(league, level.id)
                        await refresh()
                      })
                  }}
                />
              }
            />
          ))}
        </ListCard>
        <TextField
          label="Level name"
          value={name}
          onChangeText={setName}
          placeholder={umpireLevelHint(levels.map(l => l.name))}
          disabled={busy}
        />
        <Button
          label="Add level"
          disabled={busy || name.trim() === ''}
          onPress={() => {
            run(async () => {
              await client.addUmpireLevel(league, name)
              if (live()) setName('')
              await refresh()
            })
          }}
        />
        <UmpireError error={error} />
        {removing != null && (
          <ChoiceSheet
            title="Removing this level clears it from seasons, people, certification columns, and games that use it."
            onClose={() => {
              setRemoving(undefined)
            }}
            choices={[
              {
                label: 'Remove level',
                destructive: true,
                onPress: () => {
                  run(async () => {
                    await client.removeUmpireLevel(league, removing.id)
                    await refresh()
                  })
                }
              }
            ]}
          />
        )}
      </View>
    </Screen>
  )
}
