import React, { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import type {
  GameStationClient,
  GameSummary,
  TeamSummary
} from '../../common/api'
import { cardSize } from '../layout/grid'
import { lstrings, plural } from '../locales/strings'
import { cacheStyles, useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'

export interface GamesScreenProps {
  client: GameStationClient
  team: TeamSummary
  onOpenGame: (game: GameSummary) => void
}

/**
 * A team's games, newest first, as a grid that becomes one column on a phone.
 * Games are the unit here, not videos: a game may have several videos, and it
 * is the game somebody remembers.
 */
export function GamesScreen(props: GamesScreenProps): React.ReactElement {
  const { client, team, onOpenGame } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const { width } = useWindowDimensions()
  const grid = cardSize({
    width,
    gutter: theme.rem(theme.gridGutterRem),
    maxCardWidth: theme.rem(26)
  })

  const [games, setGames] = useState<GameSummary[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let live = true
    setGames(undefined)
    client
      .teamGames(team.id)
      .then(found => {
        if (live) setGames(found)
      })
      .catch(() => {
        if (live) setError(lstrings.common_not_found)
      })
    return () => {
      live = false
    }
  }, [client, team.id])

  if (error != null) {
    return (
      <View style={styles.centre}>
        <Text style={styles.message}>{error}</Text>
      </View>
    )
  }
  if (games == null) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.primaryTextColor} />
      </View>
    )
  }
  if (games.length === 0) {
    return (
      <View style={styles.centre}>
        <Text style={styles.message}>{lstrings.games_none}</Text>
      </View>
    )
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.grid, { padding: grid.gutter / 2 }]}
    >
      {games.map(game => (
        <Pressable
          key={game.id}
          style={[
            styles.card,
            { width: grid.cardWidth, margin: grid.gutter / 2 }
          ]}
          onPress={() => {
            onOpenGame(game)
          }}
        >
          <Text style={styles.date}>{formatDate(game.startAt)}</Text>
          <View style={styles.row}>
            <Text style={styles.teamName} numberOfLines={1}>
              {game.awayTeamName}
            </Text>
            <Text style={styles.score}>{game.awayScore ?? '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.teamName} numberOfLines={1}>
              {game.homeTeamName}
            </Text>
            <Text style={styles.score}>{game.homeScore ?? '—'}</Text>
          </View>
          <View style={styles.row}>
            <Text style={styles.meta}>{statusWord(game.status)}</Text>
            <Text style={styles.meta}>
              {plural(
                game.videoCount,
                lstrings.games_video_count_one,
                lstrings.games_video_count_other
              )}
            </Text>
          </View>
        </Pressable>
      ))}
    </ScrollView>
  )
}

function statusWord(status: string): string {
  if (status === 'final') return lstrings.games_final
  if (status === 'inProgress') return lstrings.games_in_progress
  return lstrings.games_scheduled
}

/** The game's own day, in the reader's locale. */
function formatDate(iso: string | null): string {
  if (iso == null) return ''
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  return when.toLocaleDateString(undefined, {
    weekday: 'short',
    month: 'short',
    day: 'numeric'
  })
}

const getStyles = cacheStyles((theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.backgroundColor },
    centre: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.backgroundColor,
      padding: theme.rem(1)
    },
    grid: { flexDirection: 'row', flexWrap: 'wrap' },
    card: {
      backgroundColor: theme.cardBackgroundDark,
      borderRadius: theme.rem(0.5),
      padding: theme.rem(1),
      gap: theme.rem(0.35)
    },
    date: {
      color: theme.clearButtonColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.85)
    },
    score: {
      color: theme.primaryTextColor,
      fontFamily: theme.boldTextFont,
      fontSize: theme.rem(1.4),
      textAlign: 'right'
    },
    row: {
      flexDirection: 'row',
      alignItems: 'baseline',
      gap: theme.rem(0.5),
      justifyContent: 'space-between'
    },
    teamName: {
      color: theme.primaryTextColor,
      flexShrink: 1,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(1)
    },
    meta: {
      color: theme.clearButtonColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.8)
    },
    message: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(1),
      textAlign: 'center'
    }
  })
)
