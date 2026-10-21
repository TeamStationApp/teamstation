import React, { useEffect, useRef, useState } from 'react'
import { Pressable, ScrollView, Text, View } from 'react-native'

import type { TeamStationClient } from '../../common/api'
import type {
  UmpireGameRow,
  UmpireLeaderboard,
  UmpireLeague,
  UmpireSchedule
} from '../../common/umpireSchedule'
import { umpireFilterError } from '../../common/umpireTime'
import { Button, Screen, TextField } from '../components'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { Emblem } from '../components/Emblem'
import { SegmentedPill } from '../components/SegmentedPill'
import type { UmpireScheduleRoute } from '../navigation/routes'
import {
  UmpireCell,
  UmpireCheck,
  UmpireError,
  UmpireHeading,
  useUmpireStyles,
  useUmpireWork
} from './shared'
import { UmpireDialog } from './UmpireDialog'
import { UmpireLeaderboardView } from './UmpireLeaderboardView'
import { UmpireSignup } from './UmpireSignup'
const DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday'
]
export function initialUmpireGame(
  games: UmpireGameRow[],
  now: number
): UmpireGameRow | undefined {
  return (
    games.find(
      g => g.status === 'inProgress' || Date.parse(g.startAt) >= now
    ) ?? games.at(-1)
  )
}
export function UmpireScheduleScreen({
  client,
  route,
  leagues,
  onRoute
}: {
  client: TeamStationClient
  route: UmpireScheduleRoute
  leagues: UmpireLeague[]
  onRoute: (route: UmpireScheduleRoute) => void
}): React.ReactElement {
  const s = useUmpireStyles()
  const { error, busy, run, live } = useUmpireWork(route.id)
  const [schedule, setSchedule] = useState<UmpireSchedule>()
  const [board, setBoard] = useState<UmpireLeaderboard>()
  const [revision, setRevision] = useState(0)
  const [signup, setSignup] = useState<{ game: UmpireGameRow; slot: string }>()
  const [removing, setRemoving] = useState<{
    game: UmpireGameRow
    slot: string
  }>()
  const [conflicts, setConflicts] = useState<UmpireGameRow>()
  const [notes, setNotes] = useState<string>()
  const [filter, setFilter] = useState(false)
  const [days, setDays] = useState<number[]>([])
  const [levels, setLevels] = useState<string[]>([])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const positioned = useRef(false)
  const tableY = useRef(0)
  const sequence = useRef(0)
  const query = new URLSearchParams({
    view: route.view ?? 'umpire',
    ...Object.fromEntries(
      (['levels', 'days', 'from', 'to'] as const).flatMap(key =>
        route[key] == null ? [] : [[key, route[key]]]
      )
    )
  }).toString()
  useEffect(() => {
    const seq = ++sequence.current
    setSchedule(undefined)
    setBoard(undefined)
    positioned.current = false
    run(async () => {
      const [next, ranks] = await Promise.all([
        client.umpireSchedule(route.id, query),
        client.umpireLeaderboard(route.id)
      ])
      if (live() && seq === sequence.current) {
        setSchedule(next)
        setBoard(ranks)
      }
    }, true)
  }, [client, route.id, query, revision, live, run])
  const change = (next: Partial<UmpireScheduleRoute>): void => {
    onRoute({ ...route, ...next })
  }
  const refresh = (): void => {
    setSignup(undefined)
    setRemoving(undefined)
    setRevision(n => n + 1)
  }
  const openFilters = (): void => {
    setDays((route.days ?? '').split(',').filter(Boolean).map(Number))
    setLevels((route.levels ?? '').split(',').filter(Boolean))
    setFrom(route.from ?? '')
    setTo(route.to ?? '')
    setFilter(true)
  }
  const filterError = umpireFilterError({
    days,
    from: from === '' ? undefined : from,
    to: to === '' ? undefined : to
  })
  const games = schedule?.games ?? []
  const first = initialUmpireGame(games, Date.now())
  const fieldCount = Math.max(0, ...games.map(g => g.fieldCount))
  const cell = (game: UmpireGameRow, slot: string): React.ReactElement => {
    const assignment = game.assignments[slot]
    const required =
      slot === 'plate'
        ? game.plate
        : Number(slot.split(':')[1]) <= game.fieldCount
    if (!required || (assignment == null && game.status === 'final'))
      return <Text style={s.hint}>—</Text>
    if (assignment != null) {
      const removable =
        assignment.canRemove &&
        (schedule?.isAdmin === true ||
          Date.now() < Date.parse(game.startAt) - 15 * 60000)
      return (
        <Pressable
          disabled={!removable || busy}
          accessibilityRole={removable ? 'button' : 'text'}
          accessibilityLabel={`${assignment.name}, ${slot}`}
          onPress={() => {
            setRemoving({ game, slot })
          }}
        >
          <Text style={[s.text, { color: removable ? '#1565C0' : '#212121' }]}>
            {assignment.name}
          </Text>
        </Pressable>
      )
    }
    return (
      <Button
        label={
          slot === 'plate' ? 'Plate umpire' : `Field ump ${slot.split(':')[1]}`
        }
        accessibilityLabel={
          slot === 'plate' ? 'Plate umpire' : `Field ump ${slot.split(':')[1]}`
        }
        kind="secondary"
        small
        disabled={
          schedule?.view === 'league' || route.view === 'league' || busy
        }
        color="#EEEEEE"
        textColor="#616161"
        onPress={() => {
          setSignup({ game, slot })
        }}
      />
    )
  }
  return (
    <Screen wide scroll={false}>
      <ScrollView ref={scroll}>
        <View style={s.page}>
          <UmpireHeading>Umpire schedule</UmpireHeading>
          {leagues.length > 1 && (
            <ScrollView
              horizontal
              contentContainerStyle={{ gap: 12, padding: 6 }}
            >
              {leagues.map(l => (
                <Pressable
                  key={l.id}
                  accessibilityRole="button"
                  accessibilityLabel={l.name}
                  aria-selected={l.id === route.id}
                  style={[
                    s.row,
                    {
                      padding: 16,
                      borderRadius: 16,
                      backgroundColor: '#EEEEEE',
                      boxShadow: '0 3px 5px #999999',
                      borderWidth: 2,
                      borderColor: l.id === route.id ? '#1565C0' : 'transparent'
                    }
                  ]}
                  onPress={() => {
                    if (l.id !== route.id)
                      change({ id: l.id, view: 'umpire', levels: undefined })
                  }}
                >
                  <Emblem fallback="L" uri={l.logoUrl} size={3} />
                  <Text style={s.text}>{l.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
          <SegmentedPill
            accessibilityLabel="Umpire pages"
            options={[
              { id: 'schedule', label: 'Schedule' },
              { id: 'leaderboard', label: 'Leaderboard' }
            ]}
            selected={route.pill ?? 'schedule'}
            onSelect={pill => {
              change({ pill })
            }}
          />
          <UmpireError error={error} />
          {schedule == null ? (
            <Text style={s.hint}>
              {error === '' ? 'Loading…' : 'Schedule unavailable'}
            </Text>
          ) : route.pill === 'leaderboard' ? (
            board != null && <UmpireLeaderboardView board={board} />
          ) : (
            <>
              {schedule.isAdmin && leagues.some(l => l.id === route.id) && (
                <SegmentedPill
                  accessibilityLabel="Schedule view"
                  options={[
                    { id: 'umpire', label: 'Umpire view' },
                    { id: 'league', label: 'League view' }
                  ]}
                  selected={route.view ?? 'umpire'}
                  onSelect={view => {
                    change({ view })
                  }}
                />
              )}
              <Button label="Filters" kind="secondary" onPress={openFilters} />
              {games.length === 0 && (
                <Text style={s.hint}>No games match this schedule.</Text>
              )}
              <View
                onLayout={e => {
                  tableY.current = e.nativeEvent.layout.y
                }}
              >
                <ScrollView horizontal>
                  <View>
                    <View style={s.tableRow}>
                      {[
                        'Date',
                        'Home team',
                        'Away team',
                        'Venue',
                        'Notes',
                        'Plate umpire',
                        ...Array.from(
                          { length: fieldCount },
                          (_, i) => `Field ump ${i + 1}`
                        ),
                        'Conflicts'
                      ].map(label => (
                        <UmpireCell key={label} width={160}>
                          {label}
                        </UmpireCell>
                      ))}
                    </View>
                    {games.map(game => (
                      <View
                        key={game.id}
                        testID={`umpire-game-${game.id}`}
                        onLayout={e => {
                          if (game.id === first?.id && !positioned.current) {
                            positioned.current = true
                            scroll.current?.scrollTo({
                              y: Math.max(
                                0,
                                tableY.current + e.nativeEvent.layout.y - 56
                              ),
                              animated: false
                            })
                          }
                        }}
                        style={[
                          s.tableRow,
                          game.conflicts.length > 0 && {
                            backgroundColor: '#FFF3E0'
                          }
                        ]}
                      >
                        <UmpireCell width={160}>{game.date}</UmpireCell>
                        <UmpireCell width={160}>{game.home}</UmpireCell>
                        <UmpireCell width={160}>{game.away}</UmpireCell>
                        <UmpireCell width={160}>{game.venue}</UmpireCell>
                        <UmpireCell width={160}>
                          {game.notes === '' ? (
                            ''
                          ) : (
                            <Pressable
                              accessibilityRole="button"
                              accessibilityLabel={`Notes for ${game.date}`}
                              onPress={() => {
                                setNotes(game.notes)
                              }}
                            >
                              <Text style={s.text}>
                                {game.notes.length > 10
                                  ? game.notes.slice(0, 10) + '…'
                                  : game.notes}
                              </Text>
                            </Pressable>
                          )}
                        </UmpireCell>
                        <UmpireCell
                          width={160}
                          gray={
                            !game.plate ||
                            (game.status === 'final' &&
                              game.assignments.plate == null)
                          }
                        >
                          {cell(game, 'plate')}
                        </UmpireCell>
                        {Array.from({ length: fieldCount }, (_, i) => (
                          <UmpireCell
                            key={i}
                            width={160}
                            gray={
                              i >= game.fieldCount ||
                              (game.status === 'final' &&
                                game.assignments[`field:${i + 1}`] == null)
                            }
                          >
                            {cell(game, `field:${i + 1}`)}
                          </UmpireCell>
                        ))}
                        <UmpireCell width={160}>
                          {game.conflicts.length > 0 ? (
                            <Button
                              label="Conflict"
                              accessibilityLabel="Conflict"
                              color="#FFE0B2"
                              textColor="#6D4C41"
                              onPress={() => {
                                setConflicts(game)
                              }}
                            />
                          ) : (
                            '—'
                          )}
                        </UmpireCell>
                      </View>
                    ))}
                  </View>
                </ScrollView>
              </View>
            </>
          )}
          {signup != null && schedule != null && (
            <UmpireSignup
              key={`${signup.game.id}:${signup.slot}`}
              client={client}
              game={signup.game}
              slot={signup.slot}
              schedule={schedule}
              onClose={() => {
                setSignup(undefined)
              }}
              onSaved={refresh}
            />
          )}
          {removing != null && (
            <ChoiceSheet
              title={`Remove ${removing.game.assignments[removing.slot].name} from this position?`}
              onClose={() => {
                setRemoving(undefined)
              }}
              choices={[
                {
                  label: 'Remove assignment',
                  destructive: true,
                  onPress: () => {
                    run(async () => {
                      await client.removeUmpire(removing.game.id, removing.slot)
                      if (live()) refresh()
                    })
                  }
                }
              ]}
            />
          )}
          {conflicts != null && (
            <UmpireDialog
              title="Conflicts"
              onClose={() => {
                setConflicts(undefined)
              }}
            >
              {conflicts.conflicts.map((c, i) => (
                <Text key={i} style={s.text}>
                  {c.name} — {c.activity}, {c.time}; {c.closeness}
                </Text>
              ))}
            </UmpireDialog>
          )}
          {notes != null && (
            <UmpireDialog
              title="Game notes"
              onClose={() => {
                setNotes(undefined)
              }}
            >
              <Text style={s.text}>{notes}</Text>
            </UmpireDialog>
          )}
          {filter && (
            <UmpireDialog
              title="Schedule filters"
              onClose={() => {
                setFilter(false)
              }}
            >
              <Text style={s.text}>Days of week</Text>
              {DAYS.map((day, i) => (
                <UmpireCheck
                  key={day}
                  label={day}
                  checked={days.includes(i)}
                  onPress={() => {
                    setDays(ds =>
                      ds.includes(i) ? ds.filter(d => d !== i) : [...ds, i]
                    )
                  }}
                />
              ))}
              <TextField
                label="Start time"
                placeholder="HH:mm"
                value={from}
                onChangeText={setFrom}
              />
              <TextField
                label="End time"
                placeholder="HH:mm"
                value={to}
                onChangeText={setTo}
              />
              <Text style={s.text}>Needs umpire level</Text>
              {schedule?.levels.map(l => (
                <UmpireCheck
                  key={l.id}
                  label={l.name}
                  checked={levels.includes(l.id)}
                  onPress={() => {
                    setLevels(ls =>
                      ls.includes(l.id)
                        ? ls.filter(id => id !== l.id)
                        : [...ls, l.id]
                    )
                  }}
                />
              ))}
              <UmpireError error={filterError ?? ''} />
              <Button
                label="Apply filters"
                disabled={filterError != null}
                onPress={() => {
                  change({
                    days: days.length === 0 ? undefined : days.join(','),
                    levels: levels.length === 0 ? undefined : levels.join(','),
                    from: from === '' ? undefined : from,
                    to: to === '' ? undefined : to
                  })
                  setFilter(false)
                }}
              />
            </UmpireDialog>
          )}
        </View>
      </ScrollView>
    </Screen>
  )
}
