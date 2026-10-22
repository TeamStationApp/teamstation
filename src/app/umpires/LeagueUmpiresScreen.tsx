import React, { useCallback, useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import { umpireEdits } from '../../common/umpireEdits'
import type { UmpireLevel, UmpirePerson } from '../../common/umpires'
import {
  Button,
  Emblem,
  ListCard,
  Screen,
  TextField,
  TextWidthButton
} from '../components'
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
import { selectedRange, selectUmpire } from './umpireSelection'
import {
  UmpireSelector,
  useTouchInterface,
  useUnsavedWarning
} from './UmpireSelector'
export { selectedRange } from './umpireSelection'

export function umpireNameWidth(
  tableWidth: number,
  levelCount: number,
  typeCount = 2
): number {
  return Math.max(
    240,
    tableWidth - 48 - levelCount * Math.max(128, typeCount * 64 + 16) - 120
  )
}

export function LeagueUmpiresScreen({
  client,
  league,
  onChanged,
  onOpenPerson
}: {
  client: TeamStationClient
  league: string
  onChanged?: () => void
  onOpenPerson?: (id: string, name: string) => void
}): React.ReactElement {
  const s = useUmpireStyles()
  const theme = useTheme()
  const { error, busy, run, live } = useUmpireWork(league)
  const [levels, setLevels] = useState<UmpireLevel[]>([])
  const [types, setTypes] = useState<UmpireLevel[]>([])
  const [people, setPeople] = useState<UmpirePerson[]>([])
  const [baseline, setBaseline] = useState<UmpirePerson[]>([])
  const [reloading, setReloading] = useState(false)
  const [opening, setOpening] = useState<UmpirePerson>()
  const touch = useTouchInterface()
  const changes = umpireEdits(baseline, people)
  const dirty = changes.length > 0
  useUnsavedWarning(dirty)
  const anchor = useRef<string | undefined>(undefined)
  const dragBase = useRef<string[]>([])
  const [candidates, setCandidates] = useState<UmpirePerson[]>([])
  const [query, setQuery] = useState('')
  const [tableWidth, setTableWidth] = useState(0)
  const nameWidth = umpireNameWidth(tableWidth, levels.length, types.length)
  const [searchError, setSearchError] = useState('')
  const [searchRevision, setSearchRevision] = useState(0)
  const [selected, setSelected] = useState<string[]>([])
  const [removing, setRemoving] = useState<UmpirePerson>()
  const searchVersion = useRef(0)
  const refresh = useCallback(async (): Promise<void> => {
    const [ls, ps, ts] = await Promise.all([
      client.umpireLevels(league),
      client.umpirePeople(league),
      client.umpireTypes(league)
    ])
    if (live()) {
      setLevels(ls)
      setTypes(ts)
      setPeople(ps)
      setBaseline(ps)
      setSelected([])
      anchor.current = undefined
    }
  }, [client, league, live])
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
  }, [client, league, query, baseline, live, searchRevision])
  const certify = (
    person: UmpirePerson,
    levelId: string,
    typeId: string
  ): void => {
    const value =
      person.certifications.find(
        c => c.levelId === levelId && c.typeId === typeId
      )?.enabled !== true
    const targets = selected.length > 0 ? selected : [person.id]
    setPeople(ps =>
      ps.map(p => {
        if (!targets.includes(p.id)) return p
        return {
          ...p,
          certifications: [
            ...p.certifications.filter(
              c => c.levelId !== levelId || c.typeId !== typeId
            ),
            {
              levelId,
              typeId,
              enabled: value
            }
          ]
        }
      })
    )
  }
  const save = (after?: () => void): void => {
    run(async () => {
      const saved = await client.saveUmpires(league, changes)
      if (!live()) return
      setPeople(saved)
      setBaseline(saved)
      setSelected(ids => ids.filter(id => saved.some(p => p.id === id)))
      onChanged?.()
      after?.()
    })
  }
  const results = [
    ...new Map(
      [
        ...candidates,
        ...baseline.filter(
          p =>
            query.trim() !== '' &&
            p.name.toLowerCase().includes(query.trim().toLowerCase())
        )
      ].map(p => [p.id, p])
    ).values()
  ].filter(p => !people.some(held => held.id === p.id))
  const levelStyle = {
    width: Math.max(128, types.length * 64 + 16),
    padding: 8,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
    alignSelf: 'stretch' as const,
    borderLeftWidth: 1,
    borderColor: theme.glassBorderColor
  }

  return (
    <Screen wide>
      <View style={s.page}>
        <UmpireHeading>Manage Umpires</UmpireHeading>
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
          {results.map(p => (
            <Pressable
              key={p.id}
              accessibilityRole="button"
              accessibilityLabel={p.name}
              disabled={busy}
              style={[s.row, { padding: 12 }]}
              onPress={() => {
                setPeople(ps =>
                  [...ps, p].sort((a, b) =>
                    a.name.localeCompare(b.name) === 0
                      ? a.id.localeCompare(b.id)
                      : a.name.localeCompare(b.name)
                  )
                )
                setQuery('')
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
          Select rows to change several certifications together. Shift-click to
          select a range; Command/Control-click to select multiple rows.
          {touch ? ' Drag down the squares to select a range by touch.' : ''}
        </Text>
        <ScrollView
          horizontal
          onLayout={event => {
            setTableWidth(event.nativeEvent.layout.width)
          }}
          testID="umpire-management-table"
        >
          <View>
            <View style={s.tableRow}>
              <UmpireCell width={48}> </UmpireCell>
              <UmpireCell width={nameWidth}>Umpire</UmpireCell>
              {levels.map(l => (
                <View
                  key={l.id}
                  style={levelStyle}
                  testID={`umpire-level-heading-${l.id}`}
                >
                  <Text style={[s.text, { textAlign: 'center' }]}>
                    {l.name}
                  </Text>
                </View>
              ))}
              <UmpireCell width={120}> </UmpireCell>
            </View>
            {people.map((p, index) => (
              <View key={p.id} style={[s.tableRow, { height: 80 }]}>
                <UmpireSelector
                  label={`Select ${p.name}`}
                  checked={selected.includes(p.id)}
                  disabled={busy}
                  index={index}
                  count={people.length}
                  testID={`umpire-select-drag-${p.id}`}
                  onToggle={modifiers => {
                    setSelected(ids =>
                      selectUmpire(
                        people.map(p => p.id),
                        ids,
                        index,
                        anchor.current == null
                          ? undefined
                          : people.findIndex(
                              person => person.id === anchor.current
                            ),
                        modifiers
                      )
                    )
                    if (modifiers?.shiftKey !== true) anchor.current = p.id
                  }}
                  onRangeStart={() => {
                    dragBase.current = selected
                    anchor.current = p.id
                  }}
                  onRange={last => {
                    setSelected(
                      selectedRange(
                        people.map(p => p.id),
                        index,
                        last,
                        dragBase.current
                      )
                    )
                  }}
                />
                <Pressable
                  accessibilityRole="link"
                  accessibilityLabel={`Open profile for ${p.name}`}
                  disabled={busy || onOpenPerson == null}
                  style={{
                    width: nameWidth,
                    height: 80,
                    padding: 8,
                    justifyContent: 'center'
                  }}
                  onPress={() => {
                    if (dirty) setOpening(p)
                    else onOpenPerson?.(p.id, p.name)
                  }}
                >
                  <View style={s.row}>
                    <Emblem
                      uri={p.avatarUrl}
                      fallback={p.name.slice(0, 1)}
                      shape="circle"
                      size={2}
                    />
                    <Text style={[s.text, { color: '#1565C0' }]}>{p.name}</Text>
                  </View>
                  <UndoTicker
                    text={p.affiliations}
                    style={s.hint}
                    enabled
                    testID={`umpire-affiliation-${p.id}`}
                  />
                </Pressable>
                {levels.map(l => (
                  <View
                    key={l.id}
                    style={levelStyle}
                    testID={`umpire-level-cell-${l.id}`}
                  >
                    <View style={s.row}>
                      {types.map(type => {
                        const enabled =
                          p.certifications.find(
                            c => c.levelId === l.id && c.typeId === type.id
                          )?.enabled === true
                        return (
                          <View
                            key={type.id}
                            style={{ alignItems: 'center', width: 56 }}
                          >
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`${p.name}, ${l.name}, ${type.name}`}
                              aria-pressed={enabled}
                              accessibilityState={{
                                selected: enabled,
                                disabled: busy
                              }}
                              aria-disabled={busy}
                              disabled={busy}
                              onPress={() => {
                                certify(p, l.id, type.id)
                              }}
                              style={{
                                width: 48,
                                height: 48,
                                alignItems: 'center',
                                justifyContent: 'center'
                              }}
                            >
                              <View
                                style={[s.circle, enabled && s.green]}
                                testID="umpire-certification-circle"
                              >
                                {enabled && (
                                  <Text style={{ color: '#FFFFFF' }}>✓</Text>
                                )}
                              </View>
                            </Pressable>
                            <Text
                              numberOfLines={1}
                              accessibilityLabel={type.name}
                              style={[
                                s.hint,
                                { textAlign: 'center', width: '100%' }
                              ]}
                            >
                              {type.name}
                            </Text>
                          </View>
                        )
                      })}
                    </View>
                  </View>
                ))}
                <UmpireCell width={120}>
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
                </UmpireCell>
              </View>
            ))}
          </View>
        </ScrollView>
        <TextWidthButton
          label="Save"
          disabled={!dirty || busy}
          busy={busy}
          color={dirty ? '#2E7D32' : '#9E9E9E'}
          onPress={() => {
            save()
          }}
        />
        {(dirty || error !== '') && (
          <Button
            label="Reload saved settings"
            kind="text"
            disabled={busy}
            onPress={() => {
              setReloading(true)
            }}
          />
        )}
        <UmpireError error={error} />
        {reloading && (
          <ChoiceSheet
            title="Discard unsaved changes and reload saved settings?"
            onClose={() => {
              setReloading(false)
            }}
            choices={[
              {
                label: 'Discard and reload',
                destructive: true,
                onPress: () => {
                  setReloading(false)
                  run(refresh)
                }
              }
            ]}
          />
        )}
        {opening != null && (
          <ChoiceSheet
            title="Save changes before opening this profile?"
            onClose={() => {
              setOpening(undefined)
            }}
            choices={[
              {
                label: 'Save and open profile',
                onPress: () => {
                  const person = opening
                  setOpening(undefined)
                  save(() => onOpenPerson?.(person.id, person.name))
                }
              }
            ]}
          />
        )}

        {removing != null && (
          <ChoiceSheet
            title={`Revoke ${removing.name}'s umpire role? Future assignments will be removed when you save.`}
            onClose={() => {
              setRemoving(undefined)
            }}
            choices={[
              {
                label: 'Revoke umpire',
                destructive: true,
                onPress: () => {
                  setPeople(ps => ps.filter(p => p.id !== removing.id))
                  setSelected(ids => ids.filter(id => id !== removing.id))
                  setRemoving(undefined)
                }
              }
            ]}
          />
        )}
      </View>
    </Screen>
  )
}
