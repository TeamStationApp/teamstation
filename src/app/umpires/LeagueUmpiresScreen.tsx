import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type { UmpireLevel, UmpirePerson } from '../../common/umpires'
import { Button, Emblem, ListCard, Screen, TextField } from '../components'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { UndoTicker } from '../scoring/UndoTicker'
import { useTheme } from '../theme/ThemeContext'
import {
  UmpireCell,
  UmpireError,
  UmpireHeading,
  useUmpireStyles,
  useUmpireWork
} from './shared'

export function selectedRange(
  ids: string[],
  first: number,
  last: number,
  held: string[]
): string[] {
  return [
    ...new Set([
      ...held,
      ...ids.slice(Math.min(first, last), Math.max(first, last) + 1)
    ])
  ]
}
export function LeagueUmpiresScreen({
  client,
  league,
  onChanged
}: {
  client: TeamStationClient
  league: string
  onChanged?: () => void
}): React.ReactElement {
  const s = useUmpireStyles()
  const theme = useTheme()
  const { error, busy, run, live } = useUmpireWork(league)
  const [levels, setLevels] = useState<UmpireLevel[]>([])
  const [people, setPeople] = useState<UmpirePerson[]>([])
  const [candidates, setCandidates] = useState<UmpirePerson[]>([])
  const [query, setQuery] = useState('')
  const [searchError, setSearchError] = useState('')
  const [searchRevision, setSearchRevision] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [removing, setRemoving] = useState<UmpirePerson>()
  const searchVersion = useRef(0)
  const drag = useRef<
    | {
        first: number
        y: number
        ids: string[]
        moved: boolean
      }
    | undefined
  >(undefined)
  const refresh = useCallback(async (): Promise<void> => {
    const [ls, ps] = await Promise.all([
      client.umpireLevels(league),
      client.umpirePeople(league)
    ])
    if (live()) {
      setLevels(ls)
      setPeople(ps)
      onChanged?.()
    }
  }, [client, league, live, onChanged])
  useEffect(() => {
    run(refresh)
  }, [refresh, run])
  useEffect(() => {
    const version = ++searchVersion.current
    setCandidates([])
    setSearchError('')
    if (query.trim() === '') return
    client
      .umpirePeople(league, query)
      .then(ps => {
        if (live() && version === searchVersion.current) setCandidates(ps)
      })
      .catch((e: unknown) => {
        if (live() && version === searchVersion.current)
          setSearchError(
            e instanceof Error
              ? e.message
              : 'Search unavailable. Please try again.'
          )
      })
  }, [client, league, query, people, live, searchRevision])
  const certify = (
    person: UmpirePerson,
    levelId: string,
    capability: 'plate' | 'field'
  ): void => {
    run(async () => {
      const value =
        person.certifications.find(c => c.levelId === levelId)?.[capability] !==
        true
      const targets =
        selected.length > 0
          ? people.filter(p => selected.includes(p.id))
          : [person]
      for (const target of targets) {
        const old = target.certifications.find(c => c.levelId === levelId)
        await client.certifyUmpire(league, target.id, {
          levelId,
          plate: old?.plate ?? false,
          field: old?.field ?? false,
          [capability]: value
        })
      }
      await refresh()
    })
  }
  return (
    <Screen wide>
      <View style={s.page}>
        <UmpireHeading>Add Umpires</UmpireHeading>
        <TextField
          label="Search affiliated people"
          value={query}
          onChangeText={setQuery}
        />
        <UmpireError error={searchError} />
        {searchError !== '' && (
          <Button
            label="Retry search"
            kind="secondary"
            onPress={() => {
              setSearchRevision(n => n + 1)
            }}
          />
        )}
        <ListCard>
          {candidates.map(p => (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityLabel={p.name}
              disabled={busy}
              style={[s.row, { padding: 12 }]}
              onPress={() => {
                run(async () => {
                  await client.grantUmpire(league, p.id)
                  await refresh()
                })
              }}
            >
              <Emblem
                fallback={p.name.slice(0, 1)}
                uri={p.avatarUrl}
                shape="circle"
              />
              <View style={{ flex: 1, minWidth: 0 }}>
                <Text style={s.text}>{p.name}</Text>
                <UndoTicker
                  text={p.affiliations}
                  style={s.hint}
                  enabled
                  testID={`candidate-affiliation-${p.id}`}
                />
              </View>
            </Pressable>
          ))}
        </ListCard>
        <Text style={s.hint}>
          Select rows to change several certifications together. Drag down the
          squares to select a range.
        </Text>
        <ScrollView horizontal>
          <View>
            <View style={s.tableRow}>
              <UmpireCell width={48}> </UmpireCell>
              <UmpireCell width={240}>Umpire</UmpireCell>
              {levels.map(l => (
                <UmpireCell key={l.id} width={160}>
                  {l.name}
                </UmpireCell>
              ))}
            </View>
            {people.map((p, index) => (
              <View key={p.id} style={[s.tableRow, { height: 80 }]}>
                <View
                  style={{ width: 48, height: 80, justifyContent: 'center' }}
                  testID={`umpire-select-drag-${p.id}`}
                  onStartShouldSetResponderCapture={() => !busy}
                  onResponderGrant={e => {
                    drag.current = {
                      first: index,
                      y: e.nativeEvent.pageY,
                      ids: selected,
                      moved: false
                    }
                  }}
                  onResponderMove={e => {
                    const d = drag.current
                    if (d == null) return
                    const offset = Math.round((e.nativeEvent.pageY - d.y) / 80)
                    if (offset !== 0) {
                      d.moved = true
                      setSelected(
                        selectedRange(
                          people.map(p => p.id),
                          d.first,
                          Math.max(
                            0,
                            Math.min(people.length - 1, d.first + offset)
                          ),
                          d.ids
                        )
                      )
                    }
                  }}
                  onResponderRelease={() => {
                    const d = drag.current
                    if (d != null && !d.moved)
                      setSelected(ids =>
                        ids.includes(p.id)
                          ? ids.filter(id => id !== p.id)
                          : [...ids, p.id]
                      )
                    drag.current = undefined
                  }}
                  onResponderTerminate={() => {
                    drag.current = undefined
                  }}
                >
                  <Pressable
                    accessibilityRole="checkbox"
                    accessibilityLabel={`Select ${p.name}`}
                    aria-checked={selected.includes(p.id)}
                    onPress={() => {
                      setSelected(ids =>
                        ids.includes(p.id)
                          ? ids.filter(id => id !== p.id)
                          : [...ids, p.id]
                      )
                    }}
                  >
                    <Text style={s.text}>
                      {selected.includes(p.id) ? '☑' : '☐'}
                    </Text>
                  </Pressable>
                </View>
                <UmpireCell width={240}>
                  <View style={s.row}>
                    <Emblem
                      uri={p.avatarUrl}
                      fallback={p.name.slice(0, 1)}
                      shape="circle"
                      size={2}
                    />
                    <Text style={s.text}>{p.name}</Text>
                  </View>
                  <UndoTicker
                    text={p.affiliations}
                    style={s.hint}
                    enabled
                    testID={`umpire-affiliation-${p.id}`}
                  />
                </UmpireCell>
                {levels.map(l => (
                  <UmpireCell key={l.id} width={160}>
                    <View style={s.row}>
                      {(['plate', 'field'] as const).map(capability => {
                        const enabled =
                          p.certifications.find(c => c.levelId === l.id)?.[
                            capability
                          ] === true
                        return (
                          <View key={capability}>
                            <Pressable
                              accessibilityRole="checkbox"
                              accessibilityLabel={`${p.name}, ${l.name}, ${capability}`}
                              aria-checked={enabled}
                              aria-disabled={busy}
                              disabled={busy}
                              onPress={() => {
                                certify(p, l.id, capability)
                              }}
                              style={[s.circle, enabled && s.green]}
                            >
                              <Text
                                style={{
                                  color: enabled ? '#FFFFFF' : '#757575'
                                }}
                              >
                                {enabled ? '✓' : '○'}
                              </Text>
                            </Pressable>
                            <Text style={s.hint}>{capability}</Text>
                          </View>
                        )
                      })}
                    </View>
                  </UmpireCell>
                ))}
                <Button
                  label="Revoke"
                  accessibilityLabel={`Revoke ${p.name}`}
                  textColor={theme.dangerColor}
                  kind="text"
                  disabled={busy}
                  onPress={() => {
                    setRemoving(p)
                  }}
                />
              </View>
            ))}
          </View>
        </ScrollView>
        <UmpireError error={error} />
        {removing != null && (
          <ChoiceSheet
            title={`Revoke ${removing.name}'s umpire role? Future assignments will be removed.`}
            onClose={() => {
              setRemoving(undefined)
            }}
            choices={[
              {
                label: 'Revoke umpire',
                destructive: true,
                onPress: () => {
                  run(async () => {
                    await client.revokeUmpire(league, removing.id)
                    setSelected(ids => ids.filter(id => id !== removing.id))
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
