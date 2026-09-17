import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { View } from 'react-native'

import {
  GameStationClient,
  type SeasonSummary,
  type Session,
  type TeamSummary
} from '../common/api'
import { AppHeader, AppNav, type NavTabId, useBreakpoint } from './components'
import type { Route } from './navigation/routes'
import {
  currentRoute,
  showRoute,
  useBrowserBack
} from './navigation/useAddressBar'
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
  | {
      name: 'game'
      gameId: string
      title: string
      /** Which half of the game screen to open on. */
      tab?: 'watch' | 'boxScore'
      /** Start the video rather than waiting to be asked. */
      autoPlay?: boolean
    }
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
  // Until we have asked, we do not know whether anybody is signed in. Showing
  // the sign-in screen in the meantime is what made every link useless: the
  // cookie was there, nothing read it, and the address was thrown away.
  const [askedAboutSession, setAskedAboutSession] = useState(false)
  // The address bar is the state, not a copy of it: the app starts on
  // whatever was linked to, and every move writes the new address.
  const [tab, setTab] = useState<NavTabId>(() => tabOf(currentRoute()))
  // The address the app was opened on decides what is on the stack, so a link
  // to a game opens that game rather than the screen behind it.
  const [stacks, setStacks] = useState<Record<NavTabId, Pushed[]>>(() => {
    const opened = stackFor(currentRoute())
    return { home: [], videos: [], schedule: [], ...opened }
  })

  // The session lives in an `HttpOnly` cookie this code cannot read, so the
  // only way to know is to ask.
  useEffect(() => {
    let live = true
    client
      .whoAmI()
      .then(user => {
        if (!live) return
        if (user != null) setSession({ token: '', expiresAt: '', user })
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setAskedAboutSession(true)
      })
    return () => {
      live = false
    }
  }, [client])

  const stack = stacks[tab]
  const top = stack[stack.length - 1]

  // Keep the address saying where we are. `replace` on the first render so
  // landing on `/` and resolving it does not leave a step for Back to find.
  const firstRender = useRef(true)
  useEffect(() => {
    showRoute(routeOf(tab, top), firstRender.current)
    firstRender.current = false
  }, [tab, top])

  const goToRoute = useCallback((route: Route): void => {
    const next = tabOf(route)
    setTab(next)
    setStacks(current => ({
      ...current,
      [next]: stackFor(route)[next] ?? []
    }))
  }, [])
  useBrowserBack(goToRoute)

  const push = (next: Pushed): void => {
    setStacks(current => ({ ...current, [tab]: [...current[tab], next] }))
  }
  const pop = (): void => {
    setStacks(current => ({ ...current, [tab]: current[tab].slice(0, -1) }))
  }

  const openGame = (
    gameId: string,
    title: string,
    options: { tab?: 'watch' | 'boxScore'; autoPlay?: boolean } = {}
  ): void => {
    push({ name: 'game', gameId, title, ...options })
  }
  const openTeam = (team: TeamSummary): void => {
    push({ name: 'team', team })
  }
  const openSeason = (season: SeasonSummary): void => {
    push({ name: 'season', season })
  }

  if (session == null) {
    // Nothing at all until the question is answered: a flash of the sign-in
    // screen is how a link to a game becomes a link to the sign-in screen.
    if (!askedAboutSession) return <View style={styles.app} />
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
      <GameScreen
        client={client}
        gameId={top.gameId}
        initialTab={top.tab}
        autoPlay={top.autoPlay}
      />
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
export /**
 * What a link opens on top of its tab.
 *
 * A team or a season needs more than its id to draw a header, so the screen is
 * pushed with what the address carries and fills the rest in itself.
 */
function stackFor(route: Route): Partial<Record<NavTabId, Pushed[]>> {
  const tab = tabOf(route)
  if (route.name === 'game') {
    return {
      [tab]: [
        {
          name: 'game',
          gameId: route.gameId,
          title: '',
          tab: route.tab,
          autoPlay: route.at != null
        }
      ]
    }
  }
  if (route.name === 'account') return { [tab]: [{ name: 'account' }] }
  return {}
}

/** Which tab an address belongs to. */
function tabOf(route: Route): NavTabId {
  if (route.name === 'videos') return 'videos'
  if (route.name === 'schedule') return 'schedule'
  return 'home'
}

/** The address of wherever the app currently is. */
function routeOf(tab: NavTabId, top: Pushed | undefined): Route {
  if (top != null) {
    if (top.name === 'team') return { name: 'team', teamId: top.team.id }
    if (top.name === 'season') {
      return { name: 'season', seasonId: top.season.id }
    }
    if (top.name === 'account') return { name: 'account' }
    return {
      name: 'game',
      gameId: top.gameId,
      tab: top.tab,
      at: top.autoPlay === true ? undefined : undefined
    }
  }
  if (tab === 'videos') return { name: 'videos', when: 'past' }
  if (tab === 'schedule') return { name: 'schedule', when: 'upcoming' }
  return { name: 'home' }
}

function titleFor(tab: NavTabId, top: Pushed | undefined): string {
  if (top != null) {
    if (top.name === 'team') return top.team.name
    if (top.name === 'season') return top.season.name
    if (top.name === 'account') return 'Account'
    // A game opened from a link has no title until it has loaded.
    return top.title === '' ? 'Game' : top.title
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
