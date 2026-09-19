import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Image, Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  GameStationClient,
  type InviteInfo,
  type SeasonSummary,
  type Session,
  type TeamSummary
} from '../common/api'
import gsLogo from './assets/gsLogo.png'
import {
  AppHeader,
  AppNav,
  HeaderSlotProvider,
  type NavTabId,
  useBreakpoint,
  useHandoffSlot
} from './components'
import { lstrings, sprintf } from './locales/strings'
import type { Route, When } from './navigation/routes'
import { stacksAfterTabPress } from './navigation/tabPress'
import {
  currentRoute,
  showRoute,
  useBrowserBack
} from './navigation/useAddressBar'
import { AccountScreen } from './screens/AccountScreen'
import { GameScreen } from './screens/GameScreen'
import { GamesFeedScreen } from './screens/GamesFeedScreen'
import { HomeScreen } from './screens/HomeScreen'
import { JoinScreen } from './screens/JoinScreen'
import { LoginScreen } from './screens/LoginScreen'
import { ManageScreen } from './screens/ManageScreen'
import { PlayerScreen } from './screens/PlayerScreen'
import { SeasonScreen } from './screens/SeasonScreen'
import { SignInLinkScreen } from './screens/SignInLinkScreen'
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
  | { name: 'season'; season: SeasonSummary; tab?: string; when?: When }
  | { name: 'team'; team: TeamSummary; tab?: string }
  | {
      name: 'game'
      gameId: string
      title: string
      /** Which half of the game screen to open on. */
      tab?: 'watch' | 'boxScore'
      /** Start the video rather than waiting to be asked. */
      autoPlay?: boolean
      /** Which video, and where in it, from a link to a moment. */
      videoId?: string
      at?: number
    }
  | { name: 'account' }
  /**
   * One player, and what their stats are narrowed to.
   *
   * The narrowing arrives with the tap — a box score knows the season and the
   * side, a roster knows the team — and is written straight to the address, so
   * a link reproduces what the reader was looking at. It is a default they can
   * change, not a lock.
   */
  | {
      name: 'player'
      userId: string
      /** The name the tapped row showed, so the header has one immediately. */
      title: string
      tab?: 'videos' | 'stats'
      seasonId?: string
      teamId?: string
      year?: number
    }
  /** The page behind the gear on a team, season or league card. */
  | {
      name: 'manage'
      scopeKind: 'league' | 'season' | 'team'
      scopeId: string
      /** What it is called, once the page has said so. */
      title?: string
    }

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
  // One boundary, the one that already existed: below it the three
  // destinations float over the content, above it they sit in the header and
  // there is no sidebar at all.
  const isWide = useBreakpoint() !== 'phone'
  // Measured rather than repeated. The content's top padding and the pegged
  // player both have to clear the header, and a second copy of its height is a
  // second thing to forget.
  const [headerHeight, setHeaderHeight] = useState(48)
  // What the screen on top has handed up: a team's name, a row of filter
  // pills, a game's score. The header draws it and never anything else.
  const { handoff, setHandoff } = useHandoffSlot()

  const client = useMemo(
    () => new GameStationClient({ baseUrl: apiBaseUrl }),
    [apiBaseUrl]
  )
  const [session, setSession] = useState<Session | undefined>(undefined)
  // Until we have asked, we do not know whether anybody is signed in. Showing
  // the sign-in screen in the meantime is what made every link useless: the
  // cookie was there, nothing read it, and the address was thrown away.
  const [askedAboutSession, setAskedAboutSession] = useState(false)
  // The chosen filter belongs to the shell, because the shell is what writes
  // the address. Left in the screen, the rewrite stripped `?when=` the moment
  // the screen mounted.
  const [when, setWhen] = useState<When | undefined>(() =>
    whenOf(currentRoute())
  )
  /**
   * The invite code in the address, if the app was opened on one.
   *
   * Held apart from the tabs and their stacks, because an invitation is not a
   * place inside the app: it is a door in front of it, and the same door
   * whether the person arrives signed in, signed out, or with no account at
   * all. While it is up, the address is left exactly as it arrived — rewriting
   * `/i/tforce26` to `/` is how a link becomes unusable on a reload.
   */
  const [joining, setJoining] = useState<string | undefined>(() => {
    const route = currentRoute()
    return route.name === 'join' ? route.code : undefined
  })
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

  // A team or a season link carries only an id, and the screens want the whole
  // summary to draw a header. Resolve it once, on arrival, rather than landing
  // on the home screen and rewriting the address — which threw the link away.
  useEffect(() => {
    const route = currentRoute()
    if (route.name !== 'team' && route.name !== 'season') return
    let live = true
    const find = async (): Promise<void> => {
      if (route.name === 'team') {
        const teams = await client.teams()
        const team = teams.find(item => item.id === route.teamId)
        if (live && team != null) push({ name: 'team', team, tab: route.tab })
        return
      }
      const seasons = await client.seasons()
      const season = seasons.find(item => item.id === route.seasonId)
      if (live && season != null) {
        push({ name: 'season', season, tab: route.tab, when: route.when })
      }
    }
    find().catch(() => undefined)
    return () => {
      live = false
    }
    // Once, on the address the app opened on.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client])

  const stack = stacks[tab]
  const top = stack[stack.length - 1]

  // Keep the address saying where we are. `replace` on the first render so
  // landing on `/` and resolving it does not leave a step for Back to find.
  const firstRender = useRef(true)
  /**
   * The next address change is a position, not a place.
   *
   * Moving the video writes `?t=` to the address, and pushing a step for each
   * one made Back walk the plays: watch twenty highlights and Back needs
   * twenty presses to leave the game. Where you are in a video is a property
   * of the screen you are already on, so it corrects the entry rather than
   * adding one.
   */
  const inPlace = useRef(false)
  useEffect(() => {
    // Not while signed out: rewriting the address to `/` before the password
    // field has even been typed into throws away the link that brought them.
    if (session == null) return
    // Nor while an invitation is open, for the same reason.
    if (joining != null) return
    showRoute(routeOf(tab, top, when), firstRender.current || inPlace.current)
    firstRender.current = false
    inPlace.current = false
  }, [joining, session, tab, top, when])

  const goToRoute = useCallback((route: Route): void => {
    setJoining(route.name === 'join' ? route.code : undefined)
    const next = tabOf(route)
    setTab(next)
    setStacks(current => ({
      ...current,
      [next]: stackFor(route)[next] ?? []
    }))
  }, [])
  useBrowserBack(goToRoute)

  /** The tab, or — pressed on the tab you are already on — a step out of it. */
  const selectTab = (next: NavTabId): void => {
    setTab(next)
    setStacks(current => stacksAfterTabPress(current, tab, next))
  }

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
  /** A section change on the team or season screen, into the address. */
  const setTopTab = (next: string, correcting = false): void => {
    if (correcting) inPlace.current = true
    setStacks(current => {
      const held = current[tab]
      const last = held[held.length - 1]
      if (
        last?.name !== 'team' &&
        last?.name !== 'season' &&
        last?.name !== 'player'
      ) {
        return current
      }
      if (last.tab === next) return current
      return {
        ...current,
        [tab]: [...held.slice(0, -1), { ...last, tab: next }]
      }
    })
  }

  /**
   * The Stats filter, on the address.
   *
   * Put back in place rather than pushed: narrowing a total is not somewhere
   * new to go back from, and a reader who taps Back expects the page they came
   * from rather than the same page with a different filter.
   */
  const setPlayerFilter = (next: {
    seasonId?: string
    teamId?: string
    year?: number
  }): void => {
    inPlace.current = true
    setStacks(current => {
      const held = current[tab]
      const last = held[held.length - 1]
      if (last?.name !== 'player') return current
      return {
        ...current,
        [tab]: [
          ...held.slice(0, -1),
          {
            ...last,
            tab: 'stats' as const,
            seasonId: next.seasonId,
            teamId: next.teamId,
            year: next.year
          }
        ]
      }
    })
  }

  /**
   * Leaving the invitation for the thing it was an invitation to.
   *
   * The lists are asked again rather than trusted from before: the team or
   * season that was just granted was not in them a moment ago, which is the
   * whole reason this screen was on.
   */
  const openFromInvite = (scope: InviteInfo['scope']): void => {
    setJoining(undefined)
    const find = async (): Promise<void> => {
      if (scope.kind === 'team') {
        const teams = await client.teams()
        const team = teams.find(item => item.id === scope.id)
        if (team != null) push({ name: 'team', team })
        return
      }
      if (scope.kind === 'season') {
        const seasons = await client.seasons()
        const season = seasons.find(item => item.id === scope.id)
        if (season != null) push({ name: 'season', season })
      }
      // A league has no screen of its own yet, so home — which now lists the
      // seasons it brought with it — is where to land.
    }
    find().catch(() => undefined)
  }

  const openTeam = (team: TeamSummary): void => {
    push({ name: 'team', team })
  }
  /**
   * A name, from wherever it was tapped.
   *
   * `from` is why the Stats tab knows what to open on: a box score hands over
   * the game's season and the side that row belongs to, a roster hands over
   * the team. It becomes part of the address at the moment of the push rather
   * than a default the screen applies later — a default applied on mount is
   * what strips a filter somebody actually asked for.
   */
  const openPlayer = (
    userId: string,
    title: string,
    from: { seasonId?: string; teamId?: string } = {}
  ): void => {
    const narrowed = from.seasonId != null || from.teamId != null
    push({
      name: 'player',
      userId,
      title,
      tab: narrowed ? 'stats' : undefined,
      seasonId: from.seasonId,
      teamId: from.teamId
    })
  }
  /** The gear on a team, season or league card. */
  const openManage = (
    scopeKind: 'league' | 'season' | 'team',
    scopeId: string
  ): void => {
    push({ name: 'manage', scopeKind, scopeId })
  }
  const openSeason = (season: SeasonSummary): void => {
    push({ name: 'season', season })
  }

  if (session == null) {
    // The sign-in screen must not be drawn until the question is answered: a
    // flash of it is how a link to a game becomes a link to the sign-in
    // screen. The mark and a spinner rather than a blank page, because on a
    // slow connection the wait is seconds long and an empty window reads as
    // the app having failed to start.
    if (!askedAboutSession) {
      return (
        <View style={[styles.app, styles.booting]}>
          <Image
            accessibilityIgnoresInvertColors
            accessibilityLabel="GameStation"
            source={{ uri: gsLogo }}
            style={styles.bootMark}
          />
          <ActivityIndicator color={theme.secondaryTextColor} />
          {/*
            Words, not just a spinner. A screen reader has nothing to say
            about an `ActivityIndicator`, so the whole page announced itself
            as empty; `aria-live` means the wait is spoken rather than
            silently endured.
          */}
          <Text accessibilityLiveRegion="polite" style={styles.bootMessage}>
            {lstrings.common_loading}
          </Text>
        </View>
      )
    }
    // A link from the sign-in e-mail lands here, signed out, which is the
    // whole point of it. It spends the token only when it can tell a person is
    // behind the request.
    const route = currentRoute()
    return (
      <View style={styles.app}>
        <AppHeader
          title={route.name === 'join' ? lstrings.join_header : 'Sign in'}
          showMark
        />
        {route.name === 'join' ? (
          <JoinScreen
            client={client}
            code={route.code}
            signedIn={false}
            onSignedIn={setSession}
            onOpen={openFromInvite}
          />
        ) : route.name === 'signInLink' ? (
          <SignInLinkScreen
            client={client}
            token={route.token}
            requestId={route.requestId}
            onSignedIn={setSession}
          />
        ) : (
          <LoginScreen client={client} onSignedIn={setSession} />
        )}
      </View>
    )
  }

  if (joining != null) {
    return (
      <View style={styles.app}>
        <AppHeader title={lstrings.join_header} showMark />
        <JoinScreen
          client={client}
          code={joining}
          signedIn
          onSignedIn={setSession}
          onOpen={openFromInvite}
        />
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
        <GamesFeedScreen
          client={client}
          mode="videos"
          initialWhen={when}
          onWhenChange={setWhen}
          onOpenGame={openGame}
        />
      ) : (
        <GamesFeedScreen
          client={client}
          mode="schedule"
          initialWhen={when}
          onWhenChange={setWhen}
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
    ) : top.name === 'player' ? (
      <PlayerScreen
        client={client}
        userId={top.userId}
        title={top.title}
        initialTab={top.tab}
        initialFilter={{
          seasonId: top.seasonId,
          teamId: top.teamId,
          year: top.year
        }}
        onTab={setTopTab}
        onFilter={setPlayerFilter}
        onOpenMoment={(gameId, videoId, atSec, title) => {
          push({
            name: 'game',
            gameId,
            title,
            videoId,
            at: atSec,
            autoPlay: true
          })
        }}
      />
    ) : top.name === 'team' ? (
      <TeamScreen
        client={client}
        team={top.team}
        onOpenGame={openGame}
        onOpenPlayer={openPlayer}
        onManage={() => {
          openManage('team', top.team.id)
        }}
        initialTab={top.tab}
        onTab={setTopTab}
      />
    ) : top.name === 'season' ? (
      <SeasonScreen
        client={client}
        season={top.season}
        onOpenGame={openGame}
        onOpenTeam={openTeam}
        onManage={() => {
          openManage('season', top.season.id)
        }}
        initialTab={top.tab}
        onTab={setTopTab}
        initialWhen={top.when}
        onWhen={next => {
          setStacks(current => {
            const held = current[tab]
            const last = held[held.length - 1]
            if (last?.name !== 'season' || last.when === next) return current
            return {
              ...current,
              [tab]: [...held.slice(0, -1), { ...last, when: next }]
            }
          })
        }}
      />
    ) : top.name === 'manage' ? (
      <ManageScreen
        client={client}
        scopeKind={top.scopeKind}
        scopeId={top.scopeId}
        meUserId={session.user.id}
        onTitle={title => {
          setStacks(current => {
            const held = current[tab]
            const last = held[held.length - 1]
            if (last?.name !== 'manage' || last.title === title) return current
            return {
              ...current,
              [tab]: [...held.slice(0, -1), { ...last, title }]
            }
          })
        }}
      />
    ) : top.name === 'game' ? (
      <GameScreen
        client={client}
        gameId={top.gameId}
        onOpenPlayer={openPlayer}
        onOpenTeam={team => {
          push({ name: 'team', team })
        }}
        initialTab={top.tab}
        autoPlay={top.autoPlay}
        initialVideoId={top.videoId}
        startAtSec={top.at}
        onTab={next => {
          setStacks(current => {
            const held = current[tab]
            const last = held[held.length - 1]
            if (last?.name !== 'game' || last.tab === next) return current
            return {
              ...current,
              [tab]: [...held.slice(0, -1), { ...last, tab: next }]
            }
          })
        }}
        onMoment={(videoId, atSec) => {
          inPlace.current = true
          setStacks(current => {
            const held = current[tab]
            const last = held[held.length - 1]
            if (last?.name !== 'game') return current
            return {
              ...current,
              [tab]: [...held.slice(0, -1), { ...last, videoId, at: atSec }]
            }
          })
        }}
        onTitle={title => {
          setStacks(current => {
            const held = current[tab]
            const last = held[held.length - 1]
            if (last?.name !== 'game' || last.title === title) {
              return current
            }
            return {
              ...current,
              [tab]: [...held.slice(0, -1), { ...last, title }]
            }
          })
        }}
      />
    ) : null

  const header = (
    <AppHeader
      title={titleFor(tab, top)}
      // The mark on every screen that is a destination in its own right —
      // home, and the two lists — and on none that was pushed on top of one,
      // where the chevron and what scrolled up into the header say where you
      // are.
      showMark={top == null}
      handoff={handoff}
      onHeight={setHeaderHeight}
      nav={
        isWide ? (
          <AppNav mode="header" selected={tab} onSelect={selectTab} />
        ) : undefined
      }
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

  // The header is glass and sits **over** the content, so the page moves under
  // it; the body therefore starts at the top of the window and is padded down
  // by the header's measured height.
  //
  // Both children carry a key, and that is not decoration. React reconciles
  // children by position, so a tree that is `[nav, pane]` on a phone and
  // `[pane]` on a desktop would match the pane against the nav when the window
  // crossed the boundary and unmount everything below it — the `<video>`
  // element with it, which is what used to stop playback dead mid-drag. Keyed,
  // the pane is matched to the pane and nothing below it notices.
  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={styles.app}>
        <View key="pane" style={styles.pane}>
          <HeaderSlotProvider
            headerHeight={headerHeight}
            onHandoff={setHandoff}
          >
            <View style={styles.body}>{body}</View>
          </HeaderSlotProvider>
          <View style={styles.headerLayer}>{header}</View>
        </View>
        {!isWide && (
          <AppNav
            key="nav"
            mode="floating"
            selected={tab}
            onSelect={selectTab}
          />
        )}
      </View>
    </GestureHandlerRootView>
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
          autoPlay: route.at != null,
          videoId: route.videoId,
          at: route.at
        }
      ]
    }
  }
  if (route.name === 'account') return { [tab]: [{ name: 'account' }] }
  if (route.name === 'player') {
    return {
      [tab]: [
        {
          name: 'player',
          userId: route.userId,
          title: '',
          tab: route.tab,
          seasonId: route.seasonId,
          teamId: route.teamId,
          year: route.year
        }
      ]
    }
  }
  if (route.name === 'manage') {
    return {
      [tab]: [
        {
          name: 'manage',
          scopeKind: route.scopeKind,
          scopeId: route.scopeId
        }
      ]
    }
  }
  return {}
}

/** The filter an address asks for, if it asks for one. */
function whenOf(route: Route): 'upcoming' | 'past' | 'all' | undefined {
  return route.name === 'videos' || route.name === 'schedule'
    ? route.when
    : undefined
}

/** Which tab an address belongs to. */
function tabOf(route: Route): NavTabId {
  if (route.name === 'videos') return 'videos'
  if (route.name === 'schedule') return 'schedule'
  return 'home'
}

/** The address of wherever the app currently is. */
function routeOf(tab: NavTabId, top: Pushed | undefined, when?: When): Route {
  if (top != null) {
    if (top.name === 'team') {
      return { name: 'team', teamId: top.team.id, tab: top.tab }
    }
    if (top.name === 'season') {
      return {
        name: 'season',
        seasonId: top.season.id,
        tab: top.tab,
        when: top.when
      }
    }
    if (top.name === 'account') return { name: 'account' }
    if (top.name === 'player') {
      return {
        name: 'player',
        userId: top.userId,
        tab: top.tab,
        seasonId: top.seasonId,
        teamId: top.teamId,
        year: top.year
      }
    }
    if (top.name === 'manage') {
      return {
        name: 'manage',
        scopeKind: top.scopeKind,
        scopeId: top.scopeId
      }
    }
    return {
      name: 'game',
      gameId: top.gameId,
      tab: top.tab,
      videoId: top.videoId,
      at: top.at
    }
  }
  if (tab === 'videos') return { name: 'videos', when: when ?? 'past' }
  if (tab === 'schedule') return { name: 'schedule', when: when ?? 'past' }
  return { name: 'home' }
}

/**
 * What the header says, where it says anything at all.
 *
 * A team, a game and the two lists say nothing: the team's name is on the card
 * below, the game's score is on its hero card, and the lists carry their filter
 * pills, which name the list better than the word `Videos` does. Each of those
 * hands its own content up as it scrolls away.
 */
function titleFor(tab: NavTabId, top: Pushed | undefined): string | undefined {
  if (top != null) {
    if (top.name === 'season') return top.season.name
    if (top.name === 'account') return 'Account'
    if (top.name === 'manage') {
      return top.title == null
        ? lstrings.manage_open
        : sprintf(lstrings.manage_title, top.title)
    }
    return undefined
  }
  if (tab === 'home') return 'Your Home'
  return undefined
}

const getStyles = cacheStyles((theme: Theme) => ({
  app: {
    flex: 1,
    backgroundColor: theme.backgroundColor
  },
  booting: {
    alignItems: 'center',
    justifyContent: 'center',
    gap: theme.rem(theme.spaceMdRem)
  },
  bootMark: {
    width: theme.rem(3),
    height: theme.rem(3),
    resizeMode: 'contain'
  },
  bootMessage: {
    color: theme.secondaryTextColor,
    fontFamily: theme.regularTextFont,
    fontSize: theme.rem(0.875)
  },
  root: {
    flex: 1
  },
  pane: {
    flex: 1
  },
  body: {
    flex: 1
  },
  // Over the content rather than above it, which is the whole point of glass:
  // there has to be something behind it to blur.
  headerLayer: {
    position: 'absolute',
    top: 0,
    left: 0,
    right: 0,
    zIndex: 4
  }
}))
