import { asArray } from 'cleaners'
import React, {
  memo,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import { ActivityIndicator, Text, View } from 'react-native'

import {
  asSeasonGame,
  type SeasonGame,
  type TeamStationClient
} from '../../common/api'
import {
  Card,
  GameRow,
  HandoffView,
  PillTabs,
  ScheduleRow,
  Screen,
  SectionHeader,
  useBreakpoint,
  useHandoff,
  useHeaderHandoff,
  useHeaderSlot,
  usePaneWidth
} from '../components'
import {
  PillBand,
  PinnedContent,
  PinnedSpacer
} from '../components/PinnedBands'
import { ActiveView, TabPages } from '../components/TabPages'
import { usePinnedTabs } from '../components/usePinnedTabs'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { useScreenScope } from '../hooks/useScreenScope'
import { useStableCallback } from '../hooks/useStableCallback'
import { columnsForWidth } from '../layout/grid'
import { gameCountLabel, videoCountLabel } from '../locales/strings'
import { gamesKey } from '../sync/documentKeys'
import { OFFLINE_UNPLAYABLE, usePhoneOffline } from '../sync/useOffline'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  clock,
  matchupLines,
  shortDate,
  shortDateNoWeekday,
  shortTime
} from './format'
import { type GameListOpenOptions, gameListOptions } from './gameListOptions'
import { gamesFor, type When } from './whenFilter'

export interface GamesFeedScreenProps {
  client: TeamStationClient
  /** `videos` shows only what was recorded; `schedule` shows everything. */
  mode: 'videos' | 'schedule'
  /** The filter the address asked for, if any. */
  initialWhen?: When
  /** Tells the shell, so the address can say which filter is showing. */
  onWhenChange?: (when: When) => void
  onOpenGame: (
    gameId: string,
    title: string,
    options?: GameListOpenOptions
  ) => void
}

/** How old a pill's list may be and still be shown again unread. */
const REREAD_MS = 30_000

const WHEN_TABS = [
  { id: 'upcoming' as const, label: 'Upcoming' },
  { id: 'past' as const, label: 'Past' },
  { id: 'all' as const, label: 'All' }
]

/**
 * Whether two reads of a list hold the same games, as drawn: game by game,
 * stopping at the first that differs, rather than writing out both lists
 * whole on every read.
 */
function sameGames(
  a: readonly SeasonGame[],
  b: readonly SeasonGame[]
): boolean {
  if (a.length !== b.length) return false
  for (let index = 0; index < a.length; index++)
    if (
      a[index] !== b[index] &&
      JSON.stringify(a[index]) !== JSON.stringify(b[index])
    )
      return false
  return true
}

/**
 * Every game the signed-in person may see, across all their seasons.
 *
 * Two of the four destinations are this screen with a different filter —
 * Videos is the games that were recorded, Schedule is all of them — so they
 * are one component. Drawing them separately is how two lists of the same
 * thing end up sorted differently and formatting dates two ways.
 *
 * Videos defaults to what has already happened, because a recording of a game
 * that has not been played does not exist. Schedule defaults to what is
 * coming, because that is the question being asked.
 */
export function GamesFeedScreen(
  props: GamesFeedScreenProps
): React.ReactElement {
  const { client, mode, initialWhen, onWhenChange, onOpenGame } = props
  const styles = getStyles(useTheme())
  const narrow = useBreakpoint() === 'phone'
  const width = usePaneWidth()
  // Videos widens into a grid; the schedule stays a single column, where the
  // eye runs down a list of dates rather than across a wall of pictures.
  const columns = mode === 'videos' ? columnsForWidth(width) : 1

  // Videos opens on what has happened. Schedule opens on what is coming,
  // which is the question that tab is for.
  const [when, setWhen] = useState<When>(
    initialWhen ?? (mode === 'schedule' ? 'upcoming' : 'past')
  )
  // The shell can change the address — Back, or a sign-in next link — while
  // this screen stays mounted. The pills and the list follow that address.
  useEffect(() => {
    if (initialWhen == null) return
    setWhen(initialWhen)
    // The last pill's failure is not this one's, as when a pill is chosen.
    setError(undefined)
  }, [initialWhen])
  // Navigation stays below the header; its title hands up as the page scrolls.
  const { headerHeight } = useHeaderSlot()
  const handoff = useHandoff(headerHeight)
  const progress = handoff.progress
  useHeaderHandoff(
    useMemo(
      () => (
        <HandoffView progress={progress} style={styles.headerPills}>
          <Text style={styles.headerTitle}>
            {mode === 'videos' ? 'Game videos' : 'Schedule'}
          </Text>
        </HandoffView>
      ),
      [mode, progress, styles.headerPills, styles.headerTitle]
    )
  )
  // The phone's copy of a stream that was live cannot be played offline:
  // no playback address or video is kept.
  const offline = usePhoneOffline(client)
  // Each filter's own list, as the server last gave it: a pill's page is
  // drawn from its own games, never filtered out of another pill's, so a
  // change of pill slides in what that pill shows at once (the phone's stored
  // copy, then the server's) rather than the last pill's games, replaced
  // under the slide when the read for the new one returns.
  const list: When = mode === 'schedule' ? when : 'all'
  const [lists, setLists] = useState<Partial<Record<When, SeasonGame[]>>>({})
  const [error, setError] = useState<string | undefined>(undefined)
  const games = lists[list]
  const loading = games == null && error == null
  /** A list kept, unless it holds what is already there: no redraw then. */
  const keep = useCallback(
    (key: When, next: SeasonGame[], over: boolean): void => {
      setLists(held => {
        const kept = held[key]
        if (kept != null && (!over || sameGames(kept, next))) return held
        return { ...held, [key]: next }
      })
    },
    []
  )
  const { pinned, selectTab } = usePinnedTabs({
    head: { headerHeight, handoff },
    ready: mode === 'schedule' && !loading,
    tab: when,
    anchorOnRow: false
  })
  const choose = useCallback(
    (next: When): void => {
      selectTab(next)
      // The last pill's failure is not this one's: it loads afresh.
      setError(undefined)
      setWhen(next)
      onWhenChange?.(next)
    },
    [onWhenChange, selectTab]
  )

  // A pill chosen again shows the list it kept, and reads it again only when
  // the server last answered for it over half a minute ago: a long list
  // read, checked and stored on every change of pill would hold the next tap
  // up. A read that failed, or was dropped for a later one, answered nothing,
  // so the pill reads at once. The half-minute refresh and a return to the
  // app still read it. A scope notice reads only the pill on show, so one
  // that came while this pill was hidden reaches it within the half minute.
  const read = useRef<{ list?: When; at: Partial<Record<When, number>> }>({
    at: {}
  })
  const beginGames = useLatestRequest()
  const loadGames = useCallback(async (): Promise<void> => {
    const current = beginGames()
    try {
      const all = await client.games(list === 'all' ? {} : { when: list })
      if (current()) {
        keep(list, all, true)
        setError(undefined)
        read.current.at[list] = Date.now()
      }
    } catch (caught) {
      if (current())
        setError(caught instanceof Error ? caught.message : 'Cannot load')
    }
  }, [client, list, beginGames, keep])
  /** The list as the phone last stored it, until the read returns. */
  const paintGames = useCallback(async (): Promise<void> => {
    const current = beginGames()
    const stored = await client.cached(gamesKey(list), asArray(asSeasonGame))
    // Under what the server already gave, never over it.
    if (current() && stored != null) keep(list, stored, false)
  }, [client, list, beginGames, keep])
  // Schedule waits for its scope's acknowledgement before it reads. Videos
  // takes no scope, so it reads at once.
  const scoped = useScreenScope(loadGames, client, paintGames)
  const refresh = useCallback(async (): Promise<void> => {
    const held = read.current
    const chosen = held.list !== list
    held.list = list
    const last = held.at[list]
    if (chosen && last != null && Date.now() - last < REREAD_MS) {
      // Not read again, but the last pill's read is not this pill's: one
      // still on its way must not land its failure, or its list, here.
      beginGames()
      return
    }
    await scoped()
  }, [list, scoped, beginGames])
  useForegroundRefresh(refresh)

  // Videos offers no filter. Nothing that has not been played can have a
  // recording, so `Upcoming` was always empty and `Past` was always the whole
  // list — three pills to choose between one answer and two empty ones.
  // Arranged once per pill and list, so a pill chosen again hands its cards
  // the same games, and they are not drawn again.
  const arranged = useMemo(
    () => new Map<When, { games: SeasonGame[]; sorted: SeasonGame[] }>(),
    // A new mode arranges the same lists another way.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [mode]
  )
  let sorted: SeasonGame[] | undefined
  if (games != null) {
    const held = arranged.get(when)
    if (held?.games === games) sorted = held.sorted
    else {
      sorted =
        mode === 'videos'
          ? games
              .filter(game => game.videoCount > 0)
              .sort(
                (a, b) =>
                  Date.parse(b.startAt ?? '') - Date.parse(a.startAt ?? '')
              )
          : gamesFor(games, when)
      arranged.set(when, { games, sorted })
    }
  }
  // The latest handler, under one identity, which leaves the cards as drawn.
  const open = useStableCallback(onOpenGame)

  return (
    <Screen
      {...(mode === 'schedule'
        ? pinned.screen
        : { onScroll: handoff.handleScroll })}
      // Videos lays its cards out in up to four columns, so it keeps the
      // margins and loses the reading-width cap: a cap made for a line of text
      // would hold a grid of pictures to two columns on any monitor.
      wide={mode === 'videos'}
    >
      {mode === 'schedule' && (
        <PillBand part={pinned.pillBand}>
          <PillTabs
            tabs={WHEN_TABS}
            selected={when}
            onSelect={choose}
            size="compact"
          />
        </PillBand>
      )}

      {/* A pill's page stays built, so a pill chosen again slides in at once. */}
      <TabPages
        keep
        page={`${mode}-${when}`}
        index={WHEN_TABS.findIndex(item => item.id === when)}
      >
        <PinnedContent key={`${mode}-${when}`} part={pinned.content}>
          <ActiveView ref={handoff.ref}>
            <SectionHeader
              title={mode === 'videos' ? 'Game videos' : 'Schedule'}
              note={sorted == null ? undefined : gameCountLabel(sorted.length)}
            />
          </ActiveView>

          {error != null && <Text style={styles.error}>{error}</Text>}
          <GameCards
            games={sorted}
            failed={error != null}
            mode={mode}
            columns={columns}
            narrow={narrow}
            offline={offline}
            onOpenGame={open}
          />
          <View />
        </PinnedContent>
      </TabPages>
      {mode === 'schedule' && <PinnedSpacer part={pinned.spacer} />}
    </Screen>
  )
}

/**
 * The games as cards: a grid on a wide window, one column on a phone.
 * Reading order is left to right and then down, newest first, which is how
 * somebody looks for last night's game.
 * A spinner until the games are in.
 */
function GameCards(props: {
  games: SeasonGame[] | undefined
  failed: boolean
  mode: GamesFeedScreenProps['mode']
  columns: number
  narrow: boolean
  offline: boolean
  onOpenGame: GamesFeedScreenProps['onOpenGame']
}): React.ReactElement | null {
  const { games, failed, mode, columns, narrow, offline, onOpenGame } = props
  const styles = getStyles(useTheme())
  if (games == null) {
    // A list that could not be read says so above, and does not spin.
    if (failed) return null
    return (
      <ActivityIndicator
        accessibilityLabel="Loading games"
        style={styles.loading}
      />
    )
  }
  if (games.length === 0)
    return (
      <Card>
        <Text style={styles.muted}>
          {mode === 'videos'
            ? 'No recorded games here yet.'
            : 'No games here yet.'}
        </Text>
      </Card>
    )
  return (
    <CardGrid
      games={games}
      mode={mode}
      columns={columns}
      narrow={narrow}
      offline={offline}
      onOpenGame={onOpenGame}
    />
  )
}

/**
 * The cards themselves, drawn again only when what they show changes: a
 * pill's page drawn again as it comes back leaves them as they are.
 */
const CardGrid = memo(function CardGrid(props: {
  games: SeasonGame[]
  mode: GamesFeedScreenProps['mode']
  columns: number
  narrow: boolean
  offline: boolean
  onOpenGame: GamesFeedScreenProps['onOpenGame']
}): React.ReactElement {
  const { games, mode, columns, narrow, offline, onOpenGame } = props
  const styles = getStyles(useTheme())
  return (
    <View style={styles.grid}>
      {games.map(game => {
        const lines = matchupLines(game)
        const unplayable = offline && game.isLive
        const listed = gameListOptions(game, mode)
        const options =
          listed == null || !unplayable
            ? listed
            : { ...listed, autoPlay: false }
        return (
          <View
            key={game.id}
            style={[styles.cell, { width: `${100 / columns}%` }]}
          >
            <Card>
              {mode === 'schedule' ? (
                <ScheduleRow
                  first={lines.first}
                  second={lines.second}
                  startAt={game.startAt}
                  isGameLive={game.isGameLive}
                  isUmpire={game.isUmpire}
                  venue={game.venue}
                  status={game.status}
                  awayScore={game.awayScore}
                  homeScore={game.homeScore}
                  isLive={game.isLive}
                  videoCount={game.videoCount}
                  pendingApproval={game.pendingApproval}
                  cancellationReason={game.cancellationReason}
                  withdrawnByTeamName={game.withdrawnByTeamName}
                  onPress={
                    options == null
                      ? undefined
                      : () => {
                          onOpenGame(
                            game.id,
                            [lines.first, lines.second]
                              .filter(line => line !== '')
                              .join(' '),
                            options
                          )
                        }
                  }
                />
              ) : (
                <GameRow
                  first={lines.first}
                  second={lines.second}
                  detail={[
                    narrow
                      ? shortDateNoWeekday(game.startAt)
                      : shortDate(game.startAt),
                    shortTime(game.startAt),
                    videoCountLabel(game.videoCount)
                  ]
                    .filter(part => part !== '')
                    .join(' · ')}
                  venue={game.venue}
                  posterUrl={game.posterUrl}
                  length={
                    game.durationSec == null
                      ? undefined
                      : clock(game.durationSec)
                  }
                  badgeLabel={
                    game.pendingApproval
                      ? 'Pending approval'
                      : game.status === 'cancelled'
                        ? 'Canceled'
                        : unplayable
                          ? OFFLINE_UNPLAYABLE
                          : game.isLive
                            ? 'live'
                            : game.awayScore == null
                              ? undefined
                              : `${game.awayScore}–${game.homeScore}`
                  }
                  badgeTone={
                    game.isLive && !game.pendingApproval && !unplayable
                      ? 'live'
                      : 'neutral'
                  }
                  onPress={
                    options == null
                      ? undefined
                      : () => {
                          onOpenGame(
                            game.id,
                            [lines.first, lines.second]
                              .filter(line => line !== '')
                              .join(' '),
                            options
                          )
                        }
                  }
                />
              )}
            </Card>
          </View>
        )
      })}
    </View>
  )
})

const getStyles = cacheStyles((theme: Theme) => ({
  // Left, not centred: the pills are what you reach for from up there, and a
  // row of three centred under a back chevron reads as a title.
  grid: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    // The gap is on the cells, so a row of one and a row of four have the same
    // margins as everything else on the screen.
    marginHorizontal: theme.rem(-theme.spaceXsRem)
  },
  cell: {
    paddingHorizontal: theme.rem(theme.spaceXsRem),
    paddingBottom: theme.rem(theme.spaceSmRem)
  },
  headerTitle: {
    color: theme.headerTextColor,
    fontFamily: theme.boldTextFont,
    fontSize: theme.rem(1.125),
    fontWeight: '700'
  },
  headerPills: {
    alignItems: 'flex-start'
  },
  // `PillTabs` insets its row so a pressed pill has somewhere to grow, which
  // here would leave `Past` standing off the mark by that much more than
  // `Your Home` does on the home screen. Pulled back by the same amount, so
  // what the eye sees — the edge of the pill, not the edge of its row — sits
  // on the margin the mark sits on.
  headerPillsRow: {
    marginLeft: theme.rem(-theme.spaceXsRem)
  },
  loading: {
    paddingVertical: theme.rem(theme.spaceLgRem)
  },
  muted: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.9375),
    color: theme.secondaryTextColor
  },
  error: {
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875),
    color: theme.dangerColor
  }
}))
