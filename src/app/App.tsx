import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { ActivityIndicator, Image, Platform, Text, View } from 'react-native'
import { GestureHandlerRootView } from 'react-native-gesture-handler'

import {
  type InviteInfo,
  type MyRoles,
  type SeasonSummary,
  type Session,
  TeamStationClient,
  type TeamSummary
} from '../common/api'
import { asTeamSummary } from '../common/api'
import { GameSocket } from '../common/gameSocket'
import type { GroupRef } from '../common/groupCreation'
import { managesRoster } from '../common/roles'
import type { WalkUpSong } from '../common/walkUpSong'
import { tsLogoSource } from './assets'
import { ChatCoreGate } from './chat/ChatCoreGate'
import { chatCoreLog } from './chat/chatCoreLog'
import { ChatDevicesScreen } from './chat/ChatDevicesScreen'
import { ChatGate } from './chat/ChatGate'
import type { ChatLink } from './chat/ChatLinks'
import { ChatListScreen } from './chat/ChatListScreen'
import { ChatMembersScreen } from './chat/ChatMembersScreen'
import { hasUnread } from './chat/chatModel'
import { ConversationScreen } from './chat/ConversationScreen'
import { ChatEngine, type ConversationListItem } from './chat/engine/engine'
import { keyStore } from './chat/keyStore'
import { LinkDeviceScreen } from './chat/LinkDeviceScreen'
import { NewDmScreen } from './chat/NewDmScreen'
import { thisDevice } from './chat/thisDevice'
import {
  AppHeader,
  AppNav,
  HeaderSlotProvider,
  type NavTabId,
  useBreakpoint,
  useHandoffSlot
} from './components'
import { errorScreen } from './components/ErrorFallback'
import { type SuccessNotice, SuccessToast } from './components/SuccessToast'
import { ChatBench } from './dev/chatBench'
import { StandaloneField } from './field/StandaloneField'
import { useForegroundRefresh } from './hooks/useForegroundRefresh'
import { lstrings, sprintf } from './locales/strings'
import {
  type CreationRoute,
  isCreationRoute,
  parseRoute,
  type Route,
  routePath,
  type When
} from './navigation/routes'
import {
  isScoringPlayerChild,
  isScoringPlayerReturn,
  type ScoringPlayerOrigin
} from './navigation/scoringPlayerReturn'
import { seasonParticipantDestination } from './navigation/seasonParticipant'
import {
  filtersForRoute,
  initialTabFilters,
  type TabFilters,
  withFilter
} from './navigation/tabFilters'
import { stacksAfterTabPress } from './navigation/tabPress'
import {
  backFromScoringPlayer,
  currentRoute,
  popRoute,
  scoringOriginHistory,
  showRoute,
  useBrowserBack
} from './navigation/useAddressBar'
import { passwordKdf } from './platform/passwordKdf'
import { ScoreboardOverrideScreen } from './scoreboard/ScoreboardOverrideScreen'
import { ScoringPlayerSettingsFlow } from './scoring/ScoringPlayerSettingsFlow'
import { ScoringScreen } from './scoring/ScoringScreen'
import { ServerScoringSource } from './scoring/scoringSource'
import { AccountScreen } from './screens/AccountScreen'
import { CreateGameScreen } from './screens/CreateGameScreen'
import { CreateGroupScreen } from './screens/CreateGroupScreen'
import { DiscoverScreen } from './screens/DiscoverScreen'
import { ChatReportsScreen } from './screens/ChatReportsScreen'
import { GameScreen } from './screens/GameScreen'
import {
  type GameSettingsResult,
  GameSettingsScreen
} from './screens/GameSettingsScreen'
import { GamesFeedScreen } from './screens/GamesFeedScreen'
import { GroupLinkScreen } from './screens/GroupLinkScreen'
import { GroupScreen } from './screens/GroupScreen'
import { GroupSettingsScreen } from './screens/GroupSettingsScreen'
import { HomeScreen } from './screens/HomeScreen'
import { JoinScreen } from './screens/JoinScreen'
import { LoginScreen } from './screens/LoginScreen'
import { NodeAdministrationScreen } from './screens/NodeAdministrationScreen'
import {
  NotificationDetailScreen,
  NotificationsScreen
} from './screens/NotificationsScreen'
import { OAuthScreen } from './screens/OAuthScreen'
import { OnboardingScreen } from './screens/OnboardingScreen'
import { PersonProfileScreen } from './screens/PersonProfileScreen'
import { PlayerScreen } from './screens/PlayerScreen'
import { PromoteExternalScreen } from './screens/PromoteExternalScreen'
import { SeasonScreen } from './screens/SeasonScreen'
import { SignInLinkScreen } from './screens/SignInLinkScreen'
import { TeamPage } from './screens/TeamPage'
import { startSentry, useSentryUser } from './sentry'
import { ErrorBoundary } from './sentrySdk'
import {
  cacheStyles,
  type Theme,
  ThemeProvider,
  useTheme
} from './theme/ThemeContext'
import { DjGameScreen } from './walkup/DjGameScreen'
import { resolveSong } from './walkup/resolveSong'
import walkUpMusic from './walkup/walkUpMusic'
import { useWalkUpPreferences } from './walkup/walkUpPreferences'
import { WalkUpSongScreen } from './walkup/WalkUpSongScreen'

export interface AppProps {
  /** Standalone field preview: never contact the API or restore a session. */
  fieldPreview?: boolean
  apiBaseUrl?: string
  /**
   * A session token kept from the last launch, where the platform can keep
   * one.
   *
   * The web keeps its session in an `HttpOnly` cookie that this code cannot
   * read and the browser sends by itself, which is the stronger arrangement
   * and why both are supported. A phone has no cookie jar — `server/auth/
   * tokens.ts` reads the `Authorization` header first and says as much — so on
   * a phone the token is carried here.
   */
  initialToken?: string
  /**
   * Called when the token changes, so a platform that can keep one does.
   *
   * Deliberately **not** called with `session.token`: `whoAmI` answers with a
   * user and no token at all, so writing that through would replace a good
   * stored token with an empty string on the second launch and sign the person
   * out with nothing anywhere to say why.
   */
  onToken?: (token: string | undefined) => void
}

type ScoringSettingsRefresh = () => void

/** A screen pushed on top of a tab, rather than one of the tabs itself. */
type Pushed =
  | CreationRoute
  | { name: 'scoreGame'; gameId: string }
  /**
   * DJ Game, on a phone. The side showing is kept here, so coming back from
   * the song picker lands on the list the songkeeper left.
   */
  | { name: 'djGame'; gameId: string; side?: 'away' | 'home' }
  | { name: 'scoreboardOverride'; gameId: string }
  | { name: 'season'; season: SeasonSummary; tab?: string; when?: When }
  | { name: 'team'; team: TeamSummary; tab?: string }
  | {
      name: 'game'
      gameId: string
      title: string
      /** Which half of the game screen to open on. */
      tab?: 'boxScore' | 'watch' | 'score'
      /** Start the video rather than waiting to be asked. */
      autoPlay?: boolean
      /** Which video, and where in it, from a link to a moment. */
      videoId?: string
      at?: number
      /** The angles showing at once, in the order they are laid out. */
      angles?: string[]
      /** Which angle is heard, and which fills the picture. */
      audio?: string
      zoom?: string
    }
  | { name: 'account' }
  /** Chat devices, from the account screen or `/chat/devices`. */
  | { name: 'chatDevices' }
  /** Linking this device for chat, or resetting the user's chat keys. */
  | { name: 'chatLink' }
  /** Starting a direct message. */
  | { name: 'chatNew' }
  /** One chat, and what it is called once known. */
  | { name: 'conversation'; conversationId: string; title: string }
  /** A chat's members, safety numbers and approvals. */
  | { name: 'chatMembers'; conversationId: string }
  /** Reported chat messages, for site administrators. */
  | { name: 'chatReports' }
  /**
   * One player, and what their stats and videos are narrowed to.
   *
   * The narrowing arrives with the tap — a box score knows the season and the
   * side — and is written straight to the address, so a link reproduces what
   * the reader was looking at. It is a default they can change, not a lock.
   * A roster hands over only the team it was opened for, which the screen
   * narrows both tabs to unless something else was asked for.
   */
  | {
      name: 'player'
      userId: string
      /** The name the tapped row showed, so the header has one immediately. */
      title: string
      tab?: 'videos' | 'stats' | 'teams' | 'settings' | 'walkup'
      seasonId?: string
      teamId?: string
      year?: number
      videoSeasonId?: string
      videoTeamId?: string
      videoYear?: number
      /** The team the page was opened for, which Settings and Walk-up edit. */
      onTeam?: string
    }
  /**
   * The walk-up song picker, on a phone: a player's song on one team. The
   * song there is now, if any, so Change opens on its clip.
   */
  | {
      name: 'walkUpSong'
      teamId: string
      userId: string
      playerName: string
      song: WalkUpSong | null
    }
  /**
   * Somebody on a team's, season's or league's people list, as that level
   * sees them: the profile its administrators, coaches and assistants manage
   * their roles from.
   */
  | {
      name: 'person'
      kind: 'league' | 'season' | 'team'
      id: string
      userId: string
      /** Their name, once the page has said it. */
      title?: string
    }

// Reporting starts as this module loads, once the modules it imports have run,
// so a failure from then on is reported. Both entry points, web and native,
// import this module.
startSentry()

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
      <ErrorBoundary fallback={errorScreen}>
        <Shell {...props} />
      </ErrorBoundary>
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
  const [backOverride, setBackOverride] = useState<(() => void) | null>(null)
  const setBack = useCallback((handler: (() => void) | null) => {
    setBackOverride(() => handler)
  }, [])

  const { initialToken, onToken } = props
  const client = useMemo(
    () =>
      new TeamStationClient({
        baseUrl: apiBaseUrl,
        token: initialToken,
        passwordKdf
      }),
    [apiBaseUrl, initialToken]
  )
  const scoringSource = useMemo(() => new ServerScoringSource(client), [client])
  const [roleRevision, setRoleRevision] = useState(0)
  const refreshRoles = useCallback((): void => {
    setRoleRevision(revision => revision + 1)
  }, [])
  /** Why chat's crypto core is not here, to the console and the server's log. */
  const reportChatCore = useMemo(
    () => chatCoreLog(apiBaseUrl, Platform.OS),
    [apiBaseUrl]
  )
  /**
   * A sign-in, or a sign-out, and what the platform should remember of it.
   *
   * `client.token` rather than `session.token`, because the two are not the
   * same thing: the client's is set by the four calls that actually sign
   * somebody in, while `whoAmI` returns a user and no token, and the session
   * built from it carries an empty string. Writing *that* through is how a
   * working session becomes a sign-in screen on the launch after next.
   */
  const rememberSession = useCallback(
    (next: Session | undefined): void => {
      setSession(next)
      refreshRoles()
      const token = next == null ? undefined : client.token
      onToken?.(token == null || token === '' ? undefined : token)
    },
    [client, onToken, refreshRoles]
  )
  const [session, setSession] = useState<Session | undefined>(undefined)
  const [hasPending, setHasPending] = useState(false)
  const notificationUser = session?.user.id
  const refreshNotifications = useCallback(async (): Promise<void> => {
    if (notificationUser == null) {
      setHasPending(false)
      return
    }
    try {
      setHasPending(await client.hasNotifications())
    } catch {
      setHasPending(false)
    }
  }, [client, notificationUser])
  useForegroundRefresh(refreshNotifications)
  // Until we have asked, we do not know whether anybody is signed in. Showing
  // the sign-in screen in the meantime is what made every link useless: the
  // cookie was there, nothing read it, and the address was thrown away.
  const [askedAboutSession, setAskedAboutSession] = useState(false)
  // Each list keeps its own filter. One value was how Videos, which opens on
  // Past, left Schedule on Past the next time it was opened.
  const [filters, setFilters] = useState<TabFilters>(() =>
    initialTabFilters(currentRoute())
  )
  const setVideosWhen = useCallback((next: When): void => {
    setFilters(current => withFilter(current, 'videos', next))
  }, [])
  const setScheduleWhen = useCallback((next: When): void => {
    setFilters(current => withFilter(current, 'schedule', next))
  }, [])
  /**
   * The invite code in the address, if the app was opened on one.
   *
   * Held apart from the tabs and their stacks, because an invitation is not a
   * place inside the app: it is a door in front of it, and the same door
   * whether the person arrives signed in, signed out, or with no account at
   * all. While it is up, the address is left exactly as it arrived — rewriting
   * `/i/demo2026` to `/` is how a link becomes unusable on a reload.
   */
  const [joining, setJoining] = useState<string | undefined>(() => {
    const route = currentRoute()
    return route.name === 'join' ? route.code : undefined
  })
  // The address bar is the state, not a copy of it: the app starts on
  // whatever was linked to, and every move writes the new address.
  const [tab, setTab] = useState<NavTabId>(() => tabOf(currentRoute()))
  const [successNotice, setSuccessNotice] = useState<SuccessNotice>()
  /**
   * The address the app is on, as state rather than as a reading.
   *
   * The signed-out half of this shell draws from the address directly — a
   * sign-in link, an invitation, or the form — and that is right, because none
   * of those is a place inside the app. But a reading taken during render only
   * changes what is drawn if something else re-renders, and following a link
   * into a signed-out app changes nothing else: the tab is already home and
   * the stack is already empty, so every setter below is a no-op and the
   * screen stays where it was. A browser never had the problem, because
   * following a link there is a navigation.
   */
  const [route, setRoute] = useState<Route>(() => currentRoute())
  // The address the app was opened on decides what is on the stack, so a link
  // to a game opens that game rather than the screen behind it.
  const [stacks, setStacks] = useState<Record<NavTabId, Pushed[]>>(() => {
    const opened = stackFor(currentRoute())
    return { home: [], videos: [], schedule: [], search: [], chat: [], ...opened }
  })
  const settingsVisitId = useRef(0)
  const [settingsVisit, setSettingsVisit] = useState(0)
  const scoringVisit = useRef<
    | (ScoringPlayerOrigin & {
        actor?: string | number
        history: number
        tab: NavTabId
        frames: Pushed[]
        child: Extract<Pushed, { name: 'player' }>
        refresh?: ScoringSettingsRefresh
      })
    | undefined
  >(undefined)
  const scoringApproved = useRef(false)
  const markScoringApproved = useCallback((): void => {
    scoringApproved.current = true
  }, [])
  const clearScoringVisit = useCallback(
    (held: NonNullable<typeof scoringVisit.current>): void => {
      if (scoringVisit.current !== held) return
      scoringVisit.current = undefined
      scoringApproved.current = false
      setStacks(current => ({
        ...current,
        [held.tab]: held.frames.slice(0, -1)
      }))
    },
    []
  )
  const scoringLeave = useRef<(() => Promise<boolean>) | undefined>(undefined)
  const scoringRefresh = useRef<ScoringSettingsRefresh | undefined>(undefined)
  const registerScoringLeave = useCallback((check: () => Promise<boolean>) => {
    scoringLeave.current = check
    return () => {
      if (scoringLeave.current === check) scoringLeave.current = undefined
    }
  }, [])
  const registerScoringRefresh = useCallback(
    (refresh: ScoringSettingsRefresh) => {
      scoringRefresh.current = refresh
      return () => {
        if (scoringRefresh.current === refresh)
          scoringRefresh.current = undefined
      }
    },
    []
  )
  const allowScoringChild = useCallback(
    (route: Route): boolean =>
      isScoringPlayerChild(route, scoringVisit.current) ||
      isScoringPlayerReturn(route, scoringVisit.current),
    []
  )
  const afterScoringLeave = (move: () => void): void => {
    const visit = scoringVisit.current
    if (visit == null) {
      move()
      return
    }
    scoringLeave
      .current?.()
      .then(accepted => {
        if (accepted && scoringVisit.current === visit) {
          clearScoringVisit(visit)
          move()
        }
      })
      .catch(() => undefined)
  }

  // The chat crypto bench, in a phone build made for it, needs no account and
  // no server, so it never asks who is signed in.
  const benching = route.name === 'chatBench'
  const needsSession = props.fieldPreview !== true && !benching

  /**
   * The roles the signed-in person holds, refreshed after permission changes.
   *
   * For the few things no other answer carries — whether to offer a player's
   * Settings or Walk-up tab — and never trusted for more than drawing: every write is
   * decided again on the server. A failure reads as no roles, so the worst it
   * can do is hide a tab.
   */
  const signedInAs = session?.user.id
  const [roleSnapshot, setRoleSnapshot] = useState<{
    actor: string | number
    client: TeamStationClient
    revision: number
    roles: MyRoles
  }>()
  const myRoles =
    roleSnapshot != null &&
    roleSnapshot.actor === signedInAs &&
    roleSnapshot.client === client &&
    roleSnapshot.revision === roleRevision
      ? roleSnapshot.roles
      : undefined
  useEffect(() => {
    const visit = scoringVisit.current
    if (visit != null && visit.actor !== signedInAs) {
      scoringVisit.current = undefined
    }
  }, [signedInAs])
  const isAdmin = session?.user.isAdmin === true
  useSentryUser(signedInAs)

  /**
   * The one socket every screen hears a game's changes on, for as long as
   * somebody is signed in. It connects only once a screen subscribes.
   */
  const gameSocket = useMemo(
    () =>
      signedInAs == null
        ? undefined
        : new GameSocket({ baseUrl: apiBaseUrl, token: client.token }),
    [apiBaseUrl, client, signedInAs]
  )
  useEffect(
    () => () => {
      gameSocket?.close()
    },
    [gameSocket]
  )
  /**
   * The chat engine, for as long as somebody is signed in. It hears the
   * socket's chat hints from the start, so they arrive on every screen; it
   * touches no keys until a chat screen starts it.
   */
  const chatEngine = useMemo(
    () =>
      signedInAs == null || gameSocket == null
        ? undefined
        : new ChatEngine({
            client,
            store: keyStore,
            userId: signedInAs,
            device: thisDevice(),
            socket: gameSocket
          }),
    [client, gameSocket, signedInAs]
  )
  /**
   * The chat list as last read, for the Chat tab's unread dot and the links
   * to a team's, season's or league's chats. Read once at sign-in (no keys
   * are needed for the list) and kept current from the engine's hints.
   */
  const [chatList, setChatList] = useState<ConversationListItem[]>([])
  useEffect(() => {
    setChatList([])
    if (chatEngine == null) return
    let live = true
    const unsubscribe = chatEngine.subscribe(event => {
      if (live && event.type === 'conversations') {
        setChatList(chatEngine.conversations())
      }
    })
    chatEngine
      .refresh()
      .then(list => {
        if (live) setChatList(list)
      })
      .catch(() => undefined)
    return () => {
      live = false
      unsubscribe()
    }
  }, [chatEngine])
  const chatsOf = (type: 'team' | 'season', id: string): ChatLink[] =>
    chatList
      .filter(chat => chat.scope?.type === type && chat.scope.id === id)
      .map(chat => ({ id: chat.id, title: chat.title }))
  useEffect(() => {
    if (chatEngine == null) return
    let stopListening = (): void => {}
    try {
      stopListening = chatEngine.listen()
    } catch {
      // A platform with no socket address has no live chat hints.
    }
    return () => {
      stopListening()
      chatEngine.stop()
    }
  }, [chatEngine])
  useEffect(() => {
    setRoleSnapshot(undefined)
    if (signedInAs == null) return
    let live = true
    client
      .myRoles()
      .then(roles => {
        if (live)
          setRoleSnapshot({
            actor: signedInAs,
            client,
            revision: roleRevision,
            roles
          })
      })
      .catch(() => {
        if (live)
          setRoleSnapshot({
            actor: signedInAs,
            client,
            revision: roleRevision,
            roles: { teams: {}, guardianOf: [] }
          })
      })
    return () => {
      live = false
    }
  }, [client, signedInAs, roleRevision])

  // The session lives in an `HttpOnly` cookie this code cannot read, so the
  // only way to know is to ask.
  useEffect(() => {
    if (!needsSession) {
      setAskedAboutSession(true)
      return
    }
    let live = true
    client
      .whoAmI()
      .then(user => {
        if (!live) return
        if (user != null) {
          setSession({ token: '', expiresAt: '', user })
          return
        }
        // A token that was kept and is no longer good. Sessions last thirty
        // days and nothing refreshes them, so this is the ordinary end of one
        // rather than a fault: throw it away, or every launch from here on
        // sends a dead token and is answered 401 by every screen.
        if (client.token != null) {
          client.token = undefined
          onToken?.(undefined)
        }
      })
      .catch(() => undefined)
      .finally(() => {
        if (live) setAskedAboutSession(true)
      })
    return () => {
      live = false
    }
  }, [client, needsSession, onToken])

  /**
   * A link to a team or a season is still being turned into a screen.
   *
   * Until it is, this app is sitting on an empty home stack, and the effect
   * below would helpfully write `/` over the very address being resolved.
   */
  const resolvingLink = useRef(false)

  // A team or a season link carries only an id, and the screens want the whole
  // summary to draw a header. Resolve it on arrival, rather than landing on the
  // home screen and rewriting the address — which threw the link away.
  //
  // This keys off `route`, which changes only when an *address* is handed to
  // the app — opening cold, a universal link, Android's Back. It deliberately
  // does not fire on ordinary navigation, or tapping a team on the home screen
  // would fetch the whole team list again to push a screen already pushed.
  //
  // It has to be every address and not just the first, because `stackFor` has
  // no answer for a team or a season: it returns an empty stack for them, so a
  // link that arrives while the app is *running* would empty the tab and stop
  // there, on Home. Cold start only worked because this ran on mount.
  useEffect(() => {
    if (props.fieldPreview === true) return
    if (route.name !== 'season') return
    let live = true
    resolvingLink.current = true
    const find = async (): Promise<void> => {
      const seasons = await client.seasons()
      const season = seasons.find(item => item.id === route.seasonId)
      if (live && season != null) {
        push({ name: 'season', season, tab: route.tab, when: route.when })
      }
    }
    find()
      .catch(() => undefined)
      .finally(() => {
        // Whether or not it resolved. A team that has since been deleted must
        // not leave the address frozen for the rest of the launch.
        if (live) resolvingLink.current = false
      })
    return () => {
      live = false
      resolvingLink.current = false
    }
    // `push` is recreated every render and would restart the fetch each time.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [client, route, props.fieldPreview])

  const stack = stacks[tab]
  const top = stack[stack.length - 1]

  // Somebody else's grant reaches this person in the inbox with nothing to
  // accept, so what they may do is read again whenever the inbox, or one of
  // its notifications, opens: a role just given shows at once.
  const inboxOpened =
    top?.name === 'notifications'
      ? 'inbox'
      : top?.name === 'notification'
        ? top.id
        : undefined
  useEffect(() => {
    if (inboxOpened != null) refreshRoles()
  }, [inboxOpened, refreshRoles])

  // Where the open player page's walk-up song is on this phone. One function
  // per page, not per render: the tab asks again whenever it changes.
  const [walkUpSettings] = useWalkUpPreferences()
  const walkUpTeam = top?.name === 'player' ? top.onTeam : undefined
  const walkUpPlayer = top?.name === 'player' ? top.userId : undefined
  // Where a DJ Game row's song is on this phone, for any team's player.
  const resolveDjSong = useMemo(
    () =>
      walkUpMusic.available
        ? async (song: WalkUpSong, owner: { teamId: string; userId: string }) =>
            await resolveSong(walkUpMusic, song, owner)
        : undefined,
    []
  )
  const resolveWalkUp = useMemo(
    () =>
      walkUpTeam == null || walkUpPlayer == null || !walkUpMusic.available
        ? undefined
        : async (song: WalkUpSong) =>
            await resolveSong(walkUpMusic, song, {
              teamId: walkUpTeam,
              userId: walkUpPlayer
            }),
    [walkUpTeam, walkUpPlayer]
  )

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
    if (
      session == null &&
      !(tab === 'search' && top == null) &&
      top?.name !== 'discover' &&
      top?.name !== 'group' &&
      top?.name !== 'team'
    )
      return
    // Nor while an invitation is open, for the same reason.
    if (joining != null) return
    if (route.name === 'oauthApprove' || route.name === 'oauthNative') return
    // Nor between a team or season link arriving and its screen being pushed.
    if (resolvingLink.current) return
    showRoute(
      routeOf(tab, top, filters),
      firstRender.current || inPlace.current
    )
    firstRender.current = false
    inPlace.current = false
  }, [joining, session, tab, top, filters, route.name])

  const goToRoute = useCallback(
    (route: Route, onHandled?: (accepted: boolean) => void): void => {
      let visit = scoringVisit.current
      if (visit != null && scoringApproved.current) {
        clearScoringVisit(visit)
        visit = undefined
      }
      if (
        visit != null &&
        !isScoringPlayerChild(route, visit) &&
        !isScoringPlayerReturn(route, visit)
      ) {
        const check = scoringLeave.current
        if (check == null) {
          onHandled?.(false)
          return
        }
        check()
          .then(accepted => {
            if (!accepted || scoringVisit.current !== visit) {
              onHandled?.(false)
              return
            }
            clearScoringVisit(visit)
            goToRoute(route)
            onHandled?.(true)
          })
          .catch(() => onHandled?.(false))
        return
      }
      setSettingsVisit(++settingsVisitId.current)
      setRoute(route)
      setJoining(route.name === 'join' ? route.code : undefined)
      const next = visit?.tab ?? tabOf(route)
      setTab(next)
      setStacks(current => {
        if (visit != null && isScoringPlayerReturn(route, visit))
          return { ...current, [next]: visit.frames }
        if (
          visit != null &&
          route.name === 'player' &&
          isScoringPlayerChild(route, visit)
        )
          return {
            ...current,
            [next]: [...visit.frames, { ...visit.child, ...route }]
          }
        const held = current[next]
        // Browser Back from a team management flow returns to its settings
        // frame, retaining the team and its selected section underneath.
        const at =
          route.name === 'groupSettings' && route.kind === 'team'
            ? held.findLastIndex(
                item =>
                  item.name === 'groupSettings' &&
                  item.kind === 'team' &&
                  item.id === route.id &&
                  item.teamReturn?.id === route.teamReturn?.id &&
                  item.teamReturn?.address === route.teamReturn?.address &&
                  item.teamReturn?.tab === route.teamReturn?.tab
              )
            : -1
        return {
          ...current,
          [next]:
            at >= 0 ? held.slice(0, at + 1) : (stackFor(route)[next] ?? [])
        }
      })
      // The shell writes the address from these filters. Leaving them stale
      // replaces the route just parsed — a sign-in `?next=/schedule?when=past`
      // would open Upcoming.
      setFilters(current => filtersForRoute(current, route))
      onHandled?.(true)
    },
    [clearScoringVisit]
  )
  useBrowserBack(goToRoute)

  /** The tab, or — pressed on the tab you are already on — a step out of it. */
  const selectTab = (next: NavTabId): void => {
    if (scoringVisit.current != null) {
      afterScoringLeave(() => {
        selectTab(next)
      })
      return
    }
    setTab(next)
    setStacks(current => stacksAfterTabPress(current, tab, next))
    if (session == null || props.fieldPreview === true) {
      if (next === tab) return
      const destination = routeOf(next, undefined, filters)
      setRoute(destination)
      setJoining(undefined)
      showRoute(destination)
    }
  }

  const push = (next: Pushed): void => {
    if (scoringVisit.current != null) {
      afterScoringLeave(() => {
        push(next)
      })
      return
    }
    setStacks(current => ({ ...current, [tab]: [...current[tab], next] }))
  }
  const openGroup = useCallback(
    (group: GroupRef): void => {
      setStacks(current => ({
        ...current,
        [tab]: [...current[tab], { name: 'group', ...group }]
      }))
    },
    [tab]
  )
  const replace = (next: Pushed): void => {
    setStacks(current => ({
      ...current,
      [tab]: [...current[tab].slice(0, -1), next]
    }))
  }
  const openPrivateGroup = async (group: GroupRef): Promise<void> => {
    if (group.kind === 'team') {
      const team = (await client.teams()).find(team => team.id === group.id)
      if (team != null) push({ name: 'team', team })
    } else {
      const season = (await client.seasons()).find(
        season => season.id === group.id
      )
      if (season != null) push({ name: 'season', season })
    }
  }
  const pop = (): void => {
    if (
      top?.name === 'player' &&
      isScoringPlayerChild({ ...top, name: 'player' }, scoringVisit.current)
    ) {
      const synchronous = backFromScoringPlayer(scoringVisit.current?.history)
      // Native history has no popstate callback for the header chevron.
      if (synchronous) {
        setStacks(current => ({
          ...current,
          [tab]: scoringVisit.current?.frames ?? current[tab].slice(0, -1)
        }))
        inPlace.current = true
      }
      return
    }
    // The address goes back with the screen. On the web the browser owns the
    // history and this does nothing; on a phone the two are kept by hand, and
    // a chevron that left a step behind would make the next press of the
    // system Back button appear to do nothing.
    popRoute()
    setStacks(current => ({ ...current, [tab]: current[tab].slice(0, -1) }))
  }

  const openGame = (
    gameId: string,
    title: string,
    options: {
      tab?: 'watch' | 'boxScore'
      autoPlay?: boolean
      pendingRequestId?: string | null
    } = {}
  ): void => {
    const { pendingRequestId, ...presentation } = options
    if (pendingRequestId != null) {
      push({ name: 'notification', id: pendingRequestId })
    } else push({ name: 'game', gameId, title, ...presentation })
  }
  /** A section change on the team or season screen, into the address. */
  const setTopTab = (next: string, correcting = false): void => {
    if (correcting) inPlace.current = true
    const frame = stacks[tab].at(-1)
    if (frame?.name === 'player' && frame.tab !== next) {
      if (next === 'settings') setSettingsVisit(++settingsVisitId.current)
      if (
        isScoringPlayerChild(routeOf(tab, frame, filters), scoringVisit.current)
      )
        inPlace.current = true
    }
    setStacks(current => {
      const held = current[tab]
      const last = held[held.length - 1]
      if (
        last?.name !== 'team' &&
        last?.name !== 'season' &&
        last?.name !== 'group' &&
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
  /** The Videos filter, on the address, put back in place as Stats' is. */
  const setPlayerVideoFilter = (next: {
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
            tab: 'videos' as const,
            videoSeasonId: next.seasonId,
            videoTeamId: next.teamId,
            videoYear: next.year
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
    refreshRoles()
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
   * A player just taken off a team from their Settings: back to that team's
   * roster, the step below when it is the team, otherwise in the player's
   * place, so Back does not return to a page they are no longer on.
   */
  const backToRoster = (teamId: string, name: string): void => {
    const below = stack[stack.length - 2]
    if (below?.name === 'team' && below.team.id === teamId) {
      popRoute()
      setStacks(current => ({
        ...current,
        [tab]: [...current[tab].slice(0, -2), { ...below, tab: 'team' }]
      }))
    } else {
      replace({
        name: 'team',
        team: asTeamSummary({
          id: teamId,
          name,
          shortName: null,
          logoPath: null
        }),
        tab: 'team'
      })
    }
  }
  const openSeasonParticipant = (team: TeamSummary): void => {
    push(seasonParticipantDestination(team))
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
  const openPlayer = useCallback(
    (
      userId: number,
      title: string,
      from: { seasonId?: string; teamId?: string; onTeam?: string } = {}
    ): void => {
      const narrowed = from.seasonId != null || from.teamId != null
      const next: Pushed = {
        name: 'player',
        userId: String(userId),
        title,
        tab: narrowed ? 'stats' : undefined,
        seasonId: from.seasonId,
        teamId: from.teamId,
        onTeam: from.onTeam
      }
      setStacks(current => ({ ...current, [tab]: [...current[tab], next] }))
    },
    [tab]
  )
  /** Somebody on a people list, as the level it was opened from sees them. */
  const openPerson = (
    group: { kind: 'league' | 'season' | 'team'; id: string },
    userId: number,
    title: string
  ): void => {
    push({
      name: 'person',
      kind: group.kind,
      id: group.id,
      userId: String(userId),
      title
    })
  }
  const openSeason = (season: SeasonSummary): void => {
    push({ name: 'season', season })
  }
  /** A chat, from the list or from a team's, season's or league's page. */
  const openChat = (chat: { id: string; title: string }): void => {
    push({ name: 'conversation', conversationId: chat.id, title: chat.title })
  }
  /**
   * What every chat screen stands behind: chat's crypto core on this
   * platform, then this device set up for chat.
   */
  const gated = (screen: React.ReactNode): React.ReactNode =>
    chatEngine == null || session == null ? null : (
      <ChatCoreGate onUnavailable={reportChatCore}>
        <ChatGate engine={chatEngine} client={client} userId={session.user.id}>
          {screen}
        </ChatGate>
      </ChatCoreGate>
    )
  /**
   * Somebody who has just signed in, back to where the sign-in was for.
   *
   * A sign-in reached with `?next=` — the override dashboard sends a
   * visitor whose session has lapsed there — returns to that address rather
   * than to the home screen.
   */
  const signedIn = (next: Session): void => {
    rememberSession(next)
    if (route.name === 'signIn' && route.next != null) {
      const [path, search = ''] = route.next.split('?')
      const destination = parseRoute(path, search)
      goToRoute(destination)
      if (
        destination.name === 'oauthApprove' ||
        destination.name === 'oauthNative'
      )
        showRoute(destination, true)
    }
  }

  if (
    askedAboutSession &&
    (route.name === 'oauthApprove' || route.name === 'oauthNative')
  ) {
    return (
      <View style={styles.app}>
        <AppHeader
          apiBaseUrl={apiBaseUrl}
          isAdmin={isAdmin}
          title={lstrings.oauth_title}
          showMark
          buildsClient={session == null ? undefined : client}
          onBack={
            route.name !== 'oauthNative'
              ? undefined
              : () => {
                  const destination: Route = { name: 'home' }
                  goToRoute(destination)
                  showRoute(destination, true)
                }
          }
        />
        <OAuthScreen
          key={routePath(route)}
          client={client}
          uid={route.name === 'oauthApprove' ? route.uid : undefined}
          handle={route.name === 'oauthNative' ? route.handle : undefined}
          accountName={session?.user.displayName}
          onSwitchAccount={
            route.name !== 'oauthApprove'
              ? undefined
              : async () => {
                  await client.signOut()
                  rememberSession(undefined)
                  const destination: Route = {
                    name: 'signIn',
                    next: routePath(route)
                  }
                  goToRoute(destination)
                  showRoute(destination)
                }
          }
          onLogin={() => {
            const destination: Route = {
              name: 'signIn',
              next: routePath(route)
            }
            goToRoute(destination)
            showRoute(destination)
          }}
        />
      </View>
    )
  }

  // Before the session check, as the field preview is: the bench build is
  // never signed in to anything.
  if (benching && ChatBench != null) {
    return (
      <View style={styles.app}>
        <ChatBench />
      </View>
    )
  }

  const publicSurface =
    (tab === 'search' && top == null) ||
    top?.name === 'discover' ||
    top?.name === 'group' ||
    top?.name === 'team'
  if (session == null && props.fieldPreview !== true && !publicSurface) {
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
            accessibilityLabel="TeamStation"
            source={tsLogoSource}
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
    // whole point of it. A link that is no longer good goes on to the form,
    // replacing its own address so Back does not return to the dead link; one
    // that may still work stays behind it in the history.
    return (
      <View style={styles.app}>
        <AppHeader
          apiBaseUrl={apiBaseUrl}
          isAdmin={isAdmin}
          title={route.name === 'join' ? lstrings.join_header : 'Sign in'}
          showMark
          nav={
            isWide ? (
              <AppNav
                mode="header"
                selected={tab}
                onSelect={selectTab}
                dots={{ chat: hasUnread(chatList) }}
              />
            ) : undefined
          }
        />
        {route.name === 'join' ? (
          <JoinScreen
            client={client}
            code={route.code}
            signedIn={false}
            onSignedIn={rememberSession}
            onOpen={openFromInvite}
          />
        ) : route.name === 'signInLink' ? (
          <SignInLinkScreen
            key={route.token}
            client={client}
            token={route.token}
            server={route.server}
            onSignedIn={rememberSession}
            onSignInAgain={linkSpent => {
              const destination: Route = { name: 'signIn' }
              goToRoute(destination)
              showRoute(destination, linkSpent)
            }}
          />
        ) : (
          <LoginScreen
            client={client}
            onSignedIn={signedIn}
            onDiscover={() => {
              goToRoute({ name: 'discover' })
              showRoute({ name: 'discover' })
            }}
          />
        )}
        {!isWide && (
          <AppNav mode="floating" selected={tab} onSelect={selectTab} />
        )}
      </View>
    )
  }

  if (
    session?.user.onboarding != null &&
    session.user.onboarding.step !== 'complete'
  ) {
    return (
      <View style={styles.app}>
        <AppHeader title="Welcome to TeamStation" showMark />
        <OnboardingScreen
          client={client}
          initialName={session.user.displayName}
          initialState={session.user.onboarding}
          onComplete={async () => {
            const user = await client.whoAmI()
            if (user == null) throw new Error('Please sign in again')
            setSession(current =>
              current == null ? undefined : { ...current, user }
            )
          }}
        />
      </View>
    )
  }

  if (joining != null) {
    return (
      <View style={styles.app}>
        <AppHeader
          apiBaseUrl={apiBaseUrl}
          isAdmin={isAdmin}
          title={lstrings.join_header}
          showMark
          buildsClient={client}
        />
        <JoinScreen
          client={client}
          code={joining}
          signedIn
          onSignedIn={rememberSession}
          onOpen={openFromInvite}
        />
      </View>
    )
  }

  const visit = scoringVisit.current
  const retainedFrame =
    visit != null &&
    visit.actor === signedInAs &&
    (top?.name === 'player' || top?.name === 'scoreGame')
      ? visit.frames.at(-1)
      : undefined
  const scoringFrame =
    props.fieldPreview === true
      ? undefined
      : top?.name === 'scoreGame'
        ? top
        : retainedFrame?.name === 'scoreGame'
          ? retainedFrame
          : undefined
  const scoringActive = scoringFrame != null && top?.name === 'scoreGame'
  const scoringBody =
    scoringFrame == null ? undefined : (
      <ScoringScreen
        key={`${signedInAs ?? 'local'}:${scoringFrame.gameId}`}
        userId={signedInAs}
        client={client}
        source={scoringSource}
        gameId={scoringFrame.gameId}
        active={scoringActive}
        onBeforeLeave={registerScoringLeave}
        onSettingsRefresh={registerScoringRefresh}
        allowNavigation={allowScoringChild}
        onNavigationApproved={markScoringApproved}
        music={walkUpMusic}
        resolveSong={resolveDjSong}
        fadeAppleMusic={walkUpSettings.fadeAppleMusic}
        onEditPlayer={(userId, title, teamId) => {
          refreshRoles()
          scoringApproved.current = false
          // Each Settings form gets a fresh player view, so an earlier
          // form cannot change its header after it has been replaced.
          setSettingsVisit(++settingsVisitId.current)
          const child: Extract<Pushed, { name: 'player' }> = {
            name: 'player',
            userId: String(userId),
            title,
            tab: 'settings',
            onTeam: teamId
          }
          scoringVisit.current = {
            gameId: scoringFrame.gameId,
            actor: signedInAs,
            userId: child.userId,
            teamId,
            history: scoringOriginHistory(),
            tab,
            frames: stack,
            child,
            refresh: scoringRefresh.current
          }
          setStacks(current => ({ ...current, [tab]: [...stack, child] }))
        }}
        onExit={() => {
          scoringVisit.current = undefined
          inPlace.current = true
          setStacks(current => ({ ...current, [tab]: [] }))
          goToRoute({ name: 'game', gameId: scoringFrame.gameId })
        }}
      />
    )
  const body =
    props.fieldPreview === true ? (
      <StandaloneField
        onExit={() => {
          selectTab('home')
        }}
      />
    ) : top == null ? (
      tab === 'home' ? (
        <HomeScreen
          client={client}
          onOpenTeam={openTeam}
          onOpenSeason={openSeason}
          onOpenGame={openGame}
          onCreateGroup={kind => {
            push({ name: 'createGroup', kind })
          }}
          leagueChats={chatList.flatMap(chat =>
            chat.kind === 'leagueOrg'
              ? [
                  {
                    id: chat.id,
                    title: chat.title,
                    league: chat.scopeName ?? chat.title
                  }
                ]
              : []
          )}
          onOpenChat={openChat}
          onOpenGroup={openGroup}
          onOpenPlayer={openPlayer}
        />
      ) : tab === 'search' ? (
        <DiscoverScreen
          key="search"
          client={client}
          onOpen={openGroup}
          follow={session != null}
        />
      ) : tab === 'chat' ? (
        gated(
          <ChatListScreen
            engine={chatEngine!}
            onOpen={openChat}
            onNewMessage={() => {
              push({ name: 'chatNew' })
            }}
            onFollowTeam={() => {
              push({ name: 'followTeam' })
            }}
          />
        )
      ) : tab === 'videos' ? (
        <GamesFeedScreen
          key="videos"
          client={client}
          mode="videos"
          initialWhen={filters.videos}
          onWhenChange={setVideosWhen}
          onOpenGame={openGame}
        />
      ) : (
        <GamesFeedScreen
          key="schedule"
          client={client}
          mode="schedule"
          initialWhen={filters.schedule}
          onWhenChange={setScheduleWhen}
          onOpenGame={openGame}
        />
      )
    ) : top.name === 'discover' ? (
      <DiscoverScreen
        key={`${top.kind ?? 'team'}:${top.follow === true}`}
        client={client}
        onOpen={openGroup}
        initialKind={top.kind}
        follow={top.follow === true && session != null}
      />
    ) : top.name === 'createGroup' ? (
      <CreateGroupScreen
        client={client}
        kind={top.kind}
        parent={top.parent}
        custodian={top.custodian}
        onCreated={group => {
          refreshRoles()
          replace({ name: 'group', ...group })
        }}
        onCancel={pop}
      />
    ) : top.name === 'group' ? (
      <GroupScreen
        client={client}
        groupRef={{ kind: top.kind, id: top.id }}
        initialTab={top.tab}
        onTab={setTopTab}
        initialWhen={top.when}
        onWhen={next => {
          setStacks(current => {
            const held = current[tab]
            const last = held.at(-1)
            if (last?.name !== 'group' || last.when === next) return current
            return {
              ...current,
              [tab]: [...held.slice(0, -1), { ...last, when: next }]
            }
          })
        }}
        onOpenGame={openGame}
        onOpen={openGroup}
        onOpenTeam={openSeasonParticipant}
        onOpenPlayer={openPlayer}
        onOpenPerson={openPerson}
        onCreate={(kind, parent) => {
          push({ name: 'createGroup', kind, parent })
        }}
        onSettings={group => {
          push({
            name: 'groupSettings',
            ...group,
            ...(group.kind === 'team'
              ? {
                  teamReturn: {
                    id: top.id,
                    address: 'group' as const,
                    tab: top.tab
                  }
                }
              : {})
          })
        }}
        onLink={choice => {
          push({
            name: 'groupLink',
            kind: choice.subject.kind,
            id: choice.subject.id,
            targetKind: choice.targetKind,
            relationship: choice.relationship,
            direction: choice.direction
          })
        }}
        onPrivate={group => {
          openPrivateGroup(group).catch(() => undefined)
        }}
        onPromote={group => {
          push({ name: 'promoteExternal', id: group.id })
        }}
        onCreateExternal={custodian => {
          push({ name: 'createGroup', kind: 'team', custodian })
        }}
        onCreateGame={group => {
          if (group.kind !== 'league')
            push({ name: 'createGame', kind: group.kind, id: group.id })
        }}
        onOpenRequest={id => {
          push({ name: 'notification', id })
        }}
      />
    ) : top.name === 'groupSettings' ? (
      <GroupSettingsScreen
        key={`${top.kind}:${top.id}:${settingsVisit}`}
        client={client}
        groupRef={{ kind: top.kind, id: top.id }}
        onLink={choice => {
          push({
            name: 'groupLink',
            kind: choice.subject.kind,
            id: choice.subject.id,
            targetKind: choice.targetKind,
            relationship: choice.relationship,
            direction: choice.direction
          })
        }}
        onChanged={refreshRoles}
        onRequest={id => {
          push({ name: 'notification', id })
        }}
        onCancel={pop}
        onCreateGame={group => {
          if (group.kind === 'team')
            push({ name: 'createGame', kind: 'team', id: group.id })
        }}
        onCreateExternal={custodian => {
          push({ name: 'createGroup', kind: 'team', custodian })
        }}
        onPromote={group => {
          push({ name: 'promoteExternal', id: group.id })
        }}
        onSaved={() => {
          if (settingsVisitId.current !== settingsVisit) return
          refreshRoles()
          pop()
        }}
      />
    ) : top.name === 'nodeAdministration' ? (
      <NodeAdministrationScreen
        client={client}
        onChanged={userId => {
          refreshRoles()
          if (session?.user.id === userId)
            client
              .whoAmI()
              .then(user => {
                const updated =
                  user == null || session == null
                    ? undefined
                    : { ...session, user }
                setSession(updated)
                rememberSession(updated)
                pop()
              })
              .catch(() => undefined)
        }}
      />
    ) : top.name === 'gameSettings' ||
      (top.name === 'createGame' && top.gameId != null) ? (
      <GameSettingsScreen
        client={client}
        gameId={top.gameId!}
        onSaved={(result: GameSettingsResult) => {
          setSuccessNotice({
            id: Date.now(),
            message:
              result.status === 'pending'
                ? 'Game proposal sent'
                : 'Game changes saved'
          })
          if (
            result.status === 'accepted' &&
            result.gameId != null &&
            result.gameId !== top.gameId
          ) {
            replace({ name: 'game', gameId: result.gameId, title: '' })
          } else pop()
          refreshRoles()
          refreshNotifications().catch(() => undefined)
        }}
        onCancel={pop}
      />
    ) : top.name === 'createGame' ? (
      <CreateGameScreen
        client={client}
        source={{ kind: top.kind, id: top.id }}
        gameId={top.gameId}
        onSent={id => {
          replace({ name: 'notification', id })
          refreshRoles()
          refreshNotifications().catch(() => undefined)
        }}
        onCancel={pop}
      />
    ) : top.name === 'promoteExternal' ? (
      <PromoteExternalScreen
        client={client}
        teamId={top.id}
        onSent={id => {
          replace({ name: 'notification', id })
          refreshRoles()
          refreshNotifications().catch(() => undefined)
        }}
        onCancel={pop}
      />
    ) : top.name === 'groupLink' ? (
      <GroupLinkScreen
        client={client}
        choice={{
          subject: { kind: top.kind, id: top.id },
          targetKind: top.targetKind,
          relationship: top.relationship,
          direction: top.direction
        }}
        onSent={id => {
          replace({ name: 'notification', id })
          refreshRoles()
          refreshNotifications().catch(() => undefined)
        }}
        onCancel={pop}
      />
    ) : top.name === 'notifications' ? (
      <NotificationsScreen
        client={client}
        onOpen={id => {
          push({ name: 'notification', id })
        }}
      />
    ) : top.name === 'notification' ? (
      <NotificationDetailScreen
        client={client}
        id={top.id}
        onChanged={replacementId => {
          refreshRoles()
          if (replacementId != null)
            replace({ name: 'notification', id: replacementId })
          refreshNotifications().catch(() => undefined)
        }}
      />

    ) : top.name === 'conversation' ? (
      gated(
        <ConversationScreen
          key={top.conversationId}
          engine={chatEngine!}
          conversationId={top.conversationId}
          userId={session?.user.id ?? 0}
          onMembers={() => {
            push({ name: 'chatMembers', conversationId: top.conversationId })
          }}
          onTitle={title => {
            setStacks(current => {
              const held = current[tab]
              const last = held[held.length - 1]
              if (last?.name !== 'conversation' || last.title === title) {
                return current
              }
              return {
                ...current,
                [tab]: [...held.slice(0, -1), { ...last, title }]
              }
            })
          }}
        />
      )
    ) : top.name === 'chatMembers' ? (
      gated(
        <ChatMembersScreen
          engine={chatEngine!}
          client={client}
          conversationId={top.conversationId}
          userId={session?.user.id ?? 0}
          onLeft={() => {
            // Out of the chat and its members, back to the list.
            setStacks(current => ({
              ...current,
              [tab]: current[tab].filter(
                step =>
                  step.name !== 'chatMembers' && step.name !== 'conversation'
              )
            }))
          }}
        />
      )
    ) : top.name === 'chatNew' ? (
      gated(
        <NewDmScreen
          client={client}
          engine={chatEngine!}
          onCreated={conversation => {
            const listed = chatEngine
              ?.conversations()
              .find(chat => chat.id === conversation.id)
            // The new chat takes this screen's place, so Back goes to the
            // list rather than to a finished form.
            setStacks(current => ({
              ...current,
              [tab]: [
                ...current[tab].slice(0, -1),
                {
                  name: 'conversation',
                  conversationId: conversation.id,
                  title: listed?.title ?? conversation.title ?? ''
                }
              ]
            }))
          }}
        />
      )
    ) : top.name === 'chatDevices' ? (
      session == null ? null : (
        <ChatCoreGate onUnavailable={reportChatCore}>
          <ChatDevicesScreen client={client} userId={session.user.id} />
        </ChatCoreGate>
      )
    ) : top.name === 'chatReports' ? (
      session == null ? null : (
        <ChatReportsScreen client={client} isAdmin={session.user.isAdmin} />
      )
    ) : top.name === 'chatLink' ? (
      session == null ? null : (
        <ChatCoreGate onUnavailable={reportChatCore}>
          <LinkDeviceScreen
            client={client}
            userId={session.user.id}
            onDone={() => {
              // Linked or reset: the devices list takes this screen's place,
              // so Back does not return to a finished link.
              setStacks(current => ({
                ...current,
                [tab]: [...current[tab].slice(0, -1), { name: 'chatDevices' }]
              }))
            }}
          />
        </ChatCoreGate>
      )
    ) : top.name === 'account' && session != null ? (
      <AccountScreen
        client={client}
        onNodeAdministration={() => {
          push({ name: 'nodeAdministration' })
        }}
        onAccountChanged={user => {
          setSession(current =>
            current?.user.id !== user.id ? current : { ...current, user }
          )
        }}
        session={session}
        onChatDevices={() => {
          push({ name: 'chatDevices' })
        }}
        onChatReports={() => {
          push({ name: 'chatReports' })
        }}
        onSignOut={() => {
          client.signOut().catch(() => undefined)
          rememberSession(undefined)
          setStacks({ home: [], videos: [], schedule: [], search: [], chat: [] })
          setTab('home')
        }}
      />
    ) : top.name === 'player' ? (
      <PlayerScreen
        key={`${signedInAs ?? 'signed-out'}:${top.userId}:${top.onTeam ?? ''}:${visit == null ? '' : settingsVisit}`}
        client={client}
        userId={top.userId}
        title={top.title}
        initialTab={top.tab}
        initialFilter={{
          seasonId: top.seasonId,
          teamId: top.teamId,
          year: top.year
        }}
        initialVideoFilter={{
          seasonId: top.videoSeasonId,
          teamId: top.videoTeamId,
          year: top.videoYear
        }}
        onTab={setTopTab}
        forTeam={top.onTeam}
        onSettingsSaved={() => {
          if (
            top.onTeam != null &&
            visit != null &&
            scoringVisit.current?.gameId === visit.gameId &&
            scoringVisit.current.actor === visit.actor &&
            scoringRefresh.current === visit.refresh
          )
            scoringRefresh.current?.()
        }}
        roles={myRoles}
        viewer={
          signedInAs == null ? undefined : { userId: signedInAs, isAdmin }
        }
        walkUp={{
          resolve: resolveWalkUp,
          onPick:
            top.onTeam == null || !walkUpMusic.available
              ? undefined
              : (song, playerName) => {
                  push({
                    name: 'walkUpSong',
                    teamId: top.onTeam ?? '',
                    userId: top.userId,
                    playerName,
                    song
                  })
                },
          fadeAppleMusic: walkUpSettings.fadeAppleMusic
        }}
        music={walkUpMusic}
        onFilter={setPlayerFilter}
        onVideoFilter={setPlayerVideoFilter}
        onOpenTeam={(teamId, name) => {
          openTeam(
            asTeamSummary({
              id: teamId,
              name,
              shortName: null,
              logoPath: null
            })
          )
        }}
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
        onRemovedFromTeam={(teamId, name, notice) => {
          setSuccessNotice({ id: Date.now(), message: notice })
          backToRoster(teamId, name)
          refreshRoles()
        }}
      />
    ) : top.name === 'walkUpSong' ? (
      <WalkUpSongScreen
        client={client}
        music={walkUpMusic}
        teamId={top.teamId}
        userId={top.userId}
        song={top.song}
        resolve={async song =>
          await resolveSong(walkUpMusic, song, {
            teamId: top.teamId,
            userId: top.userId
          })
        }
        fadeAppleMusic={walkUpSettings.fadeAppleMusic}
        onSaved={pop}
      />
    ) : top.name === 'team' ? (
      <TeamPage
        client={client}
        id={top.team.id}
        team={top.team}
        onOpenGame={openGame}
        onOpenPlayer={openPlayer}
        onOpenPerson={(userId, name, teamId) => {
          openPerson({ kind: 'team', id: teamId }, userId, name)
        }}
        onSettings={id => {
          push({
            name: 'groupSettings',
            kind: 'team',
            id,
            teamReturn: { id: top.team.id, address: 'team', tab: top.tab }
          })
        }}
        initialTab={top.tab}
        onTab={setTopTab}
        chats={chatsOf('team', top.team.id)}
        onOpenChat={openChat}
      />
    ) : top.name === 'season' ? (
      <SeasonScreen
        client={client}
        season={top.season}
        onOpenGame={openGame}
        onOpenTeam={openSeasonParticipant}
        onOpenPlayer={openPlayer}
        onOpenPerson={(userId, name) => {
          openPerson({ kind: 'season', id: top.season.id }, userId, name)
        }}
        onSettings={() => {
          push({ name: 'groupSettings', kind: 'season', id: top.season.id })
        }}
        initialTab={top.tab}
        onTab={setTopTab}
        chats={chatsOf('season', top.season.id)}
        onOpenChat={openChat}
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
    ) : top.name === 'person' ? (
      <PersonProfileScreen
        key={`${top.kind}:${top.id}:${top.userId}`}
        client={client}
        kind={top.kind}
        id={top.id}
        userId={Number(top.userId)}
        onOpenPlayer={openPlayer}
        onChanged={refreshRoles}
        onTitle={title => {
          setStacks(current => {
            const held = current[tab]
            const last = held[held.length - 1]
            if (last?.name !== 'person' || last.title === title) return current
            return {
              ...current,
              [tab]: [...held.slice(0, -1), { ...last, title }]
            }
          })
        }}
      />
    ) : top.name === 'djGame' && walkUpMusic.djSupported ? (
      <DjGameScreen
        // One instance per game: its walk-up songs are got ready once per
        // visit, and another game is another visit.
        key={top.gameId}
        client={client}
        gameId={top.gameId}
        socket={gameSocket}
        music={walkUpMusic}
        fadeAppleMusic={walkUpSettings.fadeAppleMusic}
        resolve={resolveDjSong}
        side={top.side}
        onSide={next => {
          setStacks(current => {
            const held = current[tab]
            const last = held[held.length - 1]
            if (last?.name !== 'djGame' || last.side === next) return current
            return {
              ...current,
              [tab]: [...held.slice(0, -1), { ...last, side: next }]
            }
          })
        }}
        onEditSong={(teamId, batter, song) => {
          push({
            name: 'walkUpSong',
            teamId,
            userId: String(batter.userId),
            playerName: batter.name,
            song
          })
        }}
      />
    ) : top.name === 'djGame' ? (
      // DJ Game is an iPhone's: on the web and Android its address shows
      // the game.
      <GameScreen
        client={client}
        gameId={top.gameId}
        onSettings={() => {
          push({ name: 'gameSettings', gameId: top.gameId })
        }}
        onFullScoring={() => {
          push({ name: 'scoreGame', gameId: top.gameId })
        }}
        onScoreboard={() => {
          push({ name: 'scoreboardOverride', gameId: top.gameId })
        }}
        onDjGame={() => {
          push({ name: 'djGame', gameId: top.gameId })
        }}
        music={walkUpMusic}
        onOpenPlayer={openPlayer}
        onOpenTeam={team => {
          push({ name: 'team', team })
        }}
      />
    ) : top.name === 'scoreboardOverride' ? (
      <ScoreboardOverrideScreen
        apiBaseUrl={apiBaseUrl}
        gameId={top.gameId}
        token={client.token}
        onSignIn={next => {
          rememberSession(undefined)
          const signIn: Route = { name: 'signIn', next }
          goToRoute(signIn)
          showRoute(signIn)
        }}
      />
    ) : top.name === 'scoreGame' ? null : top.name === 'game' ? (
      <GameScreen
        client={client}
        gameId={top.gameId}
        onSettings={() => {
          push({ name: 'gameSettings', gameId: top.gameId })
        }}
        onFullScoring={() => {
          push({ name: 'scoreGame', gameId: top.gameId })
        }}
        onScoreboard={() => {
          push({ name: 'scoreboardOverride', gameId: top.gameId })
        }}
        onDjGame={() => {
          push({ name: 'djGame', gameId: top.gameId })
        }}
        music={walkUpMusic}
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
        angles={top.angles}
        audioId={top.audio}
        onAngles={next => {
          // In place: arranging the tiles is not a new page, and a history
          // entry per drag would make Back mean "undo one drag".
          inPlace.current = true
          setStacks(current => {
            const held = current[tab]
            const last = held[held.length - 1]
            if (last?.name !== 'game') return current
            return {
              ...current,
              [tab]: [
                ...held.slice(0, -1),
                {
                  ...last,
                  angles: next.angles ?? last.angles,
                  // `null` clears, `undefined` leaves alone.
                  audio:
                    next.audio === undefined
                      ? last.audio
                      : (next.audio ?? undefined),
                  zoom:
                    next.zoom === undefined
                      ? last.zoom
                      : (next.zoom ?? undefined),
                  at: next.at === undefined ? last.at : (next.at ?? undefined)
                }
              ]
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
      apiBaseUrl={apiBaseUrl}
      isAdmin={isAdmin}
      buildsClient={session == null ? undefined : client}
      title={titleFor(tab, top)}
      // The mark on every screen that is a destination in its own right —
      // home, and the two lists — and on none that was pushed on top of one,
      // where the chevron and what scrolled up into the header say where you
      // are.
      showMark={top == null}
      handoff={
        visit != null &&
        top?.name === 'player' &&
        isScoringPlayerChild(top, visit) &&
        (visit.actor !== signedInAs || !managesRoster(myRoles, visit.teamId))
          ? undefined
          : handoff
      }
      onHeight={setHeaderHeight}
      nav={
        isWide ? (
          <AppNav
            mode="header"
            selected={tab}
            onSelect={selectTab}
            dots={{ chat: hasUnread(chatList) }}
          />
        ) : undefined
      }
      onBack={backOverride ?? (stack.length > 0 ? pop : undefined)}
      notifications={
        session == null
          ? undefined
          : {
              pending: hasPending,
              onPress: () => {
                if (top?.name !== 'notifications')
                  push({ name: 'notifications' })
              }
            }
      }
      account={
        session == null || top?.name === 'account'
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
  const immersiveField =
    props.fieldPreview === true || top?.name === 'scoreGame'

  return (
    <GestureHandlerRootView style={styles.root}>
      <View style={styles.app}>
        <View key="pane" style={styles.pane}>
          <HeaderSlotProvider
            headerHeight={immersiveField ? 0 : headerHeight}
            onHandoff={setHandoff}
            onBackOverride={setBack}
          >
            <View style={styles.body}>
              <ScoringPlayerSettingsFlow
                scoring={scoringBody}
                active={scoringActive}
              >
                {body}
              </ScoringPlayerSettingsFlow>
            </View>
          </HeaderSlotProvider>
          {!immersiveField && <View style={styles.headerLayer}>{header}</View>}
        </View>
        {!isWide && !immersiveField && (
          <AppNav
            key="nav"
            mode="floating"
            selected={tab}
            onSelect={selectTab}
            dots={{ chat: hasUnread(chatList) }}
          />
        )}
        <SuccessToast notice={successNotice} />
      </View>
    </GestureHandlerRootView>
  )
}

/**
 * The name of the screen you are on, never the name of the app.
 *
 * Home is `Your Home` rather than `TeamStation`, which the header already says
 * on the line above: the two together read `TEAMSTATION / TeamStation`, which
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
  // The Search tab's own first screen, with nothing pushed on it.
  if (tab === 'search') return {}
  if (route.name === 'team')
    return {
      [tab]: [
        {
          name: 'team',
          team: asTeamSummary({
            id: route.teamId,
            name: '',
            shortName: null,
            logoPath: null
          }),
          tab: route.tab
        }
      ]
    }
  if (route.name === 'gameSettings')
    return { [tab]: [gameUnder(route.gameId), route] }
  if (route.name === 'groupSettings' && route.kind === 'team') {
    const target = route.teamReturn
    const underlying =
      target == null
        ? [{ name: 'group' as const, kind: 'team' as const, id: route.id }]
        : target.address === 'team'
          ? stackFor({ name: 'team', teamId: target.id, tab: target.tab })[tab]!
          : [
              {
                name: 'group' as const,
                kind: 'team' as const,
                id: target.id,
                tab: target.tab
              }
            ]
    return {
      [tab]: [...underlying, route]
    }
  }
  if (isCreationRoute(route)) return { [tab]: [route] }
  if (route.name === 'scoreGame') return { [tab]: [route] }
  if (route.name === 'djGame') return { [tab]: [route] }
  // The dashboard sits on the game's Score Game section, so Back returns to
  // the hero and the three pills with Score Game still selected.
  if (route.name === 'scoreboardOverride') {
    return {
      [tab]: [gameUnder(route.gameId, 'score'), route]
    }
  }
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
          at: route.at,
          angles: route.angles,
          audio: route.audio,
          zoom: route.zoom
        }
      ]
    }
  }
  if (route.name === 'account') return { [tab]: [{ name: 'account' }] }
  if (route.name === 'chatDevices') return { [tab]: [{ name: 'chatDevices' }] }
  if (route.name === 'chatLink') return { [tab]: [{ name: 'chatLink' }] }

  if (route.name === 'chatReports') return { [tab]: [{ name: 'chatReports' }] }
  if (route.name === 'chatNew') return { [tab]: [{ name: 'chatNew' }] }
  if (route.name === 'conversation' || route.name === 'chatMembers') {
    const conversation: Pushed = {
      name: 'conversation',
      conversationId: route.conversationId,
      title: ''
    }
    return {
      [tab]:
        route.name === 'conversation'
          ? [conversation]
          : [
              conversation,
              { name: 'chatMembers', conversationId: route.conversationId }
            ]
    }
  }
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
          year: route.year,
          videoSeasonId: route.videoSeasonId,
          videoTeamId: route.videoTeamId,
          videoYear: route.videoYear,
          onTeam: route.onTeam
        }
      ]
    }
  }
  if (route.name === 'person') return { [tab]: [{ ...route }] }
  // A league's own address opens its page, the one Home and its group
  // address open.
  if (route.name === 'league')
    return { [tab]: [{ name: 'group', kind: 'league', id: route.leagueId }] }
  return {}
}

/** A game's page, beneath a screen opened from it. */
function gameUnder(
  gameId: string,
  section?: 'boxScore' | 'watch' | 'score'
): Pushed {
  return { name: 'game', gameId, title: '', tab: section }
}

/** Which tab an address belongs to. */
function tabOf(route: Route): NavTabId {
  if (route.name === 'videos') return 'videos'
  if (route.name === 'schedule') return 'schedule'
  // Following from Home's Add stays on Home's stack; plain discovery is the
  // Search tab itself.
  if (route.name === 'discover' && route.follow !== true) return 'search'

  if (
    route.name === 'chat' ||
    route.name === 'chatNew' ||
    route.name === 'conversation' ||
    route.name === 'chatMembers'
  ) {
    return 'chat'
  }
  return 'home'
}

/** The address of wherever the app currently is. */
function routeOf(
  tab: NavTabId,
  top: Pushed | undefined,
  filters: TabFilters
): Route {
  if (top != null) {
    if (isCreationRoute(top)) return top
    if (top.name === 'djGame') return { name: 'djGame', gameId: top.gameId }
    if (top.name === 'scoreGame' || top.name === 'scoreboardOverride') {
      return top
    }
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
    if (top.name === 'chatDevices') return { name: 'chatDevices' }
    if (top.name === 'chatLink') return { name: 'chatLink' }

    if (top.name === 'chatReports') return { name: 'chatReports' }
    if (top.name === 'chatNew') return { name: 'chatNew' }
    if (top.name === 'conversation') {
      return { name: 'conversation', conversationId: top.conversationId }
    }
    if (top.name === 'chatMembers') {
      return { name: 'chatMembers', conversationId: top.conversationId }
    }
    if (top.name === 'player') {
      return {
        name: 'player',
        userId: top.userId,
        tab: top.tab,
        seasonId: top.seasonId,
        teamId: top.teamId,
        year: top.year,
        videoSeasonId: top.videoSeasonId,
        videoTeamId: top.videoTeamId,
        videoYear: top.videoYear,
        onTeam: top.onTeam
      }
    }
    if (top.name === 'person') {
      return {
        name: 'person',
        kind: top.kind,
        id: top.id,
        userId: top.userId
      }
    }
    // The picker has no address of its own: it is a step on the player's
    // Walk-up tab, which a link opens instead.
    if (top.name === 'walkUpSong') {
      return {
        name: 'player',
        userId: top.userId,
        tab: 'walkup',
        onTeam: top.teamId
      }
    }
    return {
      name: 'game',
      gameId: top.gameId,
      tab: top.tab,
      videoId: top.videoId,
      at: top.at,
      angles: top.angles,
      audio: top.audio,
      zoom: top.zoom
    }
  }
  if (tab === 'videos') return { name: 'videos', when: filters.videos }
  if (tab === 'schedule') return { name: 'schedule', when: filters.schedule }
  if (tab === 'search') return { name: 'discover' }

  if (tab === 'chat') return { name: 'chat' }
  return { name: 'home' }
}

/**
 * What the header says, where it says anything at all.
 *
 * A team, a game and the two lists say nothing: the team's name is on the card
 * below, the game's score is on its hero card, and the lists carry their filter
 * pills, which name the list better than the word `Videos` does. Each of those
 * hands its own content up as it scrolls away. A settings page does the same
 * with its own title, `League Settings` and the like.
 */
function titleFor(tab: NavTabId, top: Pushed | undefined): string | undefined {
  if (top != null) {
    if (isCreationRoute(top))
      return top.name === 'notifications' || top.name === 'notification'
        ? 'Notifications'
        : undefined
    if (top.name === 'season') return undefined
    if (top.name === 'account') return 'Account'
    if (top.name === 'chatDevices') return lstrings.chat_devices_title
    if (top.name === 'chatLink') return lstrings.chat_link_title

    if (top.name === 'chatReports') return lstrings.chat_reports_title
    if (top.name === 'chatNew') return lstrings.chat_new_title
    if (top.name === 'conversation') {
      return top.title === '' ? lstrings.chat_title : top.title
    }
    if (top.name === 'chatMembers') return lstrings.chat_members
    if (top.name === 'djGame') return lstrings.dj_game
    if (top.name === 'walkUpSong') {
      return sprintf(lstrings.walkup_title, top.playerName)
    }
    if (top.name === 'scoreboardOverride') {
      return lstrings.game_override_scoreboard
    }
    if (top.name === 'person') return top.title
    return undefined
  }
  if (tab === 'home') return 'Your Home'
  if (tab === 'chat') return lstrings.chat_title
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
