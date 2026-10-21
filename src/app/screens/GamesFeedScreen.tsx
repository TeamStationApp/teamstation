import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Text, useWindowDimensions, View } from 'react-native'

import type { SeasonGame, TeamStationClient } from '../../common/api'
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
  useHeaderSlot
} from '../components'
import {
  PillBand,
  PinnedContent,
  PinnedSpacer
} from '../components/PinnedBands'
import { usePinnedTabs } from '../components/usePinnedTabs'
import { useForegroundRefresh } from '../hooks/useForegroundRefresh'
import { useLatestRequest } from '../hooks/useLatestRequest'
import { useScreenScope } from '../hooks/useScreenScope'
import { columnsForWidth } from '../layout/grid'
import { gameCountLabel, videoCountLabel } from '../locales/strings'
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

const WHEN_TABS = [
  { id: 'upcoming' as const, label: 'Upcoming' },
  { id: 'past' as const, label: 'Past' },
  { id: 'all' as const, label: 'All' }
]

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
  const { width } = useWindowDimensions()
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
  const [games, setGames] = useState<SeasonGame[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)
  const { pinned, selectTab } = usePinnedTabs({
    head: { headerHeight, handoff },
    ready: mode === 'schedule' && !loading,
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

  const beginGames = useLatestRequest()
  const loadGames = useCallback(async (): Promise<void> => {
    const current = beginGames()
    try {
      const all = await client.games(
        mode === 'schedule' && when !== 'all' ? { when } : {}
      )
      if (current()) {
        setGames(all)
        setError(undefined)
      }
    } catch (caught) {
      if (current())
        setError(caught instanceof Error ? caught.message : 'Cannot load')
    } finally {
      if (current()) setLoading(false)
    }
  }, [client, mode, when, beginGames])
  // Schedule waits for its scope's acknowledgement before it reads. Videos
  // takes no scope, so it reads at once.
  useForegroundRefresh(useScreenScope(loadGames, client))

  // Videos offers no filter. Nothing that has not been played can have a
  // recording, so `Upcoming` was always empty and `Past` was always the whole
  // list — three pills to choose between one answer and two empty ones.
  const sorted =
    mode === 'videos'
      ? games
          .filter(game => game.videoCount > 0)
          .sort(
            (a, b) => Date.parse(b.startAt ?? '') - Date.parse(a.startAt ?? '')
          )
      : gamesFor(games, when)

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

      <PinnedContent key={`${mode}-${when}`} part={pinned.content}>
        <View ref={handoff.ref}>
          <SectionHeader
            title={mode === 'videos' ? 'Game videos' : 'Schedule'}
            note={gameCountLabel(sorted.length)}
          />
        </View>

        {error != null && <Text style={styles.error}>{error}</Text>}
        {loading && <Text style={styles.muted}>Loading…</Text>}

        {!loading && sorted.length === 0 && (
          <Card>
            <Text style={styles.muted}>
              {mode === 'videos'
                ? 'No recorded games here yet.'
                : 'No games here yet.'}
            </Text>
          </Card>
        )}

        {/*
        A grid on a wide window, one column on a phone. Reading order is left
        to right and then down, newest first, which is how somebody looks for
        last night's game.
      */}
        <View style={styles.grid}>
          {sorted.map(game => {
            const lines = matchupLines(game)
            const options = gameListOptions(game, mode)
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
                            : game.isLive
                              ? 'live'
                              : game.awayScore == null
                                ? undefined
                                : `${game.awayScore}–${game.homeScore}`
                      }
                      badgeTone={
                        game.isLive && !game.pendingApproval
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
        <View />
      </PinnedContent>
      {mode === 'schedule' && <PinnedSpacer part={pinned.spacer} />}
    </Screen>
  )
}

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
