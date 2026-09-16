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
  SeasonSummary,
  TeamSummary
} from '../../common/api'
import { cardSize } from '../layout/grid'
import { lstrings, sprintf } from '../locales/strings'
import { cacheStyles, useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'

export interface HomeScreenProps {
  client: GameStationClient
  onOpenTeam: (team: TeamSummary) => void
  onOpenSeason: (season: SeasonSummary) => void
}

/**
 * Your teams, then the seasons you can see.
 *
 * Teams first because that is why somebody opened the app — a parent wants
 * their child's team, not a league table. Seasons below, because belonging to
 * a season grants every team in it: 16 of the migrated people are in a season
 * and on no team at all, and a team-only screen would show them nothing.
 *
 * A block with nothing in it is left out rather than drawn empty.
 */
export function HomeScreen(props: HomeScreenProps): React.ReactElement {
  const { client, onOpenTeam, onOpenSeason } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const { width } = useWindowDimensions()
  const grid = cardSize({
    width,
    gutter: theme.rem(theme.gridGutterRem),
    maxCardWidth: theme.rem(26)
  })

  const [teams, setTeams] = useState<TeamSummary[] | undefined>(undefined)
  const [seasons, setSeasons] = useState<SeasonSummary[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let live = true
    Promise.all([client.teams(), client.seasons()])
      .then(([foundTeams, foundSeasons]) => {
        if (!live) return
        setTeams(foundTeams)
        setSeasons(foundSeasons)
      })
      .catch(() => {
        if (live) setError(lstrings.common_not_found)
      })
    return () => {
      live = false
    }
  }, [client])

  if (error != null) {
    return (
      <View style={styles.centre}>
        <Text style={styles.message}>{error}</Text>
      </View>
    )
  }
  if (teams == null || seasons == null) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.primaryTextColor} />
      </View>
    )
  }
  if (teams.length === 0 && seasons.length === 0) {
    return (
      <View style={styles.centre}>
        <Text style={styles.message}>{lstrings.home_nothing_yet}</Text>
      </View>
    )
  }

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={{ padding: grid.gutter / 2 }}
    >
      {teams.length > 0 ? (
        <>
          <Text style={styles.heading}>{lstrings.home_your_teams}</Text>
          <View style={styles.grid}>
            {teams.map(team => (
              <Pressable
                key={team.id}
                style={[
                  styles.teamCard,
                  { width: grid.cardWidth, margin: grid.gutter / 2 }
                ]}
                onPress={() => {
                  onOpenTeam(team)
                }}
              >
                <Text style={styles.teamName}>{team.name}</Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}

      {seasons.length > 0 ? (
        <>
          <Text style={styles.heading}>{lstrings.home_seasons}</Text>
          <View style={styles.grid}>
            {seasons.map(season => (
              <Pressable
                key={season.id}
                style={[
                  styles.seasonCard,
                  { width: grid.cardWidth, margin: grid.gutter / 2 }
                ]}
                onPress={() => {
                  onOpenSeason(season)
                }}
              >
                <Text style={styles.seasonName}>{season.name}</Text>
                <Text style={styles.counts}>
                  {sprintf(
                    lstrings.season_counts,
                    String(season.teams),
                    String(season.games),
                    String(season.videos)
                  )}
                </Text>
              </Pressable>
            ))}
          </View>
        </>
      ) : null}
    </ScrollView>
  )
}

const getStyles = cacheStyles((theme: Theme) =>
  StyleSheet.create({
    screen: { flex: 1, backgroundColor: theme.backgroundColor },
    centre: {
      flex: 1,
      alignItems: 'center',
      justifyContent: 'center',
      backgroundColor: theme.backgroundColor,
      padding: theme.rem(1.5)
    },
    grid: { flexDirection: 'row', flexWrap: 'wrap' },
    heading: {
      color: theme.primaryTextColor,
      fontFamily: theme.boldTextFont,
      fontSize: theme.rem(1.1),
      paddingHorizontal: theme.rem(0.75),
      paddingTop: theme.rem(0.75),
      paddingBottom: theme.rem(0.25)
    },
    teamCard: {
      backgroundColor: theme.primaryButtonColor,
      borderRadius: theme.rem(0.5),
      padding: theme.rem(1)
    },
    teamName: {
      color: theme.buttonTextColor,
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(1.1)
    },
    seasonCard: {
      backgroundColor: theme.cardBackgroundDark,
      borderRadius: theme.rem(0.5),
      padding: theme.rem(1),
      gap: theme.rem(0.35)
    },
    seasonName: {
      color: theme.primaryTextColor,
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(1.05)
    },
    counts: {
      color: theme.clearButtonColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.85)
    },
    message: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(1),
      textAlign: 'center'
    }
  })
)
