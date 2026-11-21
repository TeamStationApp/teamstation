import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
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

import type { TeamStationClient, UmpireSchedulePage } from '../../common/api'
import { initialUmpireGame } from '../../common/nextGame'
import {
  type UmpireAvailability,
  umpirePositionName
} from '../../common/umpires'
import {
  optionalPositionHeader,
  UMPIRE_PAGE_MOST,
  type UmpireGameRow,
  type UmpireLeaderboard,
  type UmpireLeague,
  type UmpireSchedule
} from '../../common/umpireSchedule'
import { umpireFilterError } from '../../common/umpireTime'
import { Button, TextWidthButton } from '../components'
import { ChoiceSheet } from '../components/ChoiceSheet'
import { TimePicker } from '../components/EventScheduleFields'
import { GroupEmblem } from '../components/GroupEmblem'
import { PagedList } from '../components/PagedList'
import { PagedListEnd, PagedListStart } from '../components/PagedListEnd'
import { usePageScroll } from '../components/pageScroll'
import { PillButton, PillTabs } from '../components/PillTabs'
import { useSceneShown } from '../components/sceneShown'
import { StickySectionLayout } from '../components/StickySectionLayout'
import { TickerText } from '../components/TickerText'
import { useTitleHandoff } from '../components/useTitleHandoff'
import { usePagedList } from '../hooks/usePagedList'
import { lstrings } from '../locales/strings'
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
/** A row of Sign Up buttons, which is most of them, before it is measured. */
const ROW_HEIGHT = 49
/**
 * The widest `umpireDate` writes. Rows mount near the screen, so a column as
 * wide as the rows it holds would change width as the table scrolled.
 */
const LONGEST_DATE = 'May 28, 12:00 pm'
const gameId = (game: UmpireGameRow): string => game.id
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
/**
 * The route's weekdays, 0 is Monday … 6 is Sunday. Anything else a
 * hand-edited link holds is dropped, so it never reaches a query or a save.
 */
export function routeDays(route: UmpireScheduleRoute): number[] {
  return [
    ...new Set(
      (route.days ?? '')
        .split(',')
        .filter(day => /^[0-6]$/.test(day))
        .map(Number)
    )
  ]
}
export function umpireFilterLabel(
  route: UmpireScheduleRoute,
  levels: UmpireSchedule['levels']
): string {
  const days = routeDays(route)
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
const deviceZone = (): string =>
  Intl.DateTimeFormat().resolvedOptions().timeZone
/** Whether the route names a filter. Prior seasons alone is not one. */
export function routeNamesFilter(route: UmpireScheduleRoute): boolean {
  return (['levels', 'days', 'from', 'to'] as const).some(
    key => route[key] != null
  )
}
/**
 * The filter the route applies, in the zone it is read in. With the league's
 * level ids, `known`, a level it no longer has is left out, as the server
 * leaves it out of what it saves, so a stale link does not ask to be saved.
 */
export function appliedAvailability(
  route: UmpireScheduleRoute,
  known?: readonly string[]
): UmpireAvailability {
  return {
    levels: (route.levels ?? '')
      .split(',')
      .filter(
        level => level !== '' && (known == null || known.includes(level))
      ),
    days: routeDays(route),
    from: route.from ?? null,
    to: route.to ?? null,
    timezone: route.timezone ?? deviceZone()
  }
}
const isEmptyAvailability = (a: UmpireAvailability): boolean =>
  a.levels.length === 0 && a.days.length === 0 && a.from == null && a.to == null
const sameList = (
  a: Array<string | number>,
  b: Array<string | number>
): boolean => {
  const sorted = (list: Array<string | number>): string =>
    JSON.stringify(list.map(String).sort((x, y) => x.localeCompare(y)))
  return sorted(a) === sorted(b)
}
/**
 * Whether Save filter has something to save: the applied filter is not the
 * saved one. The zone counts only where days or a time range read it.
 */
export function availabilityDiffers(
  applied: UmpireAvailability,
  saved: UmpireAvailability | null
): boolean {
  if (saved == null) return !isEmptyAvailability(applied)
  return (
    !sameList(applied.levels, saved.levels) ||
    !sameList(applied.days, saved.days) ||
    applied.from !== saved.from ||
    applied.to !== saved.to ||
    (applied.timezone !== saved.timezone &&
      (applied.days.length > 0 || applied.from != null || applied.to != null))
  )
}
/** The route with a saved filter applied, keeping its prior seasons. */
export function withAvailability(
  route: UmpireScheduleRoute,
  a: UmpireAvailability
): UmpireScheduleRoute {
  return {
    ...route,
    levels: a.levels.length === 0 ? undefined : a.levels.join(','),
    days: a.days.length === 0 ? undefined : a.days.join(','),
    from: a.from ?? undefined,
    to: a.to ?? undefined,
    // The zone reads only days and a range; a levels-only filter leaves the
    // schedule in the device's zone.
    timezone:
      a.days.length > 0 || a.from != null || a.to != null
        ? a.timezone
        : undefined
  }
}
/** An admin may always clear a slot. Anyone else may only before the cutoff. */
export function assignmentRemovable(
  assignment: { canRemove: boolean },
  game: { startAt: string },
  isAdmin: boolean
): boolean {
  return (
    assignment.canRemove &&
    (isAdmin || Date.now() < Date.parse(game.startAt) - 15 * 60000)
  )
}

export { initialUmpireGame, optionalPositionHeader }
/** Says when a person moves the page, not the app. */
function ReaderMoved({ onMoved }: { onMoved: () => void }): null {
  const source = usePageScroll()
  useEffect(
    () => source.subscribe({ onReaderMoved: onMoved }, { active: true }),
    [onMoved, source]
  )
  return null
}
export function UmpireScheduleScreen({
  client,
  route,
  leagues,
  onRoute,
  onOpenTeam,
  onOpenGame,
  onOpenPerson,
  onBeforeLeave,
  umpireChat,
  onOpenChat,
  onRefreshChats
}: {
  client: TeamStationClient
  route: UmpireScheduleRoute
  leagues: UmpireLeague[]
  onRoute: (route: UmpireScheduleRoute) => void
  onOpenTeam?: (id: string) => void
  onOpenGame?: (id: string) => void
  onOpenPerson?: (userId: string, name: string) => void
  onBeforeLeave?: (check: () => Promise<boolean>) => () => void
  /** The league's umpire chat, when the reader is one of its members. */
  umpireChat?: { id: string; title: string }
  onOpenChat?: (chat: { id: string; title: string }) => void
  /** Reads the reader's chats again: an umpire just granted finds theirs. */
  onRefreshChats?: () => void
}): React.ReactElement {
  const s = useUmpireStyles()
  const theme = useTheme()
  const handoff = useTitleHandoff('Umpire')
  const { error, busy, run, live } = useUmpireWork(route.id)
  // The reader's chats as they are now, each time a league opens here.
  const refreshChats = useRef(onRefreshChats)
  refreshChats.current = onRefreshChats
  useEffect(() => {
    // An empty id waits for the leagues, which name the one to open.
    if (route.id !== '') refreshChats.current?.()
  }, [route.id])
  // Schedule and Leaderboard, then the umpire chat as the strip's next pill:
  // the strip's end padding, the pill's own margin and this gap make the
  // tabs' own spacing. Where all three do not fit, the pill goes whole onto a
  // row of its own, its margin putting it under Schedule.
  const chatRow = {
    flexDirection: 'row' as const,
    flexWrap: 'wrap' as const,
    alignItems: 'center' as const,
    gap: theme.rem(theme.spaceSmRem - 2 * theme.spaceXsRem)
  }
  const chatPill = { marginLeft: theme.rem(theme.spaceXsRem) }
  // The person's saved filter for the league on show, once its read answers
  // (or fails, which counts as read with none and offers no Save filter).
  const [saved, setSaved] = useState<{
    league: string
    availability: UmpireAvailability | null
    failed?: boolean
  }>()
  // No league to read one for (none yet, or none at all) is read as none.
  const savedRead = route.id === '' || saved?.league === route.id
  const [savingFilter, setSavingFilter] = useState(false)
  const latestRoute = useRef(route)
  latestRoute.current = route
  const latestOnRoute = useRef(onRoute)
  latestOnRoute.current = onRoute
  useEffect(() => {
    // An empty id waits for the leagues, which name the one to open.
    if (route.id === '') return
    const league = route.id
    let current = true
    client.umpireAvailability(league).then(
      availability => {
        if (!current) return
        setSaved({ league, availability })
        const shown = latestRoute.current
        // A route that names a filter, such as a shared link, is left as is.
        if (
          availability != null &&
          !isEmptyAvailability(availability) &&
          shown.id === league &&
          !routeNamesFilter(shown)
        )
          latestOnRoute.current(withAvailability(shown, availability))
      },
      () => {
        if (current) setSaved({ league, availability: null, failed: true })
      }
    )
    return () => {
      current = false
    }
  }, [client, route.id])
  const [schedule, setSchedule] = useState<UmpireSchedulePage>()
  const [board, setBoard] = useState<UmpireLeaderboard>()
  const [revision, setRevision] = useState(0)
  const [signup, setSignup] = useState<{ game: UmpireGameRow; slot: string }>()
  const [opened, setOpened] = useState<{
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
  const readerMoved = useRef(false)
  const [tableY, setTableY] = useState<number>()
  const [firstY, setFirstY] = useState<number>()
  const [sectionHeight, setSectionHeight] = useState(0)
  const [dateWidth, setDateWidth] = useState(theme.rem(6.125))
  const [signupWidth, setSignupWidth] = useState(theme.rem(4.75))
  const [conflictWidth, setConflictWidth] = useState(theme.rem(5))
  const headerScroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const bodyScroll = useRef<React.ComponentRef<typeof ScrollView>>(null)
  const horizontalOffset = useRef(0)
  // The scroller a finger last took. A scroll sent to the other one reports
  // back late, so if both led, each could copy the other's last offset for
  // ever, swapping them every frame. Until a finger takes one (always, on the
  // web, which has no drag events) either leads.
  const horizontalLeader = useRef<'header' | 'body'>(undefined)
  const showsSchedule = schedule != null && route.pill !== 'leaderboard'
  useEffect(() => {
    // Reset for remounts, not inline note saves that preserve the scroll views.
    horizontalOffset.current = 0
    horizontalLeader.current = undefined
  }, [showsSchedule])
  const syncHorizontal = (side: 'header' | 'body', x: number): void => {
    if (Math.abs(x - horizontalOffset.current) < 0.5) return
    const [own, other] =
      side === 'header'
        ? [headerScroll, bodyScroll]
        : [bodyScroll, headerScroll]
    const leader = horizontalLeader.current
    if (leader != null && side !== leader) {
      // Late, or its own momentum: back to the leader, which hears nothing.
      own.current?.scrollTo({ x: horizontalOffset.current, animated: false })
      return
    }
    horizontalOffset.current = x
    other.current?.scrollTo({ x, animated: false })
  }
  // The opening row moves as rows above it are measured, so it is followed
  // until somebody takes the page from it.
  useEffect(() => {
    if (
      readerMoved.current ||
      tableY == null ||
      firstY == null ||
      sectionHeight === 0
    )
      return
    scroll.current?.scrollTo({
      y: firstY === 0 ? 0 : Math.max(0, tableY + firstY - sectionHeight),
      animated: false
    })
  }, [tableY, firstY, sectionHeight])
  const noteReaderMoved = useCallback(() => {
    readerMoved.current = true
  }, [])
  const sequence = useRef(0)
  const query = new URLSearchParams({
    view: 'schedule',
    timezone: route.timezone ?? deviceZone(),
    ...Object.fromEntries(
      (['levels', 'days', 'from', 'to', 'priorSeasons'] as const).flatMap(
        key => {
          const value =
            key !== 'days'
              ? route[key]
              : routeDays(route).length === 0
                ? undefined
                : routeDays(route).join(',')
          return value == null ? [] : [[key, value]]
        }
      )
    )
  }).toString()
  const list = usePagedList<UmpireGameRow>({
    listKey: `${route.id}:${query}:${revision}`,
    auto: false,
    keyOf: gameId,
    // Each page computes the whole schedule, so a refresh after a sign-up
    // reads the held rows in as few pages as it can.
    largestPage: UMPIRE_PAGE_MOST,
    read: async (cursor, count) => {
      const seq = sequence.current
      // A first page keeps its usual size, which sets the rows before the
      // game it opens on as well as those after it.
      const page = await client.umpireSchedulePage(
        route.id,
        query,
        cursor == null
          ? { around: 'next' }
          : { cursor, ...(count == null ? {} : { limit: count }) }
      )
      if (live() && seq === sequence.current) setSchedule(page)
      return page
    }
  })
  const { apply: applyPage } = list
  // With no filter named, the first request waits for the saved one.
  const loads = routeNamesFilter(route) || savedRead
  useEffect(() => {
    if (!loads) return
    const seq = ++sequence.current
    setSchedule(undefined)
    setBoard(undefined)
    readerMoved.current = false
    setFirstY(undefined)
    run(async () => {
      const [next, ranks] = await Promise.all([
        client.umpireSchedulePage(route.id, query, { around: 'next' }),
        client.umpireLeaderboard(route.id)
      ])
      if (live() && seq === sequence.current) {
        setSchedule(next)
        setBoard(ranks)
        await applyPage(next)
      }
    }, true)
  }, [applyPage, client, route.id, query, revision, live, run, loads])
  const change = (next: Partial<UmpireScheduleRoute>): void => {
    noteEditor
      .finish()
      .then(saved => {
        if (saved) onRoute({ ...route, ...next })
      })
      .catch(() => undefined)
  }
  // A change to one row can reach the conflicts of any other, and the place
  // on the page stays where it is.
  const refresh = (): void => {
    const seq = sequence.current
    setSignup(undefined)
    setOpened(undefined)
    run(async () => {
      const [ranks] = await Promise.all([
        client.umpireLeaderboard(route.id),
        list.refreshHeld()
      ])
      if (live() && seq === sequence.current) setBoard(ranks)
    }, true)
  }
  const openFilters = (): void => {
    noteEditor
      .finish()
      .then(saved => {
        if (!saved) return
        setDays(routeDays(route))
        setLevels((route.levels ?? '').split(',').filter(Boolean))
        setFrom(route.from ?? '')
        setTo(route.to ?? '')
        setPriorSeasons(route.priorSeasons === 'true')
        setTimePicker(undefined)
        setFilter(true)
      })
      .catch(() => undefined)
  }
  // A read of the held rows that failed leaves them on show, as they were.
  const shownError =
    error !== '' || list.error == null
      ? error
      : list.error instanceof Error
        ? list.error.message
        : 'Please try again.'
  const filterError =
    umpireFilterError({
      days,
      from: from === '' ? undefined : from,
      to: to === '' ? undefined : to
    }) ??
    ((from === '') !== (to === '')
      ? 'Choose both a start and an end time.'
      : null)
  const applied = appliedAvailability(
    route,
    schedule?.levels.map(level => level.id)
  )
  const showSaveFilter =
    saved?.league === route.id &&
    saved.failed !== true &&
    availabilityDiffers(applied, saved.availability)
  const saveFilter = (): void => {
    const league = route.id
    const body = isEmptyAvailability(applied) ? null : applied
    setSavingFilter(true)
    run(async () => {
      try {
        const availability = await client.saveUmpireAvailability(league, body)
        if (live()) setSaved({ league, availability })
      } finally {
        // One flag for the whole screen, cleared whichever league is shown
        // when the save answers.
        setSavingFilter(false)
      }
    }, true)
  }
  const [noteErrorHeight, setNoteErrorHeight] = useState(0)
  const games = list.rows
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
      list.update(cell.game, g => ({
        ...g,
        umpireNotes: { ...g.umpireNotes, [cell.type]: value }
      }))
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
  // Each page brings the whole list's columns again: the same columns keep
  // one identity, so that the rows are not drawn again for them.
  const positionsText = JSON.stringify(schedule?.positions ?? [])
  const positions = useMemo(
    () => JSON.parse(positionsText) as UmpireSchedulePage['positions'],
    [positionsText]
  )
  const columnWidth = Math.ceil(dateWidth + theme.rem(1))
  const roleWidth = Math.ceil(signupWidth + theme.rem(2))
  const conflictsWidth = Math.ceil(conflictWidth + theme.rem(0.75) + 1)
  const noteTypesText = JSON.stringify(schedule?.noteTypes ?? [])
  const noteTypes = useMemo(
    () => JSON.parse(noteTypesText) as UmpireSchedulePage['noteTypes'],
    [noteTypesText]
  )
  const customWidth = Math.max(
    160,
    tableWidth / (7 + positions.length + noteTypes.length)
  )
  const rowWidth =
    6 * columnWidth +
    positions.length * roleWidth +
    noteTypes.length * customWidth +
    conflictsWidth
  const editing = noteEditor.editing
  const alwaysRenderKeys = useMemo(
    () => (editing == null ? [] : [editing]),
    [editing]
  )
  const view = schedule?.view
  const isAdmin = schedule?.isAdmin
  const noteCell = noteEditor.cell
  const renderRow = useCallback(
    (game: UmpireGameRow): React.ReactElement => {
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
          return (
            <Pressable
              disabled={busy}
              accessibilityRole="button"
              accessibilityLabel={`${assignment.name}, ${slot}`}
              onPress={() => {
                setOpened({ game, slot })
              }}
            >
              <TickerText style={[s.tableText, { color: '#1565C0' }]}>
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
            disabled={view === 'league' || busy}
            color="#EEEEEE"
            textColor="#616161"
            onPress={() => {
              setSignup({ game, slot })
            }}
          />
        )
      }
      return (
        <View
          testID={`umpire-game-${game.id}`}
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
                          game.location == null || game.location === ''
                            ? game.venue
                            : game.location
                        )
                      )
                    })
                  }
            )}
          </UmpireCell>
          <UmpireCell divided compact width={columnWidth}>
            <Text numberOfLines={2} style={s.tableText}>
              {game.field}
            </Text>
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
                !game.positions.some(position => position.slot === p.slot) ||
                (game.status === 'final' && game.assignments[p.slot] == null)
              }
            >
              {cell(game, p.slot)}
            </UmpireCell>
          ))}
          {noteTypes.map(t => (
            <UmpireCell divided compact key={t.id} width={customWidth}>
              {noteCell(game, t)}
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
      )
    },
    [
      busy,
      columnWidth,
      conflictsWidth,
      customWidth,
      isAdmin,
      noteCell,
      noteTypes,
      onOpenGame,
      onOpenTeam,
      positions,
      roleWidth,
      run,
      s,
      view
    ]
  )
  // A mounted row is drawn again only for a new item or this.
  const rowsRead = useMemo(
    () => ({
      busy,
      columnWidth,
      roleWidth,
      customWidth,
      conflictsWidth,
      positions,
      noteTypes,
      view,
      isAdmin,
      noteCell
    }),
    [
      busy,
      columnWidth,
      conflictsWidth,
      customWidth,
      isAdmin,
      noteCell,
      noteTypes,
      positions,
      roleWidth,
      view
    ]
  )
  return (
    <StickySectionLayout
      wide
      pagedList
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
                        days: undefined,
                        from: undefined,
                        to: undefined,
                        timezone: undefined,
                        priorSeasons: undefined
                      })
                  }}
                >
                  <GroupEmblem
                    kind="league"
                    id={l.id}
                    name={l.name}
                    uri={l.logoUrl}
                    size={3}
                  />
                  <Text style={s.text}>{l.name}</Text>
                </Pressable>
              ))}
            </ScrollView>
          )}
          <UmpireError error={shownError} />
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
                    if (noteEditor.discard()) setRevision(n => n + 1)
                  }}
                />
              )}
            </View>
          </View>
          {schedule != null && route.pill !== 'leaderboard' && (
            <View
              testID="umpire-filter-row"
              style={{
                flexDirection: 'row',
                flexWrap: 'wrap',
                alignItems: 'center',
                gap: theme.rem(1)
              }}
            >
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
              {showSaveFilter && (
                <Button
                  label={lstrings.umpire_save_filter}
                  icon="bookmark"
                  accessibilityLabel={lstrings.umpire_save_filter_named}
                  compact
                  kind="secondary"
                  testID="umpire-save-filter"
                  busy={savingFilter}
                  onPress={saveFilter}
                />
              )}
            </View>
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
          <View style={chatRow}>
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
              style={umpireChat == null ? undefined : { flexGrow: 0 }}
            />
            {umpireChat != null && onOpenChat != null && (
              <View style={chatPill}>
                <PillButton
                  testID="umpire-chat"
                  label={lstrings.umpire_chat}
                  accessibilityLabel={lstrings.umpire_chat_open}
                  selected={false}
                  onPress={() => {
                    onOpenChat(umpireChat)
                  }}
                />
              </View>
            )}
          </View>
          {schedule != null && route.pill !== 'leaderboard' && (
            <ScrollView
              horizontal
              ref={headerScroll}
              testID="umpire-table-header-scroll"
              showsHorizontalScrollIndicator={false}
              scrollEventThrottle={16}
              onScrollBeginDrag={() => {
                horizontalLeader.current = 'header'
              }}
              onScroll={e => {
                syncHorizontal('header', e.nativeEvent.contentOffset.x)
              }}
            >
              <View testID="umpire-table-header" style={s.tableRow}>
                {[
                  'Date',
                  'Home team',
                  'Away team',
                  'Venue',
                  'Field',
                  'Notes'
                ].map(label => (
                  <UmpireCell divided compact key={label} width={columnWidth}>
                    <Text style={[s.tableText, s.tableHeading]}>{label}</Text>
                  </UmpireCell>
                ))}
                {positions.map(p => (
                  <UmpireCell divided compact key={p.slot} width={roleWidth}>
                    <Text style={[s.tableText, s.tableHeading]}>
                      {umpirePositionName(p, positions)}
                    </Text>
                    {p.optionalHeader != null && (
                      <Text style={s.tableHint}>{p.optionalHeader}</Text>
                    )}
                  </UmpireCell>
                ))}
                {noteTypes.map(t => (
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
      <ReaderMoved onMoved={noteReaderMoved} />
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
            <PagedListStart list={list} />
            <ScrollView
              horizontal
              ref={bodyScroll}
              testID="umpire-table-body-scroll"
              keyboardShouldPersistTaps="handled"
              scrollEventThrottle={16}
              onScrollBeginDrag={() => {
                horizontalLeader.current = 'body'
              }}
              onScroll={e => {
                syncHorizontal('body', e.nativeEvent.contentOffset.x)
              }}
            >
              <PagedList
                data={list.rows}
                keyOf={gameId}
                renderItem={renderRow}
                extraData={rowsRead}
                width={rowWidth}
                estimatedItemSize={ROW_HEIGHT}
                alwaysRenderKeys={alwaysRenderKeys}
                anchorKey={list.anchorId}
                onAnchorPosition={setFirstY}
                onEndReached={() => {
                  list.loadMore().catch(() => undefined)
                }}
                onStartReached={atRest => {
                  list.loadOlder(atRest).catch(() => undefined)
                }}
              />
            </ScrollView>
            <PagedListEnd list={list} />
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
          <Text
            testID="umpire-date-measure"
            style={s.tableText}
            numberOfLines={1}
            onLayout={e => {
              const width = e.nativeEvent.layout.width
              setDateWidth(w => Math.max(w, width))
            }}
          >
            {LONGEST_DATE}
          </Text>
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
      {opened != null && (
        <ChoiceSheet
          linkCancel
          title={opened.game.assignments[opened.slot].displayName}
          onClose={() => {
            setOpened(undefined)
          }}
          choices={[
            {
              label: 'Go to profile page',
              link: true,
              onPress: () => {
                const assignment = opened.game.assignments[opened.slot]
                onOpenPerson?.(assignment.userId, assignment.displayName)
              }
            },
            ...(assignmentRemovable(
              opened.game.assignments[opened.slot],
              opened.game,
              schedule?.isAdmin === true
            )
              ? [
                  {
                    label: 'Remove assignment',
                    destructive: true,
                    onPress: () => {
                      const gameId = opened.game.id
                      const slot = opened.slot
                      run(async () => {
                        await client.removeUmpire(gameId, slot)
                        if (live()) refresh()
                      })
                    }
                  }
                ]
              : [])
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
              const nextFrom = from === '' ? undefined : from
              const nextTo = to === '' ? undefined : to
              // A saved filter's zone stays while its days and range are as
              // they were; a changed day or time is read in the device's.
              const timeKept =
                sameList(days, routeDays(route)) &&
                nextFrom === route.from &&
                nextTo === route.to
              change({
                days: days.length === 0 ? undefined : days.join(','),
                levels: levels.length === 0 ? undefined : levels.join(','),
                from: nextFrom,
                to: nextTo,
                timezone: timeKept ? route.timezone : undefined,
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
