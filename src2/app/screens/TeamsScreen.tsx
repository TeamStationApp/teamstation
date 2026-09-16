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

import type { GameStationClient, TeamSummary } from '../../common/api'
import { cardSize } from '../layout/grid'
import { lstrings } from '../locales/strings'
import { cacheStyles, useTheme } from '../theme/ThemeContext'
import type { Theme } from '../theme/types'

export interface TeamsScreenProps {
  client: GameStationClient
  onOpenTeam: (team: TeamSummary) => void
}

/** The first screen after signing in: the teams this person belongs to. */
export function TeamsScreen(props: TeamsScreenProps): React.ReactElement {
  const { client, onOpenTeam } = props
  const theme = useTheme()
  const styles = getStyles(theme)
  const { width } = useWindowDimensions()
  const grid = cardSize({
    width,
    gutter: theme.rem(theme.gridGutterRem),
    maxCardWidth: theme.rem(24)
  })

  const [teams, setTeams] = useState<TeamSummary[] | undefined>(undefined)
  const [error, setError] = useState<string | undefined>(undefined)

  useEffect(() => {
    let live = true
    client
      .teams()
      .then(found => {
        if (live) setTeams(found)
      })
      .catch(() => {
        if (live) setError(lstrings.common_retry)
      })
    return () => {
      live = false
    }
  }, [client])

  if (error != null) return <Message text={error} />
  if (teams == null) {
    return (
      <View style={styles.centre}>
        <ActivityIndicator color={theme.primaryTextColor} />
      </View>
    )
  }
  if (teams.length === 0) return <Message text={lstrings.teams_none} />

  return (
    <ScrollView
      style={styles.screen}
      contentContainerStyle={[styles.grid, { padding: grid.gutter / 2 }]}
    >
      {teams.map(team => (
        <Pressable
          key={team.id}
          style={[
            styles.card,
            { width: grid.cardWidth, margin: grid.gutter / 2 }
          ]}
          onPress={() => {
            onOpenTeam(team)
          }}
        >
          <Text style={styles.cardTitle} numberOfLines={2}>
            {team.name}
          </Text>
          {team.shortName != null ? (
            <Text style={styles.cardSubtitle}>{team.shortName}</Text>
          ) : null}
        </Pressable>
      ))}
    </ScrollView>
  )
}

function Message(props: { text: string }): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <View style={styles.centre}>
      <Text style={styles.message}>{props.text}</Text>
    </View>
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
      padding: theme.rem(1)
    },
    grid: { flexDirection: 'row', flexWrap: 'wrap' },
    card: {
      backgroundColor: theme.cardBackgroundDark,
      borderRadius: theme.rem(0.5),
      padding: theme.rem(1)
    },
    cardTitle: {
      color: theme.primaryTextColor,
      fontFamily: theme.semiBoldTextFont,
      fontSize: theme.rem(1.1)
    },
    cardSubtitle: {
      color: theme.clearButtonColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.85),
      marginTop: theme.rem(0.25)
    },
    message: {
      color: theme.primaryTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(1),
      textAlign: 'center'
    }
  })
)
