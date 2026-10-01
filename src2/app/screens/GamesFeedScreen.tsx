import React, { useCallback, useEffect, useMemo, useState } from 'react'
import { Text, useWindowDimensions, View } from 'react-native'

import type { GameStationClient, SeasonGame } from '../../common/api'
import {
  Card,
  GameRow,
  HandoffView,
  PillTabs,
  Screen,
  SectionHeader,
  useBreakpoint,
  useHandoff,
  useHeaderHandoff,
  useHeaderSlot
} from '../components'
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
import { gamesFor, type When } from './whenFilter'

export interface GamesFeedScreenProps {
  client: GameStationClient
  /** `videos` shows only what was recorded; `schedule` shows everything. */
  mode: 'videos' | 'schedule'
  /** The filter the address asked for, if any. */
  initialWhen?: When
  /** Tells the shell, so the address can say which filter is showing. */
  onWhenChange?: (when: When) => void
  onOpenGame: (
    gameId: string,
    title: string,
    options?: { tab?: 'watch' | 'boxScore'; autoPlay?: boolean }
  ) => void
}

const WHEN_TABS = [
  { id: 'past' as const, label: 'Past' },
  { id: 'upcoming' as const, label: 'Upcoming' },
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

  // Both lists open on what has happened. A schedule of fixtures is the
  // rarer question; what somebody opens the app for is the game just played.
  const [when, setWhen] = useState<When>(initialWhen ?? 'past')
  // The filter row slides into the header as it goes under, and still filters
  // from up there: it is the same component with the same handler, not a
  // second row that would drift the day a fourth filter is added. This screen
  // has no title in the header — the pills say which list you are looking at
  // better than the word `Videos` does.
  const { headerHeight } = useHeaderSlot()
  const handoff = useHandoff(headerHeight)
  const choose = useCallback(
    (next: When): void => {
      setWhen(next)
      onWhenChange?.(next)
    },
    [onWhenChange]
  )
  const progress = handoff.progress
  useHeaderHandoff(
    useMemo(
      () => (
        <HandoffView progress={progress} style={styles.headerPills}>
          {mode === 'videos' ? (
            // Videos has no filter to hand up, so the header takes the name of
            // the list instead — the thing that scrolled out of view.
            <Text style={styles.headerTitle}>Game videos</Text>
          ) : (
            <View style={styles.headerPillsRow}>
              <PillTabs
                bleed={false}
                tabs={WHEN_TABS}
                selected={when}
                onSelect={choose}
                size="compact"
              />
            </View>
          )}
        </HandoffView>
      ),
      [
        choose,
        mode,
        progress,
        styles.headerPills,
        styles.headerPillsRow,
        styles.headerTitle,
        when
      ]
    )
  )
  const [games, setGames] = useState<SeasonGame[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const all = await client.games(
        mode === 'schedule' && when !== 'all' ? { when } : {}
      )
      if (!cancelled) setGames(all)
    }
    load()
      .catch((caught: unknown) => {
        if (!cancelled) {
          setError(caught instanceof Error ? caught.message : 'Cannot load')
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, mode, when])

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
      onScroll={handoff.handleScroll}
      // Videos lays its cards out in up to four columns, so it keeps the
      // margins and loses the reading-width cap: a cap made for a line of text
      // would hold a grid of pictures to two columns on any monitor.
      wide={mode === 'videos'}
    >
      {mode === 'schedule' && (
        <View ref={handoff.ref}>
          <PillTabs
            tabs={WHEN_TABS}
            selected={when}
            onSelect={choose}
            size="compact"
          />
        </View>
      )}

      <View ref={mode === 'videos' ? handoff.ref : undefined}>
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
          // The time used to be the badge, which made an unplayed game look as
          // though it had a result. It belongs on the detail line with the date.
          const detail = [
            narrow ? shortDateNoWeekday(game.startAt) : shortDate(game.startAt),
            shortTime(game.startAt),
            videoCountLabel(game.videoCount)
          ]
            .filter(part => part !== '')
            .join(' · ')
          return (
            <View
              key={game.id}
              style={[styles.cell, { width: `${100 / columns}%` }]}
            >
              <Card>
                <GameRow
                  first={lines.first}
                  second={lines.second}
                  detail={detail}
                  venue={game.venue}
                  posterUrl={game.posterUrl}
                  length={
                    game.durationSec == null
                      ? undefined
                      : clock(game.durationSec)
                  }
                  // A game being played now says so instead of showing a
                  // score that is still changing.
                  badgeLabel={
                    game.isLive
                      ? 'live'
                      : game.awayScore == null
                        ? undefined
                        : `${game.awayScore}–${game.homeScore}`
                  }
                  badgeTone={game.isLive ? 'live' : 'neutral'}
                  onPress={() => {
                    // Tapping a video starts it. Somebody pressing a row with a
                    // picture and a length on it has asked to watch, not to read
                    // about it.
                    onOpenGame(game.id, `${lines.first} ${lines.second}`, {
                      autoPlay: game.videoCount > 0
                    })
                  }}
                />
              </Card>
            </View>
          )
        })}
      </View>
      <View />
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
