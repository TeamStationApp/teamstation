import React, { useMemo, useState } from 'react'
import { View } from 'react-native'

import {
  GameStationClient,
  type SeasonSummary,
  type Session,
  type TeamSummary
} from '../common/api'
import { AppHeader, AppNav, type NavTabId, useBreakpoint } from './components'
import { AccountScreen } from './screens/AccountScreen'
import { GameScreen } from './screens/GameScreen'
import { GamesFeedScreen } from './screens/GamesFeedScreen'
import { HomeScreen } from './screens/HomeScreen'
import { LoginScreen } from './screens/LoginScreen'
import { SeasonScreen } from './screens/SeasonScreen'
import { TeamScreen } from './screens/TeamScreen'
import {
  cacheStyles,
  type Theme,
  ThemeProvider,
  useTheme
} from './theme/ThemeContext'

export interface AppProps {
  apiBaseUrl?: string
}

/** A screen pushed on top of a tab, rather than one of the tabs itself. */
type Pushed =
  | { name: 'season'; season: SeasonSummary }
  | { name: 'team'; team: TeamSummary }
  | { name: 'game'; gameId: string; title: string }
  | { name: 'account' }

/**
 * Three destinations, each with its own stack.
 *
 * Per-tab stacks rather than one shared one: opening a team from Home and then
 * switching to Schedule and back should land where it was left, which is what
 * every app with a tab bar does and what people expect without being told. One
 * shared stack would either lose the place or carry a team screen into a tab
 * it does not belong to.
 *
 * Still a plain object in state rather than a router. There are seven screens
 * and no deep links yet; a router would be more moving parts than the app has
 * places to go. When URLs matter — and for a video anyone wants to send to a
 * grandparent, they will — this is the one thing to replace.
 */
export function App(props: AppProps): React.ReactElement {
  return (
    <ThemeProvider>
      <Shell apiBaseUrl={props.apiBaseUrl} />
    </ThemeProvider>
  )
}

function Shell(props: AppProps): React.ReactElement {
  const apiBaseUrl = props.apiBaseUrl ?? '/api/v1'
  const theme = useTheme()
  const styles = getStyles(theme)
  const isRail = useBreakpoint() !== 'phone'

  const client = useMemo(
    () => new GameStationClient({ baseUrl: apiBaseUrl }),
    [apiBaseUrl]
  )
  const [session, setSession] = useState<Session | undefined>(undefined)
  const [tab, setTab] = useState<NavTabId>('home')
  const [stacks, setStacks] = useState<Record<NavTabId, Pushed[]>>({
    home: [],
    videos: [],
    schedule: []
  })

  const stack = stacks[tab]
  const top = stack[stack.length - 1]

  const push = (next: Pushed): void => {
    setStacks(current => ({ ...current, [tab]: [...current[tab], next] }))
  }
  const pop = (): void => {
    setStacks(current => ({ ...current, [tab]: current[tab].slice(0, -1) }))
  }

  const openGame = (gameId: string, title: string): void => {
    push({ name: 'game', gameId, title })
  }
  const openTeam = (team: TeamSummary): void => {
    push({ name: 'team', team })
  }
  const openSeason = (season: SeasonSummary): void => {
    push({ name: 'season', season })
  }

  if (session == null) {
    return (
      <View style={styles.app}>
        <AppHeader title="Sign in" overline="GameStation" />
        <LoginScreen client={client} onSignedIn={setSession} />
      </View>
    )
  }

  const body =
    top == null ? (
      tab === 'home' ? (
        <HomeScreen
          client={client}
          onOpenTeam={openTeam}
          onOpenSeason={openSeason}
          onOpenGame={openGame}
        />
      ) : tab === 'videos' ? (
        <GamesFeedScreen client={client} mode="videos" onOpenGame={openGame} />
      ) : (
        <GamesFeedScreen
          client={client}
          mode="schedule"
          onOpenGame={openGame}
        />
      )
    ) : top.name === 'account' ? (
      <AccountScreen
        session={session}
        onSignOut={() => {
          client.signOut().catch(() => undefined)
          setSession(undefined)
          setStacks({ home: [], videos: [], schedule: [] })
          setTab('home')
        }}
      />
    ) : top.name === 'team' ? (
      <TeamScreen client={client} team={top.team} onOpenGame={openGame} />
    ) : top.name === 'season' ? (
      <SeasonScreen
        client={client}
        season={top.season}
        onOpenGame={openGame}
        onOpenTeam={openTeam}
      />
    ) : top.name === 'game' ? (
      <GameScreen client={client} gameId={top.gameId} />
    ) : null

  const header = (
    <AppHeader
      title={titleFor(tab, top)}
      overline="GameStation"
      onBack={stack.length > 0 ? pop : undefined}
      account={
        top?.name === 'account'
          ? undefined
          : {
              name: session.user.displayName,
              avatarUrl: session.user.avatarUrl,
              onPress: () => {
                push({ name: 'account' })
              }
            }
      }
    />
  )

  // The rail sits beside the content on a wide window and the bar sits under
  // it on a phone, so the two arrangements are a row and a column of the same
  // two pieces — and they are written as one tree whose axis changes, never as
  // two trees.
  //
  // Two `return`s here, one per arrangement, look equivalent and are not:
  // React reconciles children by position, so crossing the threshold put an
  // `AppHeader` where an `AppNav` had been and unmounted everything below it.
  // The video element went with it, which is why dragging a window across
  // 1024px stopped playback dead. A breakpoint may change styles and may
  // change how many columns a grid has. It may not change the shape of the
  // tree above something stateful.
  //
  // `column-reverse` keeps the navigation first in the tree, where it reads
  // before the content, while drawing it under the pane on a phone.
  return (
    <View style={isRail ? styles.appRow : styles.appColumn}>
      <AppNav selected={tab} onSelect={setTab} />
      <View style={styles.pane}>
        {header}
        {body}
      </View>
    </View>
  )
}

/**
 * The name of the screen you are on, never the name of the app.
 *
 * Home is `Your Home` rather than `GameStation`, which the header already says
 * on the line above: the two together read `GAMESTATION / GameStation`, which
 * tells you nothing twice.
 */
export function titleFor(tab: NavTabId, top: Pushed | undefined): string {
  if (top != null) {
    if (top.name === 'team') return top.team.name
    if (top.name === 'season') return top.season.name
    if (top.name === 'account') return 'Account'
    return top.title
  }
  if (tab === 'videos') return 'Videos'
  if (tab === 'schedule') return 'Schedule'
  return 'Your Home'
}

const getStyles = cacheStyles((theme: Theme) => ({
  app: {
    flex: 1,
    backgroundColor: theme.backgroundColor
  },
  appRow: {
    flex: 1,
    flexDirection: 'row',
    backgroundColor: theme.backgroundColor
  },
  appColumn: {
    flex: 1,
    flexDirection: 'column-reverse',
    backgroundColor: theme.backgroundColor
  },
  pane: {
    flex: 1
  }
}))
