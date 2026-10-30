import React, { useCallback, useEffect, useRef, useState } from 'react'
import {
  Linking,
  Platform,
  Pressable,
  ScrollView,
  Switch,
  Text,
  View
} from 'react-native'
import Animated from 'react-native-reanimated'

import type { TeamStationClient } from '../../common/api'
import { initialUmpireGame } from '../../common/nextGame'
import { umpirePositionName } from '../../common/umpires'
import type {
  UmpireGameRow,
  UmpireLeaderboard,
  UmpireLeague,
  UmpireSchedule
} from '../../common/umpireSchedule'
import { umpireFilterError } from '../../common/umpireTime'
import { Button, TextWidthButton } from '../components'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { Emblem } from '../components/Emblem'
import { TimePicker } from '../components/EventScheduleFields'
import { PillTabs } from '../components/PillTabs'
import { useSceneShown } from '../components/sceneShown'
import { StickySectionLayout } from '../components/StickySectionLayout'
import { TickerText } from '../components/TickerText'
import { useTitleHandoff } from '../components/useTitleHandoff'
import type { UmpireScheduleRoute } from '../navigation/routes'
import { googleDirectionsUrl } from '../platform/eventDirectionsNative'
import { useTheme } from '../theme/ThemeContext'
import {
  UmpireCell,
  UmpireError,
  UmpireHeading,
  useUmpireStyles,
  useUmpireWork
} from './shared'
import { UmpireDialog } from './UmpireDialog'
import { UmpireLeaderboardView } from './UmpireLeaderboardView'
import { UmpireSignup } from './UmpireSignup'
import { useUmpireNoteEditor } from './useUmpireNoteEditor'
const DAYS = [
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
  'Sunday'
]
export function umpireClock(time: string): string {
  const [hour, minute] = time.split(':').map(Number)
  return `${hour % 12 === 0 ? 12 : hour % 12}:${String(minute).padStart(2, '0')} ${hour < 12 ? 'AM' : 'PM'}`
}
export function umpireFilterLabel(
  route: UmpireScheduleRoute,
  levels: UmpireSchedule['levels']
): string {
  const days = (route.days ?? '').split(',').filter(Boolean).map(Number)
  const names = levels
    .filter(l => (route.levels ?? '').split(',').includes(l.id))
    .map(l => l.name)
  const time =
    route.from != null && route.to != null
      ? `${umpireClock(route.from)}–${umpireClock(route.to)}`
      : route.from != null
        ? `From ${umpireClock(route.from)}`
        : route.to != null
          ? `Until ${umpireClock(route.to)}`
          : ''
  return [
    'Filter',
    DAYS.filter((_, i) => days.includes(i))
      .map(d => d[0])
      .join(''),
    time,
    ...names,
    route.priorSeasons === 'true' ? 'Prior seasons' : ''
  ]
    .filter(Boolean)
    .join(' · ')
}
export function optionalPositionHeader(
  games: UmpireGameRow[],
  slot: string
): string | undefined {
  const offering = games.filter(g => g.positions.some(p => p.slot === slot))
  const optional = offering.filter(
    g => !g.positions.find(p => p.slot === slot)!.required
  ).length
  return optional === 0
    ? undefined
    : optional === offering.length
      ? 'Optional'
      : 'Optional in some games'
}
export { initialUmpireGame }
export function UmpireScheduleScreen({
  client,
  route,
  leagues,
  onRoute,
  onOpenTeam,
  onOpenGame,
  onBeforeLeave
}: {
  client: TeamStationClient
  route: UmpireScheduleRoute
  leagues: UmpireLeague[]
  onRoute: (route: UmpireScheduleRoute) => void
  onOpenTeam?: (id: string) => void
  onOpenGame?: (id: string) => void
  onBeforeLeave?: (check: () => Promise<boolean>) => () => void
}): React.ReactElement {
  const s = useUmpireStyles()
  const theme = useTheme()
  const handoff = useTitleHandoff('Umpire')
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
  const [tableWidth, setTableWidth] = useState(0)
  const [filter, setFilter] = useState(false)
  const [days, setDays] = useState<number[]>([])
  const [levels, setLevels] = useState<string[]>([])
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [priorSeasons, setPriorSeasons] = useState(false)
  const [timePicker, setTimePicker] = useState<'from' | 'to'>()
  const scroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const positioned = useRef(false)
  const [tableY, setTableY] = useState<number>()
  const [firstY, setFirstY] = useState<number>()
  const [sectionHeight, setSectionHeight] = useState(0)
  const [dateWidth, setDateWidth] = useState(theme.rem(6.125))
  const [signupWidth, setSignupWidth] = useState(theme.rem(4.75))
  const [conflictWidth, setConflictWidth] = useState(theme.rem(5))
  const headerScroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const bodyScroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const horizontalOffset = useRef(0)
  const showsSchedule = schedule != null && route.pill !== 'leaderboard'
  useEffect(() => {
    // Reset for remounts, not inline note saves that preserve the scroll views.
    horizontalOffset.current = 0
  }, [showsSchedule])
  const syncHorizontal = (
    x: number,
    target: React.RefObject<React.ComponentRef<typeof ScrollView> | null>
  ): void => {
    if (Math.abs(x - horizontalOffset.current) < 0.5) return
    horizontalOffset.current = x
    target.current?.scrollTo({ x, animated: false })
  }
  useEffect(() => {
    if (
      positioned.current ||
      tableY == null ||
      firstY == null ||
      sectionHeight === 0
    )
      return
    positioned.current = true
    scroll.current?.scrollTo({
      y: firstY === 0 ? 0 : Math.max(0, tableY + firstY - sectionHeight),
      animated: false
    })
  }, [tableY, firstY, sectionHeight])
  const sequence = useRef(0)
  const query = new URLSearchParams({
    view: 'schedule',
    timezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
    ...Object.fromEntries(
      (['levels', 'days', 'from', 'to', 'priorSeasons'] as const).flatMap(
        key => (route[key] == null ? [] : [[key, route[key]]])
      )
    )
  }).toString()
  useEffect(() => {
    const seq = ++sequence.current
    setSchedule(undefined)
    setBoard(undefined)
    positioned.current = false
    setFirstY(undefined)
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
    noteEditor
      .finish()
      .then(saved => {
        if (saved) onRoute({ ...route, ...next })
      })
      .catch(() => undefined)
  }
  const refresh = (): void => {
    setSignup(undefined)
    setRemoving(undefined)
    setRevision(n => n + 1)
  }
  const openFilters = (): void => {
    noteEditor
      .finish()
      .then(saved => {
        if (!saved) return
        setDays((route.days ?? '').split(',').filter(Boolean).map(Number))
        setLevels((route.levels ?? '').split(',').filter(Boolean))
        setFrom(route.from ?? '')
        setTo(route.to ?? '')
        setPriorSeasons(route.priorSeasons === 'true')
        setTimePicker(undefined)
        setFilter(true)
      })
      .catch(() => undefined)
  }
  const filterError = umpireFilterError({
    days,
    from: from === '' ? undefined : from,
    to: to === '' ? undefined : to
  })
  const [noteErrorHeight, setNoteErrorHeight] = useState(0)
  const games = schedule?.games ?? []
  const noteEditor = useUmpireNoteEditor({
    client,
    scope: `${route.id}:${query}:${route.pill ?? 'schedule'}`,
    games,
    types: schedule?.noteTypes ?? [],
    editable: schedule?.isAdmin === true,
    onFocus: input => {
      if (Platform.OS === 'web') return
      scroll.current?.scrollResponderScrollNativeHandleToKeyboard(
        input,
        16,
        true
      )
    },
    onSaved: (cell, value) => {
      setSchedule(held =>
        held == null
          ? held
          : {
              ...held,
              games: held.games.map(g =>
                g.id === cell.game
                  ? {
                      ...g,
                      umpireNotes: { ...g.umpireNotes, [cell.type]: value }
                    }
                  : g
              )
            }
      )
    }
  })
  const finish = useRef(noteEditor.finish)
  finish.current = noteEditor.finish
  const beforeLeave = useCallback(async () => await finish.current(), [])
  // Only while on show: kept beneath a team opened from it, it gates no move
  // made up there.
  const shown = useSceneShown()
  useEffect(
    () => (shown ? onBeforeLeave?.(beforeLeave) : undefined),
    [onBeforeLeave, beforeLeave, shown]
  )
  const first = initialUmpireGame(games, Date.now())
  const positions = (schedule?.types ?? []).flatMap(t => {
    const held = games.flatMap(g => g.positions).filter(p => p.typeId === t.id)
    return [...new Map(held.map(p => [p.slot, p])).values()].sort(
      (a, b) => a.ordinal - b.ordinal
    )
  })
  const columnWidth = Math.ceil(dateWidth + theme.rem(1))
  const roleWidth = Math.ceil(signupWidth + theme.rem(2))
  const conflictsWidth = Math.ceil(conflictWidth + theme.rem(0.75) + 1)
  const customWidth = Math.max(
    160,
    tableWidth / (6 + positions.length + (schedule?.noteTypes.length ?? 0))
  )
  const link = (
    text: string,
    label: string,
    onPress?: () => void
  ): React.ReactElement =>
    onPress == null ? (
      <Text numberOfLines={2} style={s.tableText}>
        {text}
      </Text>
    ) : (
      <Pressable
        accessibilityRole="link"
        accessibilityLabel={label}
        onPress={onPress}
        style={{ minHeight: 48, justifyContent: 'center' }}
      >
        <Text numberOfLines={2} style={[s.tableText, { color: '#1565C0' }]}>
          {text}
        </Text>
      </Pressable>
    )
  const cell = (game: UmpireGameRow, slot: string): React.ReactElement => {
    const assignment = game.assignments[slot]
    const position = game.positions.find(p => p.slot === slot)
    const required = position != null
    if (!required || (assignment == null && game.status === 'final'))
      return <Text style={s.tableHint}>—</Text>
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
          <TickerText
            style={[s.tableText, { color: removable ? '#1565C0' : '#212121' }]}
          >
            {assignment.name}
          </TickerText>
          {(assignment.teams?.length ?? 0) > 0 && (
            <TickerText style={s.tableHint}>
              {assignment.teams!.map(t => t.name).join(', ')}
            </TickerText>
          )}
        </Pressable>
      )
    }
    return (
      <TextWidthButton
        small
        label="Sign Up"
        accessibilityLabel={`Sign Up, ${umpirePositionName(position, game.positions)}, ${game.home} vs ${game.away}, ${game.date}`}
        disabled={schedule?.view === 'league' || busy}
        color="#EEEEEE"
        textColor="#616161"
        onPress={() => {
          setSignup({ game, slot })
        }}
      />
    )
  }
  return (
    <StickySectionLayout
      wide
      scrollRef={scroll}
      onScroll={handoff.handleScroll}
      contentStyle={{ gap: 0 }}
      hero={
        <View style={s.page}>
          <Animated.View ref={handoff.ref}>
            <UmpireHeading>Umpire</UmpireHeading>
          </Animated.View>
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
                      change({
                        id: l.id,
                        view: undefined,
                        levels: undefined,
                        priorSeasons: undefined
                      })
                  }}
                >
                  <Emblem fallback="L" uri={l.logoUrl} size={3} />
                  <Text style={s.text}>{l.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
          <UmpireError error={error} />
          <View style={{ minHeight: noteErrorHeight }}>
            <View
              onLayout={event => {
                const height = event.nativeEvent.layout.height
                setNoteErrorHeight(previous => Math.max(previous, height))
              }}
            >
              <UmpireError error={noteEditor.error} />
              {noteEditor.error !== '' && (
                <TextWidthButton
                  label="Discard note changes"
                  color="#EEEEEE"
                  textColor="#616161"
                  onPress={() => {
                    if (noteEditor.discard()) refresh()
                  }}
                />
              )}
            </View>
          </View>
          {schedule != null && route.pill !== 'leaderboard' && (
            <Button
              label={umpireFilterLabel(route, schedule.levels)}
              icon="filter_alt"
              accessibilityLabel="Schedule filters"
              compact
              kind="secondary"
              style={{ alignSelf: 'flex-start', maxWidth: '100%' }}
              labelStyle={{ flexShrink: 1 }}
              onPress={openFilters}
            />
          )}
        </View>
      }
      sections={
        <View
          testID="umpire-sticky-stack"
          onLayout={e => {
            setSectionHeight(e.nativeEvent.layout.height)
          }}
        >
          <PillTabs
            bleed={false}
            accessibilityLabel="Umpire pages"
            tabs={[
              { id: 'schedule', label: 'Schedule' },
              { id: 'leaderboard', label: 'Leaderboard' }
            ]}
            selected={route.pill ?? 'schedule'}
            onSelect={pill => {
              change({ pill })
            }}
          />
          {schedule != null && route.pill !== 'leaderboard' && (
            <ScrollView
              horizontal
              ref={headerScroll}
              testID="umpire-table-header-scroll"
              showsHorizontalScrollIndicator={false}
              scrollEventThrottle={16}
              onScroll={e => {
                syncHorizontal(e.nativeEvent.contentOffset.x, bodyScroll)
              }}
            >
              <View style={s.tableRow}>
                {['Date', 'Home team', 'Away team', 'Venue', 'Notes'].map(
                  label => (
                    <UmpireCell divided compact key={label} width={columnWidth}>
                      <Text style={[s.tableText, s.tableHeading]}>{label}</Text>
                    </UmpireCell>
                  )
                )}
                {positions.map(p => (
                  <UmpireCell divided compact key={p.slot} width={roleWidth}>
                    <Text style={[s.tableText, s.tableHeading]}>
                      {umpirePositionName(p, positions)}
                    </Text>
                    {optionalPositionHeader(games, p.slot) != null && (
                      <Text style={s.tableHint}>
                        {optionalPositionHeader(games, p.slot)}
                      </Text>
                    )}
                  </UmpireCell>
                ))}
                {schedule?.noteTypes.map(t => (
                  <UmpireCell divided compact key={t.id} width={customWidth}>
                    <Text style={[s.tableText, s.tableHeading]}>{t.name}</Text>
                  </UmpireCell>
                ))}
                <UmpireCell divided compact width={conflictsWidth}>
                  <Text style={[s.tableText, s.tableHeading]}>Conflicts</Text>
                </UmpireCell>
              </View>
            </ScrollView>
          )}
        </View>
      }
    >
      <View
        testID="umpire-table"
        onLayout={e => {
          setTableY(e.nativeEvent.layout.y)
          setTableWidth(e.nativeEvent.layout.width)
        }}
      >
        {schedule == null ? (
          <Text style={s.hint}>
            {error === '' ? 'Loading…' : 'Schedule unavailable'}
          </Text>
        ) : route.pill === 'leaderboard' ? (
          board != null && <UmpireLeaderboardView board={board} />
        ) : (
          <>
            {games.length === 0 && (
              <Text style={s.hint}>No games match this schedule.</Text>
            )}
            <ScrollView
              horizontal
              ref={bodyScroll}
              testID="umpire-table-body-scroll"
              keyboardShouldPersistTaps="handled"
              scrollEventThrottle={16}
              onScroll={e => {
                syncHorizontal(e.nativeEvent.contentOffset.x, headerScroll)
              }}
            >
              <View>
                {games.map(game => (
                  <View
                    key={game.id}
                    testID={`umpire-game-${game.id}`}
                    onLayout={e => {
                      if (game.id === first?.id)
                        setFirstY(e.nativeEvent.layout.y)
                    }}
                    style={[
                      s.tableRow,
                      game.conflicts.length > 0 && {
                        backgroundColor: '#FFF3E0'
                      }
                    ]}
                  >
                    <UmpireCell divided compact width={columnWidth}>
                      {link(
                        game.date,
                        `Open game ${game.date}`,
                        onOpenGame == null
                          ? undefined
                          : () => {
                              onOpenGame(game.id)
                            }
                      )}
                    </UmpireCell>
                    <UmpireCell divided compact width={columnWidth}>
                      {link(
                        game.home,
                        `Open ${game.home}`,
                        game.homeTeamId == null || onOpenTeam == null
                          ? undefined
                          : () => {
                              onOpenTeam(game.homeTeamId!)
                            }
                      )}
                    </UmpireCell>
                    <UmpireCell divided compact width={columnWidth}>
                      {link(
                        game.away,
                        `Open ${game.away}`,
                        game.awayTeamId == null || onOpenTeam == null
                          ? undefined
                          : () => {
                              onOpenTeam(game.awayTeamId!)
                            }
                      )}
                    </UmpireCell>
                    <UmpireCell divided compact width={columnWidth}>
                      {link(
                        game.venue !== '' ? game.venue : (game.location ?? ''),
                        `Map of ${game.venue !== '' ? game.venue : (game.location ?? '')}`,
                        (game.location == null || game.location === ''
                          ? game.venue
                          : game.location
                        ).trim() === ''
                          ? undefined
                          : () => {
                              run(async () => {
                                await Linking.openURL(
                                  googleDirectionsUrl(
                                    game.location == null ||
                                      game.location === ''
                                      ? game.venue
                                      : game.location
                                  )
                                )
                              })
                            }
                      )}
                    </UmpireCell>
                    <UmpireCell divided compact width={columnWidth}>
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
                          <Text numberOfLines={2} style={s.tableText}>
                            {game.notes}
                          </Text>
                        </Pressable>
                      )}
                    </UmpireCell>
                    {positions.map(p => (
                      <UmpireCell
                        divided
                        compact
                        key={p.slot}
                        width={roleWidth}
                        gray={
                          !game.positions.some(
                            position => position.slot === p.slot
                          ) ||
                          (game.status === 'final' &&
                            game.assignments[p.slot] == null)
                        }
                      >
                        {cell(game, p.slot)}
                      </UmpireCell>
                    ))}
                    {schedule?.noteTypes.map(t => (
                      <UmpireCell
                        divided
                        compact
                        key={t.id}
                        width={customWidth}
                      >
                        {noteEditor.cell(game, t)}
                      </UmpireCell>
                    ))}
                    <UmpireCell divided compact width={conflictsWidth}>
                      {game.conflicts.length > 0 ? (
                        <TextWidthButton
                          small
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
          </>
        )}
      </View>
      <View
        pointerEvents="none"
        aria-hidden
        accessibilityElementsHidden
        importantForAccessibility="no-hide-descendants"
        style={{
          position: 'absolute',
          height: 0,
          overflow: 'hidden',
          right: 0,
          opacity: 0,
          top: 0,
          left: 0
        }}
      >
        <View style={{ width: 10000, alignItems: 'flex-start' }}>
          {[...new Set(games.map(g => g.date))].map(date => (
            <Text
              key={date}
              testID="umpire-date-measure"
              style={s.tableText}
              numberOfLines={1}
              onLayout={e => {
                const width = e.nativeEvent.layout.width
                setDateWidth(w => Math.max(w, width))
              }}
            >
              {date}
            </Text>
          ))}
          <View
            testID="umpire-signup-measure"
            onLayout={e => {
              setSignupWidth(e.nativeEvent.layout.width)
            }}
          >
            <TextWidthButton
              small
              disabled
              label="Sign Up"
              onPress={openFilters}
            />
          </View>
          <View
            testID="umpire-conflict-measure"
            onLayout={e => {
              setConflictWidth(e.nativeEvent.layout.width)
            }}
          >
            <TextWidthButton
              small
              disabled
              label="Conflict"
              onPress={openFilters}
            />
          </View>
        </View>
      </View>
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
          minContentWidth={280}
          title="Schedule filters"
          onClose={() => {
            setFilter(false)
          }}
        >
          <Text style={s.text}>Days of week</Text>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between'
            }}
          >
            {DAYS.map((day, i) => (
              <Pressable
                key={day}
                accessibilityRole="button"
                accessibilityLabel={day}
                aria-pressed={days.includes(i)}
                aria-selected={days.includes(i)}
                style={{
                  flex: 1,
                  minWidth: 40,
                  minHeight: 44,
                  alignItems: 'center',
                  justifyContent: 'center'
                }}
                onPress={() => {
                  setDays(ds =>
                    ds.includes(i) ? ds.filter(d => d !== i) : [...ds, i]
                  )
                }}
              >
                <View
                  style={{
                    width: 32,
                    height: 32,
                    borderRadius: 16,
                    borderWidth: 1,
                    borderColor: '#1565C0',
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: days.includes(i)
                      ? '#1565C0'
                      : 'transparent'
                  }}
                >
                  <Text
                    style={[
                      s.text,
                      { color: days.includes(i) ? '#FFFFFF' : '#1565C0' }
                    ]}
                  >
                    {day[0]}
                  </Text>
                </View>
              </Pressable>
            ))}
          </View>
          <View
            testID="umpire-filter-times"
            style={{ flexDirection: 'row', gap: 12 }}
          >
            {(['from', 'to'] as const).map(endpoint => (
              <Pressable
                key={endpoint}
                accessibilityRole="button"
                accessibilityLabel={
                  endpoint === 'from' ? 'Start time' : 'End time'
                }
                onPress={() => {
                  setTimePicker(endpoint)
                }}
                style={{
                  flex: 1,
                  minWidth: 0,
                  minHeight: 48,
                  justifyContent: 'center'
                }}
              >
                <Text style={s.hint}>
                  {endpoint === 'from' ? 'Start time' : 'End time'}
                </Text>
                <Text style={[s.text, { color: '#1565C0' }]}>
                  {(endpoint === 'from' ? from : to) === ''
                    ? 'Any time'
                    : umpireClock(endpoint === 'from' ? from : to)}
                </Text>
              </Pressable>
            ))}
          </View>
          {timePicker != null && (
            <View
              testID="umpire-filter-time-picker"
              style={{
                borderWidth: 1,
                borderColor: '#D0D8CC',
                borderRadius: 12,
                padding: 12
              }}
            >
              <TimePicker
                key={timePicker}
                value={
                  timePicker === 'from'
                    ? from === ''
                      ? '09:00'
                      : from
                    : to === ''
                      ? '17:00'
                      : to
                }
                onChoose={time => {
                  if (timePicker === 'from') setFrom(time)
                  else setTo(time)
                  setTimePicker(undefined)
                }}
                onCancel={() => {
                  setTimePicker(undefined)
                }}
              />
            </View>
          )}
          <Text style={s.text}>Needs umpire level</Text>
          <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: 8 }}>
            {schedule?.levels.map(l => (
              <Pressable
                key={l.id}
                accessibilityRole="button"
                accessibilityLabel={l.name}
                aria-pressed={levels.includes(l.id)}
                aria-selected={levels.includes(l.id)}
                style={{
                  minHeight: 44,
                  maxWidth: '100%',
                  borderRadius: 22,
                  borderWidth: 1,
                  borderColor: '#1565C0',
                  paddingHorizontal: 22,
                  paddingVertical: 8,
                  justifyContent: 'center',
                  backgroundColor: levels.includes(l.id)
                    ? '#1565C0'
                    : 'transparent'
                }}
                onPress={() => {
                  setLevels(ls =>
                    ls.includes(l.id)
                      ? ls.filter(id => id !== l.id)
                      : [...ls, l.id]
                  )
                }}
              >
                <Text
                  style={[
                    s.text,
                    { color: levels.includes(l.id) ? '#FFFFFF' : '#1565C0' }
                  ]}
                >
                  {l.name}
                </Text>
              </Pressable>
            ))}
          </View>
          {schedule?.isAdmin === true && (
            <View style={[s.row, { justifyContent: 'space-between' }]}>
              <Text style={s.text}>Prior seasons</Text>
              <Switch
                accessibilityLabel="Prior seasons"
                value={priorSeasons}
                onValueChange={setPriorSeasons}
              />
            </View>
          )}
          <UmpireError error={filterError ?? ''} />
          <Button
            label="Apply filters"
            disabled={filterError != null}
            onPress={() => {
              change({
                days: days.length === 0 ? undefined : days.join(','),
                levels: levels.length === 0 ? undefined : levels.join(','),
                from: from === '' ? undefined : from,
                to: to === '' ? undefined : to,
                priorSeasons:
                  schedule?.isAdmin === true && priorSeasons
                    ? 'true'
                    : undefined
              })
              setFilter(false)
            }}
          />
          <Button
            label="Clear filters"
            kind="secondary"
            onPress={() => {
              setDays([])
              setLevels([])
              setFrom('')
              setTo('')
              setPriorSeasons(false)
              setTimePicker(undefined)
            }}
          />
        </UmpireDialog>
      )}
    </StickySectionLayout>
  )
}
