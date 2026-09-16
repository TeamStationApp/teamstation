import React, { useEffect, useState } from 'react'
import {
  ActivityIndicator,
  Pressable,
  ScrollView,
  StyleSheet,
  Text,
  View
} from 'react-native'

import type {
  GameStationClient,
  SeasonGame,
  SeasonSummary,
  TeamSummary
} from '../../common/api'
import { lstrings, plural } from '../locales/strings'
import { cacheStyles, useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'

export interface SeasonScreenProps {
  client: GameStationClient
  season: SeasonSummary
  onOpenGame: (game: SeasonGame) => void
  onOpenTeam: (team: TeamSummary) => void
}

type Tab = 'schedule' | 'teams'

/**
 * A season: its schedule, and the teams in it.
 *
 * **Games with no video still appear.** About 24 of the spring season's 83
 * games have a recording; a season is its schedule, not its recordings, and a
 * parent looking for a date wants to find it either way.
 *
 * The schedule is newest first and grouped by month, because a flat list of 83
 * running from March to July is unreadable.
 */
export function SeasonScreen(props: SeasonScreenProps): React.ReactElement {
  const { client, season, onOpenGame, onOpenTeam } = props
  const theme = useTheme()
  const styles = getStyles(theme)

  const [tab, setTab] = useState<Tab>('schedule')
  const [games, setGames] = useState<SeasonGame[] | undefined>(undefined)
  const [teams, setTeams] = useState<TeamSummary[] | undefined>(undefined)

  useEffect(() => {
    let live = true
    client
      .seasonGames(season.id)
      .then(found => {
        if (live) setGames(found)
      })
      .catch(() => {
        if (live) setGames([])
      })
    return () => {
      live = false
    }
  }, [client, season.id])

  useEffect(() => {
    if (tab !== 'teams' || teams != null) return
    let live = true
    client
      .seasonTeams(season.id)
      .then(found => {
        if (live) setTeams(found)
      })
      .catch(() => {
        if (live) setTeams([])
      })
    return () => {
      live = false
    }
  }, [client, season.id, tab, teams])

  const tabs = (
    <View style={styles.tabs}>
      {(['schedule', 'teams'] as Tab[]).map(name => (
        <Pressable
          key={name}
          style={[styles.tab, name === tab ? styles.tabActive : undefined]}
          onPress={() => {
            setTab(name)
          }}
        >
          <Text style={styles.tabText}>
            {name === 'schedule'
              ? lstrings.season_schedule
              : lstrings.season_teams}
          </Text>
        </Pressable>
      ))}
    </View>
  )

  if (tab === 'teams') {
    return (
      <ScrollView style={styles.screen}>
        {tabs}
        {teams == null ? (
          <ActivityIndicator color={theme.primaryTextColor} />
        ) : (
          teams.map(team => (
            <Pressable
              key={team.id}
              style={styles.row}
              onPress={() => {
                onOpenTeam(team)
              }}
            >
              <Text style={styles.teamName}>{team.name}</Text>
            </Pressable>
          ))
        )}
      </ScrollView>
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
        <Text style={styles.message}>{lstrings.season_no_games}</Text>
      </View>
    )
  }

  // Grouped by month, in the order the API gave them: newest first.
  const months: Array<{ label: string; games: SeasonGame[] }> = []
  for (const game of games) {
    const label = monthLabel(game.startAt)
    const last = months[months.length - 1]
    if (last?.label === label) last.games.push(game)
    else months.push({ label, games: [game] })
  }

  return (
    <ScrollView style={styles.screen}>
      {tabs}
      {months.map(month => (
        <View key={month.label}>
          <Text style={styles.month}>{month.label}</Text>
          {month.games.map(game => (
            <Pressable
              key={game.id}
              style={styles.game}
              onPress={() => {
                onOpenGame(game)
              }}
            >
              <Text style={styles.day}>{dayLabel(game.startAt)}</Text>
              <View style={styles.matchup}>
                <Text style={styles.side} numberOfLines={1}>
                  {game.awayTeamName}
                </Text>
                <Text style={styles.score}>{scoreLine(game)}</Text>
                <Text style={styles.side} numberOfLines={1}>
                  {game.homeTeamName}
                </Text>
              </View>
              <Text style={styles.videos}>
                {game.videoCount === 0
                  ? lstrings.season_no_video
                  : plural(
                      game.videoCount,
                      lstrings.games_video_count_one,
                      lstrings.games_video_count_other
                    )}
              </Text>
            </Pressable>
          ))}
        </View>
      ))}
    </ScrollView>
  )
}

/** A dash, not a zero: a game with no plays imported has no score, not 0–0. */
function scoreLine(game: SeasonGame): string {
  if (game.awayScore == null || game.homeScore == null) return '—'
  return `${game.awayScore} – ${game.homeScore}`
}

function monthLabel(iso: string | null): string {
  if (iso == null) return ''
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  return when
    .toLocaleDateString(undefined, { month: 'long', year: 'numeric' })
    .toUpperCase()
}

function dayLabel(iso: string | null): string {
  if (iso == null) return ''
  const when = new Date(iso)
  if (Number.isNaN(when.getTime())) return ''
  return when.toLocaleDateString(undefined, {
    weekday: 'short',
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
    tabs: {
      flexDirection: 'row',
      gap: theme.rem(0.5),
      padding: theme.rem(0.75)
    },
    tab: {
      backgroundColor: theme.inactiveBackgroundColor,
      borderRadius: theme.rem(0.3),
      paddingHorizontal: theme.rem(0.75),
      paddingVertical: theme.rem(0.35)
    },
    tabActive: { backgroundColor: theme.primaryButtonColor },
    tabText: {
      color: theme.buttonTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.85)
    },
    month: {
      color: theme.clearButtonColor,
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(0.8),
      letterSpacing: 1,
      paddingHorizontal: theme.rem(0.75),
      paddingTop: theme.rem(0.75),
      paddingBottom: theme.rem(0.25)
    },
    game: {
      backgroundColor: theme.cardBackgroundDark,
      borderRadius: theme.rem(0.4),
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.rem(0.75),
      marginHorizontal: theme.rem(0.75),
      marginBottom: theme.rem(0.35),
      paddingHorizontal: theme.rem(0.75),
      paddingVertical: theme.rem(0.6)
    },
    day: {
      color: theme.clearButtonColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.85),
      minWidth: theme.rem(4)
    },
    matchup: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      gap: theme.rem(0.5)
    },
    side: {
      color: theme.primaryTextColor,
      flex: 1,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.95)
    },
    score: {
      color: theme.primaryTextColor,
      fontFamily: theme.boldTextFont,
      fontSize: theme.rem(1),
      minWidth: theme.rem(3.5),
      textAlign: 'center'
    },
    videos: {
      color: theme.clearButtonColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.8),
      minWidth: theme.rem(4.5),
      textAlign: 'right'
    },
    row: {
      backgroundColor: theme.cardBackgroundDark,
      borderRadius: theme.rem(0.4),
      marginHorizontal: theme.rem(0.75),
      marginBottom: theme.rem(0.35),
      padding: theme.rem(0.85)
    },
    teamName: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(1)
    },
    message: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(1),
      textAlign: 'center'
    }
  })
)
