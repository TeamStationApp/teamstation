import React, { useCallback, useEffect, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { UmpireLevel } from '../../common/umpires'
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
  league,
  kind = 'levels'
}: {
  client: TeamStationClient
  league: string
  kind?: 'levels' | 'types' | 'notes'
}): React.ReactElement {
  const s = useUmpireStyles()
  const { error, busy, run, live } = useUmpireWork(`${league}:${kind}`)
  const [levels, setLevels] = useState<UmpireLevel[]>([])
  const [name, setName] = useState('')
  const [removing, setRemoving] = useState<UmpireLevel>()
  const notes = kind === 'notes'
  const type = kind === 'types'
  const noun = notes ? 'Notes Type' : type ? 'Type' : 'Level'
  const remove = async (id: string): Promise<void> => {
    if (notes) await client.removeUmpireNoteType(league, id)
    else if (type) await client.removeUmpireType(league, id)
    else await client.removeUmpireLevel(league, id)
  }
  const refresh = useCallback(async (): Promise<void> => {
    const next = notes
      ? await client.umpireNoteTypes(league)
      : type
        ? await client.umpireTypes(league)
        : await client.umpireLevels(league)
    if (live()) setLevels(next)
  }, [client, league, live, type, notes])
  useEffect(() => {
    run(refresh)
  }, [refresh, run])
  return (
    <Screen>
      <View style={s.page}>
        <UmpireHeading>
          {notes
            ? 'Create Per-Game Umpire Notes'
            : type
              ? 'Manage Umpire Types'
              : 'Manage Umpire Levels'}
        </UmpireHeading>
        <Text style={s.hint}>
          {notes
            ? 'Create a Notes Type That Can Be Added to Each Game To assist umpires'
            : type
              ? 'Create the umpire positions used by this league.'
              : 'Create levels of umpire certification. This allows umpires to be certified for different levels of play, which restricts which games they can sign up for.'}
        </Text>
        <TextField
          label={`${noun} name`}
          value={name}
          onChangeText={setName}
          placeholder={
            notes
              ? 'ie. Jersey Color, Venue Contact'
              : type
                ? 'ie. Plate, Field, 1st, 2nd, 3rd'
                : 'ie. Majors, Minors, AA, AAA'
          }
          autoCapitalize="words"
          disabled={busy}
        />
        <Button
          label={`Add ${noun}`}
          disabled={busy || name.trim() === ''}
          onPress={() => {
            run(async () => {
              if (notes) await client.addUmpireNoteType(league, name)
              else if (type) await client.addUmpireType(league, name)
              else await client.addUmpireLevel(league, name)
              if (live()) setName('')
              await refresh()
            })
          }}
        />
        <ListCard>
          {levels.map(level => (
            <ListRow
              key={level.id}
              title={level.name}
              end={
                <Pressable
                  accessibilityRole="button"
                  accessibilityState={{ disabled: busy }}
                  style={{
                    minHeight: 48,
                    marginVertical: -12,
                    justifyContent: 'center',
                    paddingHorizontal: 12
                  }}
                  accessibilityLabel={`Remove ${level.name}`}
                  disabled={busy}
                  onPress={() => {
                    if (level.inUse) setRemoving(level)
                    else
                      run(async () => {
                        await remove(level.id)
                        await refresh()
                      })
                  }}
                >
                  <Text style={s.remove}>Remove</Text>
                </Pressable>
              }
            />
          ))}
        </ListCard>
        <UmpireError error={error} />
        {removing != null && (
          <ChoiceSheet
            title={
              notes
                ? `Removing notes type “${removing.name}” permanently clears its notes from every game.`
                : `Removing ${noun.toLowerCase()} “${removing.name}” clears its season requirements, certifications, game assignments and their credits.`
            }
            onClose={() => {
              setRemoving(undefined)
            }}
            choices={[
              {
                label: `Remove ${noun.toLowerCase()}`,
                destructive: true,
                onPress: () => {
                  run(async () => {
                    await remove(removing.id)
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
