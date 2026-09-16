import React, { useMemo, useState } from 'react'
import { Pressable, StyleSheet, Text, View } from 'react-native'

import {
  GameStationClient,
  type GameSummary,
  type Session,
  type TeamSummary
} from '../common/api'
import { lstrings } from './locales/strings'
import { GameScreen } from './screens/GameScreen'
import { GamesScreen } from './screens/GamesScreen'
import { LoginScreen } from './screens/LoginScreen'
import { TeamsScreen } from './screens/TeamsScreen'
import { cacheStyles, ThemeProvider, useTheme } from './theme/ThemeContext'
import type { Theme } from './theme/types'

export interface AppProps {
  apiBaseUrl?: string
}

type Route =
  | { name: 'teams' }
  | { name: 'games'; team: TeamSummary }
  | { name: 'game'; team: TeamSummary; game: GameSummary }

/**
 * Sign in, then teams, then that team's games, then one game with its videos
 * and highlights. The navigation is a plain stack held in state: with four
 * screens and web only for now, a router would be more moving parts than the
 * app has screens.
 */
export function App(props: AppProps): React.ReactElement {
  const apiBaseUrl = props.apiBaseUrl ?? '/api/v1'

  const client = useMemo(
    () => new GameStationClient({ baseUrl: apiBaseUrl }),
    [apiBaseUrl]
  )
  const [session, setSession] = useState<Session | undefined>(undefined)
  const [stack, setStack] = useState<Route[]>([{ name: 'teams' }])
  const route = stack[stack.length - 1]

  const push = (next: Route): void => {
    setStack(current => [...current, next])
  }
  const pop = (): void => {
    setStack(current => (current.length > 1 ? current.slice(0, -1) : current))
  }

  return (
    <ThemeProvider>
      <Shell
        title={titleFor(route, session)}
        canGoBack={stack.length > 1 && session != null}
        onBack={pop}
      >
        {session == null ? (
          <LoginScreen client={client} onSignedIn={setSession} />
        ) : route.name === 'teams' ? (
          <TeamsScreen
            client={client}
            onOpenTeam={team => {
              push({ name: 'games', team })
            }}
          />
        ) : route.name === 'games' ? (
          <GamesScreen
            client={client}
            team={route.team}
            onOpenGame={game => {
              push({ name: 'game', team: route.team, game })
            }}
          />
        ) : (
          <GameScreen client={client} gameId={route.game.id} />
        )}
      </Shell>
    </ThemeProvider>
  )
}

function titleFor(route: Route, session: Session | undefined): string {
  if (session == null) return lstrings.login_title
  if (route.name === 'teams') return lstrings.teams_title
  if (route.name === 'games') return route.team.name
  // The matchup, so a game is identified by who played it rather than by the
  // name of the tab that happens to be open.
  return `${route.game.awayTeamName} ${lstrings.game_at} ${route.game.homeTeamName}`
}

interface ShellProps {
  title: string
  canGoBack: boolean
  onBack: () => void
  children: React.ReactNode
}

function Shell(props: ShellProps): React.ReactElement {
  const styles = getStyles(useTheme())
  return (
    <View style={styles.shell}>
      <View style={styles.bar}>
        {props.canGoBack ? (
          <Pressable onPress={props.onBack} style={styles.back}>
            <Text style={styles.backText}>{lstrings.common_back}</Text>
          </Pressable>
        ) : null}
        <Text style={styles.title} numberOfLines={1}>
          {props.title}
        </Text>
      </View>
      <View style={styles.body}>{props.children}</View>
    </View>
  )
}

const getStyles = cacheStyles((theme: Theme) =>
  StyleSheet.create({
    shell: { flex: 1, backgroundColor: theme.backgroundColor },
    bar: {
      alignItems: 'center',
      backgroundColor: theme.cardBackgroundDark,
      flexDirection: 'row',
      gap: theme.rem(0.75),
      paddingHorizontal: theme.rem(0.75),
      paddingVertical: theme.rem(0.6)
    },
    back: {
      backgroundColor: theme.inactiveBackgroundColor,
      borderRadius: theme.rem(0.3),
      paddingHorizontal: theme.rem(0.6),
      paddingVertical: theme.rem(0.3)
    },
    backText: {
      color: theme.buttonTextColor,
      fontFamily: theme.regularTextFont,
      fontSize: theme.rem(0.85)
    },
    title: {
      color: theme.primaryTextColor,
      flex: 1,
      fontFamily: theme.boldTextFont,
      fontSize: theme.rem(1.1)
    },
    body: { flex: 1 }
  })
)
