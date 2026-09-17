import React, { useEffect, useState } from 'react'
import { Text, View } from 'react-native'

import type { GameStationClient, SeasonGame } from '../../common/api'
import {
  Card,
  GameRow,
  PillTabs,
  Screen,
  SectionHeader,
  useBreakpoint
} from '../components'
import { gameCountLabel, videoCountLabel } from '../locales/strings'
import { cacheStyles, type Theme, useTheme } from '../theme/ThemeContext'
import {
  clock,
  matchupLines,
  shortDate,
  shortDateNoWeekday,
  shortTime
} from './format'

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

type When = 'upcoming' | 'past' | 'all'

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

  // Both lists open on what has happened. A schedule of fixtures is the
  // rarer question; what somebody opens the app for is the game just played.
  const [when, setWhen] = useState<When>(initialWhen ?? 'past')
  const [games, setGames] = useState<SeasonGame[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let cancelled = false
    const load = async (): Promise<void> => {
      const seasons = await client.seasons()
      if (cancelled) return
      const perSeason = await Promise.all(
        seasons.map(async season => await client.seasonGames(season.id))
      )
      if (cancelled) return
      setGames(perSeason.flat())
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
  }, [client])

  const pool = mode === 'videos' ? games.filter(g => g.videoCount > 0) : games
  // A game is upcoming if it has not happened *yet*. A fixture that was never
  // scored does not stay upcoming for ever: the schedule was offering a game
  // from February as something still to come.
  const now = Date.now()
  const isAhead = (game: SeasonGame): boolean =>
    game.startAt != null && Date.parse(game.startAt) > now
  const played = pool.filter(game => game.awayScore != null || !isAhead(game))
  const upcoming = pool.filter(game => game.awayScore == null && isAhead(game))
  const shown = when === 'past' ? played : when === 'upcoming' ? upcoming : pool

  // Newest first looking back, soonest first looking forward: in both cases
  // the game nearest to now is at the top.
  const sorted = [...shown].sort((a, b) => {
    const order = (a.startAt ?? '').localeCompare(b.startAt ?? '')
    return when === 'upcoming' ? order : -order
  })

  return (
    <Screen>
      <PillTabs
        tabs={WHEN_TABS}
        selected={when}
        onSelect={next => {
          setWhen(next)
          onWhenChange?.(next)
        }}
        size="compact"
      />

      <SectionHeader
        title={mode === 'videos' ? 'Game videos' : 'Schedule'}
        note={gameCountLabel(sorted.length)}
      />

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
          <Card key={game.id}>
            <GameRow
              first={lines.first}
              second={lines.second}
              detail={detail}
              venue={game.venue}
              posterUrl={game.posterUrl}
              length={
                game.durationSec == null ? undefined : clock(game.durationSec)
              }
              badgeLabel={
                game.awayScore == null
                  ? undefined
                  : `${game.awayScore}–${game.homeScore}`
              }
              badgeTone="neutral"
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
        )
      })}
      <View />
    </Screen>
  )
}

const getStyles = cacheStyles((theme: Theme) => ({
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
