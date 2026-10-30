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
  asPage,
  asSeasonGame,
  type ListCounts,
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
import { PagedList } from '../components/PagedList'
import { PagedListEnd } from '../components/PagedListEnd'
import {
  PillBand,
  PinnedContent,
  PinnedSpacer
} from '../components/PinnedBands'
import { ActiveView, TabPages } from '../components/TabPages'
import { usePinnedTabs } from '../components/usePinnedTabs'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import { type PagedRows, usePagedList } from '../hooks/usePagedList'
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
import { countFor, type When } from './whenFilter'

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

/** A row's height before it has been measured, as each list draws them. */
const ROW_HEIGHT = { schedule: 140, videos: 130 }

const gameId = (game: SeasonGame): string => game.id

/** When each list last had its first page from the server. */
type AnsweredAt = Partial<Record<When, number>>

/** One list of the feed, read when the screen says so. */
function useGamesList(
  client: TeamStationClient,
  mode: GamesFeedScreenProps['mode'],
  when: When,
  answered: React.RefObject<AnsweredAt>
): PagedRows<SeasonGame> {
  return usePagedList<SeasonGame>({
    listKey: `${mode}-${when}`,
    auto: false,
    keyOf: gameId,
    read: async cursor => {
      const page = await client.gamesPage({
        ...(mode === 'videos'
          ? { hasVideo: true }
          : when === 'all'
            ? {}
            : { when }),
        ...(cursor == null ? {} : { cursor })
      })
      if (cursor == null) answered.current[when] = Date.now()
      return page
    }
  })
}

/** How many games a list holds in all, whichever of them are loaded. */
function countOf(
  counts: ListCounts,
  mode: GamesFeedScreenProps['mode'],
  when: When
): number {
  return mode === 'videos' ? counts.withVideo : countFor(counts, when)
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
    if (initialWhen != null) setWhen(initialWhen)
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
  // under the slide when the read for the new one returns. A failed read
  // stays on its own pill for the same reason.
  const answered = useRef<AnsweredAt>({})
  const lists: Record<When, PagedRows<SeasonGame>> = {
    upcoming: useGamesList(client, mode, 'upcoming', answered),
    past: useGamesList(client, mode, 'past', answered),
    all: useGamesList(client, mode, 'all', answered)
  }
  const list: When = mode === 'schedule' ? when : 'all'
  const games = lists[list]
  const { refresh: readGames, paint } = games
  const { pinned, selectTab } = usePinnedTabs({
    head: { headerHeight, handoff },
    ready: mode === 'schedule' && !games.loading,
    tab: when,
    anchorOnRow: false
  })
  const choose = useCallback(
    (next: When): void => {
      selectTab(next)
      setWhen(next)
      onWhenChange?.(next)
    },
    [onWhenChange, selectTab]
  )

  // A pill chosen again shows the list it kept, and reads it again only when
  // the server last answered for it over half a minute ago: a long list
  // read, checked and stored on every change of pill would hold the next tap
  // up. A read that failed answered nothing, so the pill reads at once. The
  // half-minute refresh and a return to the app still read it. A scope notice
  // reads only the pill on show, so one that came while this pill was hidden
  // reaches it within the half minute.
  const shownList = useRef<When | undefined>(undefined)
  const loadGames = useCallback(async (): Promise<void> => {
    await readGames()
  }, [readGames])
  /** The list as the phone last stored it, until the read returns. */
  const paintGames = useCallback(async (): Promise<void> => {
    const stored = await client.cached(
      gamesKey(mode === 'videos' ? 'videos' : list),
      asPage(asSeasonGame)
    )
    if (stored != null) paint(stored)
  }, [client, list, mode, paint])
  // Schedule waits for its scope's acknowledgement before it reads. Videos
  // takes no scope, so it reads at once.
  const scoped = useScreenScope(loadGames, client, paintGames)
  const listsNow = useRef(lists)
  listsNow.current = lists
  const refresh = useCallback(async (): Promise<void> => {
    const shown = shownList.current
    const chosen = shown !== list
    shownList.current = list
    // A pill new to this screen slides in what the phone has stored, until
    // the read returns: the screen's scope paints only as it enters.
    if (chosen && shown != null && listsNow.current[list].loading)
      paintGames().catch(() => undefined)
    const last = answered.current[list]
    if (chosen && last != null && Date.now() - last < REREAD_MS) return
    await scoped()
  }, [list, paintGames, scoped])
  useForegroundRefresh(refresh)

  // The latest handler, under one identity, which leaves the cards as drawn.
  const open = useStableCallback(onOpenGame)

  return (
    <Screen
      {...(mode === 'schedule'
        ? pinned.screen
        : { onScroll: handoff.handleScroll })}
      pagedList
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
              note={
                games.counts == null
                  ? undefined
                  : gameCountLabel(countOf(games.counts, mode, list))
              }
            />
          </ActiveView>

          {games.error != null && (
            <Text style={styles.error}>
              {games.error instanceof Error
                ? games.error.message
                : 'Cannot load'}
            </Text>
          )}
          <GameCards
            list={games}
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
  list: PagedRows<SeasonGame>
  mode: GamesFeedScreenProps['mode']
  columns: number
  narrow: boolean
  offline: boolean
  onOpenGame: GamesFeedScreenProps['onOpenGame']
}): React.ReactElement {
  const { list, mode, columns, narrow, offline, onOpenGame } = props
  const { rows, loading, empty, loadMore } = list
  const styles = getStyles(useTheme())
  const renderRow = useCallback(
    (game: SeasonGame) => (
      <GameCardRow
        game={game}
        mode={mode}
        narrow={narrow}
        offline={offline}
        onOpenGame={onOpenGame}
      />
    ),
    [mode, narrow, offline, onOpenGame]
  )
  const extraData = useMemo(() => ({ narrow, offline }), [narrow, offline])
  const readOn = useCallback(() => {
    loadMore().catch(() => undefined)
  }, [loadMore])
  return (
    <View style={styles.grid}>
      <PagedList
        data={rows}
        keyOf={gameId}
        renderItem={renderRow}
        extraData={extraData}
        numColumns={columns}
        estimatedItemSize={ROW_HEIGHT[mode]}
        // A list that could not be read says so above, and does not spin.
        empty={
          loading ? (
            <ActivityIndicator
              accessibilityLabel="Loading games"
              style={styles.loading}
            />
          ) : empty ? (
            <View style={styles.cell}>
              <Card>
                <Text style={styles.muted}>
                  {mode === 'videos'
                    ? 'No recorded games here yet.'
                    : 'No games here yet.'}
                </Text>
              </Card>
            </View>
          ) : null
        }
        footer={<PagedListEnd list={list} />}
        onEndReached={readOn}
      />
    </View>
  )
}

/**
 * One card, drawn again only when what it shows changes: a page of rows
 * arriving, or a row's refresh, leaves the others as they are.
 */
const GameCardRow = memo(function GameCardRow(props: {
  game: SeasonGame
  mode: GamesFeedScreenProps['mode']
  narrow: boolean
  offline: boolean
  onOpenGame: GamesFeedScreenProps['onOpenGame']
}): React.ReactElement {
  const { game, mode, narrow, offline, onOpenGame } = props
  const styles = getStyles(useTheme())
  const lines = matchupLines(game)
  const unplayable = offline && game.isLive
  const listed = gameListOptions(game, mode)
  const options =
    listed == null || !unplayable ? listed : { ...listed, autoPlay: false }
  return (
    <View style={styles.cell}>
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
              game.durationSec == null ? undefined : clock(game.durationSec)
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
})

const getStyles = cacheStyles((theme: Theme) => ({
  // Left, not centred: the pills are what you reach for from up there, and a
  // row of three centred under a back chevron reads as a title.
  grid: {
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
