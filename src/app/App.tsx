import React, {
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState
} from 'react'
import {
  ActivityIndicator,
  AppState,
  Image,
  Keyboard,
  Platform,
  Text,
  useWindowDimensions,
  View,
  type ViewProps
} from 'react-native'
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
import { GameSocket, type ScreenScope } from '../common/gameSocket'
import type { GroupRef } from '../common/groupCreation'
import { managesRoster } from '../common/roles'
import type { UmpireLeague } from '../common/umpireSchedule'
import type { WalkUpSong } from '../common/walkUpSong'
import { tsLogoSource } from './assets'
import { ChatCoreGate } from './chat/ChatCoreGate'
import { chatCoreLog, chatStartLog } from './chat/chatCoreLog'
import { ChatDevicesScreen } from './chat/ChatDevicesScreen'
import { ChatGate } from './chat/ChatGate'
import { withChatKeyboard } from './chat/ChatHistoryList'
import { ChatInfoScreen } from './chat/ChatInfoScreen'
import type { ChatLink } from './chat/ChatLinks'
import { hasUnread } from './chat/chatModel'
import { ChatOverlayHost } from './chat/ChatOverlayHost'
import { ChatWorkspace } from './chat/ChatWorkspace'
import {
  CHAT_WIDE_WIDTH,
  ChatListNavigationCapture,
  newChatWorkspaceState
} from './chat/chatWorkspaceModel'
import {
  DeviceApprovalContext,
  DeviceApprovalPrompt
} from './chat/DeviceApprovalPrompt'
import { DeviceApprovals } from './chat/deviceApprovals'
import { ChatEngine, type ConversationListItem } from './chat/engine/engine'
import { leaveChat } from './chat/engine/links'
import { entityChats, entityPreviewLoader } from './chat/entityChats'
import { keyStore } from './chat/keyStore'
import { LinkDeviceScreen } from './chat/LinkDeviceScreen'
import { NewDmScreen } from './chat/NewDmScreen'
import { thisDevice } from './chat/thisDevice'
import {
  AppHeader,
  AppNav,
  type NavTabId,
  type PaneFrame,
  PaneFrameProvider,
  useBreakpoint,
  useHandoffSlot
} from './components'
import { FLOATING_HEIGHT_REM } from './components/AppNav'
import { ChoiceSheet } from './components/ChoiceSheet'
import { errorScreen } from './components/ErrorFallback'
import { OfflineBanner } from './components/OfflineBanner'
import { type SuccessNotice, SuccessToast } from './components/SuccessToast'
import { ChatBench } from './dev/chatBench'
import { StandaloneField } from './field/StandaloneField'
import { useForegroundRefresh } from './hooks/useForegroundRefresh'
import { ScreenScopeProvider } from './hooks/useScreenScope'
import { lstrings, sprintf } from './locales/strings'
import { routeOfUrl } from './navigation/deepLink'
import {
  anglesOpenPage,
  type PlayerFrom,
  withAngles
} from './navigation/gameAngles'
import { takeHistoryMove } from './navigation/historyMotion'
import {
  type CreationRoute,
  isCreationRoute,
  parseRoute,
  type Route,
  routePath,
  safeNext,
  type When
} from './navigation/routes'
import {
  isScoringPlayerChild,
  isScoringPlayerReturn,
  type ScoringPlayerOrigin
} from './navigation/scoringPlayerReturn'
import {
  CHAT_WORKSPACE_KEY,
  inChatWorkspace,
  presentationOf,
  screenIdentity
} from './navigation/screenIdentity'
import { seasonParticipantDestination } from './navigation/seasonParticipant'
import { type StackIntent, StackNavigator } from './navigation/StackNavigator'
import {
  frameKey,
  rootKey,
  type StackScene,
  systemBackPops
} from './navigation/stackScene'
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
  deliveringRoute,
  dropRouteSuffix,
  finishChatChild,
  popRoute,
  previousRoute,
  scoringOriginHistory,
  showRoute,
  stepBackTo,
  steppingBack,
  useBrowserBack
} from './navigation/useAddressBar'
import {
  analyticsPage,
  AnalyticsProvider,
  useAnalytics
} from './observability/AnalyticsContext'
import { passwordKdf } from './platform/passwordKdf'
import {
  sessionUserOf,
  type StoredUser,
  storedUserOf
} from './platform/storedUser'
import { GameReplayScreen } from './replay/GameReplayScreen'
import { ScoreboardOverrideScreen } from './scoreboard/ScoreboardOverrideScreen'
import { ScoreGameScreen } from './scoreboard/ScoreGameScreen'
import { ScoringScreen } from './scoring/ScoringScreen'
import { ServerScoringSource } from './scoring/scoringSource'
import { AccountScreen } from './screens/AccountScreen'
import { AddPlayerScene } from './screens/AddPlayerScene'
import { AutoSchedulerScreen } from './screens/AutoSchedulerScreen'
import { ChatReportsScreen } from './screens/ChatReportsScreen'
import { CoachGameScreen } from './screens/CoachGameScreen'
import { CreateGroupScreen } from './screens/CreateGroupScreen'
import { CreatePlayerScreen } from './screens/CreatePlayerScreen'
import { DiscoverScreen } from './screens/DiscoverScreen'
import { EventSettingsScreen } from './screens/EventSettingsScreen'
import { FieldManagerScreen } from './screens/FieldManagerScreen'
import { FieldScreen } from './screens/FieldScreen'
import {
  GameFormScreen,
  type GameSettingsResult
} from './screens/GameFormScreen'
import { type GamePlaybackReturn, GameScreen } from './screens/GameScreen'
import { GamesFeedScreen } from './screens/GamesFeedScreen'
import { GroupLinkScreen } from './screens/GroupLinkScreen'
import { GroupLocationPage } from './screens/GroupLocationPage'
import { GroupPeoplePage } from './screens/GroupPeoplePage'
import { GroupScreen } from './screens/GroupScreen'
import { GroupSettingsScreen } from './screens/GroupSettingsScreen'
import { HomeScreen } from './screens/HomeScreen'
import { JoinScreen } from './screens/JoinScreen'
import { LoginScreen } from './screens/LoginScreen'
import { NewApiKeyScreen } from './screens/NewApiKeyScreen'
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
import { SchedulePreviewScreen } from './screens/SchedulePreviewScreen'
import { ScheduleSeasonScreen } from './screens/ScheduleSeasonScreen'
import { SeasonScreen } from './screens/SeasonScreen'
import { SeasonTimeFrameScreen } from './screens/SeasonTimeFrameScreen'
import { SignInLinkScreen } from './screens/SignInLinkScreen'
import { TeamPage } from './screens/TeamPage'
import { VenueScreen } from './screens/VenueScreen'
import { startSentry, useSentryUser } from './sentry'
import { ErrorBoundary } from './sentrySdk'
import { useResumePendingUploads } from './stream/useResumePendingUploads'
import {
  CachingClient,
  OFFLINE_CREATE_MESSAGE,
  type OpenDocumentCache
} from './sync/cachingClient'
import type { HeldChain } from './sync/outbox'
import { watchReachability } from './sync/reachability'
import {
  heldTeamText,
  offlineBannerText,
  unsentLossText,
  useOutboxSummary,
  usePhoneOffline
} from './sync/useOffline'
import { TessDivider } from './tess/TessDivider'
import { usePaneAtLeast, useTessWide, useTessWidth } from './tess/tessLayout'
import { TessOverlayHost, TessOverlayProvider } from './tess/TessOverlay'
import { TessPanel } from './tess/TessPanel'
import type { TessScreen } from './tess/tessTypes'
import { useTessAvailable } from './tess/useTessAvailable'
import { useTessBack } from './tess/useTessBack'
import {
  cacheStyles,
  type Theme,
  ThemeProvider,
  useTheme
} from './theme/ThemeContext'
import { LeagueUmpiresScreen } from './umpires/LeagueUmpiresScreen'
import { UmpireLevelsScreen } from './umpires/UmpireLevelsScreen'
import { UmpireRequirementsScreen } from './umpires/UmpireRequirementsScreen'
import { UmpireScheduleScreen } from './umpires/UmpireScheduleScreen'
import { useUmpireLeaveGuard } from './umpires/useUmpireLeaveGuard'
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
  /**
   * Who the token was kept for, as the last good `whoAmI` said: on a phone
   * with no signal at launch, the session opens on this person and their
   * cached documents.
   */
  initialUser?: StoredUser
  /** Called with who is signed in, or none, so a phone keeps it. */
  onUser?: (user: StoredUser | undefined) => void
  /**
   * Opens a person's document cache. Given (on the phone), the client keeps
   * the documents it can show offline; the web keeps none and is not given
   * one.
   */
  documentCache?: OpenDocumentCache
}

type ScoringSettingsRefresh = () => void

/** A screen pushed on top of a tab, rather than one of the tabs itself. */
export type Pushed =
  | CreationRoute
  | { name: 'scoreGame'; gameId: string }
  | { name: 'scoreOptions'; gameId: string }
  /** Coach Game: a head coach's own team in a game, full screen. */
  | { name: 'coachGame'; gameId: string; teamId: string }
  | { name: 'gameReplay'; gameId: string }
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
      tab?: 'info' | 'boxScore' | 'watch' | 'score'
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
      /**
       * The videos page's picture the full-screen player was opened from,
       * and where it was, so the player opens on the same moment. Kept here
       * and never written to the address: a reload opens at the address's
       * `t` instead.
       */
      from?: PlayerFrom
      /**
       * A highlight chosen on another page, ending here in `videoId`'s
       * seconds: in the app, opened in the full-screen player at once and
       * stopped here; in a browser, played in the picture. Never written to the
       * address, and taken off once it is done with.
       */
      highlightUntil?: number
    }
  | { name: 'account' }
  /** Create API key, above Account. */
  | { name: 'apiKeyNew' }
  /** Chat devices, from the account screen or `/chat/devices`. */
  | { name: 'chatDevices' }
  /** Linking this device for chat, or resetting the user's chat keys. */
  | { name: 'chatLink' }
  /** Starting a direct message. */
  | { name: 'chatNew' }
  /** One chat, and what it is called once known. */
  | {
      name: 'conversation'
      conversationId: string
      title: string
      originHistory?: number
    }
  /** Information and member security, including compatible member links. */
  | { name: 'chatMembers'; conversationId: string }
  | { name: 'chatInfo'; conversationId: string }
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

/**
 * A screen that fills the window and draws no header or navbar: it has its own
 * way out, and no chevron or drag back.
 */
function isImmersive(frame: Pushed | undefined): boolean {
  return (
    frame?.name === 'scoreGame' ||
    frame?.name === 'coachGame' ||
    frame?.name === 'gameReplay'
  )
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
        <AnalyticsProvider
          endpoint={(props.apiBaseUrl ?? '/api/v1') + '/analytics/events'}
          enabled={props.fieldPreview !== true}
        >
          <Shell {...props} />
        </AnalyticsProvider>
      </ErrorBoundary>
    </ThemeProvider>
  )
}

function Shell(props: AppProps): React.ReactElement {
  const analytics = useAnalytics()
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
  const [navigationHeight, setNavigationHeight] = useState(
    theme.rem(FLOATING_HEIGHT_REM)
  )
  // What the screen on top has handed up: a team's name, a row of filter
  // pills, a game's score. The header draws it and never anything else.
  const { handoff, setHandoff, handoffHeight, setHandoffHeight } =
    useHandoffSlot()
  const [backOverride, setBackOverride] = useState<(() => void) | null>(null)
  const setBack = useCallback((handler: (() => void) | null) => {
    setBackOverride(() => handler)
  }, [])

  const { initialToken, onToken, onUser, documentCache } = props
  // One client for as long as the app runs, kept across sign-out and the next
  // sign-in. On the phone it keeps documents, in a file opened only once a
  // user id is known.
  const client = useMemo(
    () =>
      documentCache == null
        ? new TeamStationClient({
            baseUrl: apiBaseUrl,
            token: initialToken,
            passwordKdf
          })
        : new CachingClient({
            baseUrl: apiBaseUrl,
            token: initialToken,
            passwordKdf,
            openCache: documentCache
          }),
    [apiBaseUrl, initialToken, documentCache]
  )
  const caching = client instanceof CachingClient ? client : undefined
  useEffect(() => {
    client.analyticsApp = analytics?.app
    client.captureAnalytics =
      analytics == null ? undefined : () => analytics.capture()
    return () => {
      client.captureAnalytics = undefined
    }
  }, [analytics, client])
  // Read by the session effect, which runs once per client: a new function
  // from the platform's shell is not a reason to ask who is signed in again.
  const initialUser = useRef(props.initialUser)
  /** The phone opened on its stored user, and the server has not yet agreed. */
  const sessionUnconfirmed = useRef(false)
  const userSaved = useRef(onUser)
  userSaved.current = onUser
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
  const reportChatStart = useMemo(
    () => chatStartLog(apiBaseUrl, Platform.OS),
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
      analytics?.identify(
        next?.user.id,
        next == null ? undefined : client.token
      )
      setSession(next)
      refreshRoles()
      const token = next == null ? undefined : client.token
      onToken?.(token == null || token === '' ? undefined : token)
      // Sign-out deletes that person's documents; a sign-in opens theirs.
      if (next == null) {
        userSaved.current?.(undefined)
        caching?.signedOut().catch(() => undefined)
      } else {
        userSaved.current?.(storedUserOf(next.user))
        caching?.openFor(next.user.id)
      }
    },
    [client, caching, onToken, refreshRoles, analytics]
  )
  const [session, setSession] = useState<Session | undefined>(undefined)
  const [hasPending, setHasPending] = useState(false)
  const notificationUser = session?.user.id
  const notificationOwner = useRef(notificationUser)
  notificationOwner.current = notificationUser
  const notificationRead = useRef(0)
  const refreshNotifications = useCallback(async (): Promise<void> => {
    const version = ++notificationRead.current
    if (notificationUser == null) {
      setHasPending(false)
      return
    }
    try {
      const pending = await client.hasNotifications()
      if (
        notificationOwner.current === notificationUser &&
        version === notificationRead.current
      )
        setHasPending(pending)
    } catch {
      if (
        notificationOwner.current === notificationUser &&
        version === notificationRead.current
      )
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
  useEffect(() => {
    analytics?.identify(
      session?.user.id,
      session == null ? undefined : client.token
    )
    analytics?.navigate(analyticsPage(route.name))
  }, [analytics, client, session, route.name])
  useEffect(
    () =>
      client.subscribeOffline(offline => {
        analytics?.emit('offline_changed', { on: offline }).catch(() => {})
      }),
    [analytics, client]
  )
  // The address the app was opened on decides what is on the stack, so a link
  // to a game opens that game rather than the screen behind it.
  const [stacks, setStacks] = useState<Record<NavTabId, Pushed[]>>(() => {
    const opened = stackFor(currentRoute())
    return {
      home: [],
      videos: [],
      schedule: [],
      search: [],
      chat: [],
      ...opened
    }
  })
  /** Forgets the session and starts every tab over, for sign-out and deletion alike. */
  const leaveSession = (): void => {
    rememberSession(undefined)
    setStacks({ home: [], videos: [], schedule: [], search: [], chat: [] })
    setTab('home')
  }
  /** Sign Out, pressed: the server's session and the phone's file go. */
  const signOutNow = (): void => {
    leaveChat({ client, store: keyStore })
      .finally(() => {
        client.signOut().catch(() => undefined)
        leaveSession()
      })
      .catch(() => undefined)
  }
  const [confirmingSignOut, setConfirmingSignOut] = useState(false)
  const settingsVisitId = useRef(0)
  const [settingsVisit, setSettingsVisit] = useState(0)
  /**
   * The scene a settings form was last asked to give fresh (a save, people
   * added): it reloads as it lands, however it gets there. Other visits —
   * every address move makes one — leave a screen kept beneath as it was.
   */
  const freshScene = useRef<string | undefined>(undefined)
  const freshSettings = (sceneKey?: string): void => {
    freshScene.current = sceneKey
    setSettingsVisit(++settingsVisitId.current)
  }
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
  const {
    register: registerUmpireLeave,
    check: checkUmpireLeave,
    pending: popPending,
    guard: guardUmpireLeave
  } = useUmpireLeaveGuard()
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
  const [umpireLeagues, setUmpireLeagues] = useState<UmpireLeague[]>([])
  useEffect(() => {
    let live = true
    setUmpireLeagues([])
    if (signedInAs != null)
      client
        .umpireLeagues()
        .then(leagues => {
          if (live) setUmpireLeagues(leagues)
        })
        .catch(() => undefined)
    return () => {
      live = false
    }
  }, [client, signedInAs, roleRevision])
  const isAdmin = session?.user.isAdmin === true
  useSentryUser(signedInAs)
  useResumePendingUploads(client, signedInAs)
  // The phone's banner: the last request could not leave the device, and
  // what its queue holds. The web's client is never offline here.
  const phoneOffline = usePhoneOffline(client)
  const outbox = useOutboxSummary(client, signedInAs)
  const bannerText =
    signedInAs == null ? undefined : offlineBannerText(phoneOffline, outbox)
  const [createRefused, setCreateRefused] = useState(false)
  // A team whose new players the server refused: no screen of its own says
  // so, and the banner offers what can be done.
  const [askingTeam, setAskingTeam] = useState<
    { id: string; state: HeldChain['state'] } | undefined
  >()
  const heldTeams = Object.entries(outbox?.teams ?? {}).map(([id, held]) => ({
    key: id,
    text: heldTeamText(held),
    onPress: () => {
      setAskingTeam({ id, state: held.state })
    }
  }))
  const [bannerHeight, setBannerHeight] = useState(0)
  useEffect(() => {
    if (!phoneOffline) setCreateRefused(false)
  }, [phoneOffline])

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
   * The session, refused by the server (a REST 401, the scoreboard socket's
   * 4401, `whoAmI` saying nobody): no token and nobody signed in, keeping
   * that person's file on the phone. What they queued sends once they sign
   * in again (`openFor`); another account opens a file of its own. Only
   * `rememberSession(undefined)` deletes a file: signing out, deleting the
   * account, switching accounts.
   */
  const sessionRefused = useCallback((): void => {
    sessionUnconfirmed.current = false
    // Closed, not deleted: nothing in it is sent until its person is back.
    caching?.sessionRefused().catch(() => undefined)
    client.token = undefined
    onToken?.(undefined)
    userSaved.current?.(undefined)
    setSession(undefined)
    refreshRoles()
  }, [client, caching, onToken, refreshRoles])
  const sessionRefusedOnPhone = useCallback((): void => {
    // Reads refused together end it once.
    if (client.token == null) return
    sessionRefused()
    setStacks({ home: [], videos: [], schedule: [], search: [], chat: [] })
    setTab('home')
  }, [client, sessionRefused])
  // A REST call refused for want of a session stops the screen's scope until
  // the token changes, and a new token (a sign-in) starts it again. On the
  // phone it also ends the session.
  useEffect(() => {
    if (gameSocket == null) return
    const refused = (): void => {
      gameSocket.authFailed()
      if (caching != null) sessionRefusedOnPhone()
    }
    client.onSessionRefused = refused
    return () => {
      if (client.onSessionRefused === refused)
        client.onSessionRefused = undefined
    }
  }, [client, caching, gameSocket, sessionRefusedOnPhone])
  /**
   * A session the phone opened on its stored user, because the server could
   * not say who it was (no signal, a restart), is asked about again once the
   * server answers: the first request that leaves the device, the app coming
   * to the front, and every half minute until it is settled.
   */
  useEffect(() => {
    if (caching == null || signedInAs == null) return
    let live = true
    let asking = false
    const confirm = (): void => {
      if (!sessionUnconfirmed.current || asking || caching.offline) return
      asking = true
      client
        .whoAmI()
        .then(user => {
          if (!live) return
          sessionUnconfirmed.current = false
          if (user == null) {
            sessionRefusedOnPhone()
            return
          }
          userSaved.current?.(storedUserOf(user))
          setSession(current =>
            current == null ? current : { ...current, user }
          )
        })
        .catch(() => undefined)
        .finally(() => {
          asking = false
        })
    }
    const stop = client.subscribeOffline(offline => {
      if (!offline) confirm()
    })
    const timer = setInterval(confirm, SESSION_CONFIRM_MS)
    const foreground = AppState.addEventListener('change', state => {
      if (state === 'active') confirm()
    })
    return () => {
      live = false
      stop()
      clearInterval(timer)
      foreground.remove()
    }
  }, [caching, client, signedInAs, sessionRefusedOnPhone])
  useEffect(() => {
    gameSocket?.setToken(client.token)
  }, [client, gameSocket, session])
  /**
   * What the phone needs offline, read after the first Home load of a
   * sign-in, each time the app comes back to the front, and when the server
   * answers again after no signal. Home reading again on a notice (every
   * play of a game somebody is scoring) does not read it all ahead again. It
   * never holds a screen up.
   */
  const prefetchDocuments = useCallback((): void => {
    if (signedInAs != null) caching?.prefetch().catch(() => undefined)
  }, [caching, signedInAs])
  const prefetchedFor = useRef<string | undefined>(undefined)
  const prefetchAfterHome = useCallback((): void => {
    if (signedInAs == null || prefetchedFor.current === signedInAs) return
    prefetchedFor.current = signedInAs
    prefetchDocuments()
  }, [signedInAs, prefetchDocuments])
  useEffect(() => {
    if (caching == null || signedInAs == null) return
    const subscription = AppState.addEventListener('change', state => {
      // The queue sends nothing from the background, and coming back to the
      // front sends it before the reads.
      caching.setActive(state === 'active')
      if (state === 'active' && !caching.offline) prefetchDocuments()
    })
    // The network back only wakes the queue; its next send finds out.
    const unwatch = watchReachability(() => {
      caching.wakeOutbox(true)
    })
    // A request that leaves the device again, after none could.
    const reconnected = caching.subscribeOffline(offline => {
      if (!offline) prefetchDocuments()
    })
    return () => {
      subscription.remove()
      unwatch()
      reconnected()
    }
  }, [caching, signedInAs, prefetchDocuments])
  /**
   * The chat engine, for as long as somebody is signed in. It hears the
   * socket's chat hints from the start, so they arrive on every screen; it
   * restores saved keys when a chat section requests readable previews.
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
  const chatWorkspaceState = useMemo(newChatWorkspaceState, [chatEngine])
  // Only in-app chat visits carry an owning tab; cold links keep their usual tab.
  const chatHistory = useMemo(
    () => new Map<number, { path: string; tab: NavTabId; frames: Pushed[] }>(),
    // A new engine marks a new signed-in chat session.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [chatEngine]
  )
  const discardChatHistoryFrom = useCallback(
    (position: number): void => {
      for (const index of chatHistory.keys())
        if (index >= position) chatHistory.delete(index)
    },
    [chatHistory]
  )
  const retainedChatOrigin = (
    frame: Extract<Pushed, { name: 'conversation' }>,
    frames: Pushed[]
  ): number | undefined => {
    const index = frame.originHistory
    const saved = index == null ? undefined : chatHistory.get(index)
    return index != null &&
      index < scoringOriginHistory() &&
      saved?.tab === tab &&
      saved.path === routePath(routeOf(tab, frames.at(-1), filters)) &&
      saved.frames.length === frames.length &&
      saved.frames.every((item, at) => item === frames[at])
      ? index
      : undefined
  }
  const approvalOwner = useRef(signedInAs)
  approvalOwner.current = signedInAs
  const deviceApprovals = useMemo(
    () =>
      signedInAs == null
        ? undefined
        : new DeviceApprovals(
            {
              client,
              store: keyStore,
              userId: signedInAs,
              device: thisDevice(),
              current: () => approvalOwner.current === signedInAs
            },
            gameSocket
          ),
    [client, signedInAs, gameSocket]
  )
  useEffect(() => {
    deviceApprovals?.start()
    return () => {
      deviceApprovals?.stop()
    }
  }, [deviceApprovals])
  const refreshApprovals = useCallback(async () => {
    await deviceApprovals?.refresh()
  }, [deviceApprovals])
  useForegroundRefresh(refreshApprovals)
  useEffect(() => {
    let revision = deviceApprovals?.snapshot().revision
    return deviceApprovals?.subscribe(() => {
      const next = deviceApprovals.snapshot().revision
      if (next !== revision) {
        revision = next
        refreshNotifications().catch(() => undefined)
      }
    })
  }, [deviceApprovals, refreshNotifications])
  const chatListNavigation = useMemo(
    () => new ChatListNavigationCapture(chatEngine),
    [chatEngine]
  )
  useEffect(() => {
    chatListNavigation.setContextActive(true)
    return () => {
      chatListNavigation.setContextActive(false)
    }
  }, [chatListNavigation])
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
  const chatsOf = (kind: GroupRef['kind'], id: string): ChatLink[] =>
    entityChats(chatList, { kind, id })
  const loadChatPreviews = useMemo(() => {
    const load = entityPreviewLoader(chatEngine, keyStore, signedInAs)
    return (ids: string[]): void => {
      load(ids).catch(() => undefined)
    }
  }, [chatEngine, signedInAs])
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
          sessionUnconfirmed.current = false
          caching?.openFor(user.id)
          userSaved.current?.(storedUserOf(user))
          setSession({ token: '', expiresAt: '', user })
          return
        }
        // A token that was kept and is no longer good. Sessions last thirty
        // days and nothing refreshes them, so this is the ordinary end of one
        // rather than a fault: throw it away, or every launch from here on
        // sends a dead token and is answered 401 by every screen. Who it was
        // for goes with it, but not their file: what they queued offline
        // sends once they sign in again (`openFor`). Only signing out
        // deletes it.
        if (client.token != null) {
          client.token = undefined
          onToken?.(undefined)
          userSaved.current?.(undefined)
        }
      })
      .catch(() => {
        // The server did not say: no signal, a restart, too many requests. A
        // kept token is as good as it was, so the phone opens on who it was
        // kept for, and their documents and queue, and asks again once the
        // server answers. With no token, as on the web, nobody is signed in.
        if (!live) return
        const kept = initialUser.current
        if (client.token == null || kept == null) return
        caching?.openFor(kept.id)
        sessionUnconfirmed.current = caching != null
        setSession({ token: '', expiresAt: '', user: sessionUserOf(kept) })
      })
      .finally(() => {
        if (live) setAskedAboutSession(true)
      })
    return () => {
      live = false
    }
  }, [client, caching, needsSession, onToken])

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
    // A remembered chat origin already contains the resolved season frame.
    if (chatHistory.get(scoringOriginHistory())?.path === routePath(route))
      return
    // A history move onto a season kept in the stack: nothing to resolve.
    if (stacks[tabOf(route)].some(heldSeason(route.seasonId))) return
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
  // One scorer per person and game, whether on top or kept beneath a child.
  const scoreKey = (gameId: string): string =>
    `score:${signedInAs ?? 'local'}:${gameId}`
  // DJ Game as an iPhone draws it, its own screen; elsewhere its address
  // shows the game.
  const djScreen = top?.name === 'djGame' && walkUpMusic.djSupported
  // The screens that take the whole window: the field preview, scoring,
  // coaching and replay, which hide the header too.
  const immersiveField = props.fieldPreview === true || isImmersive(top)
  /**
   * Tess, the assistant, for whoever is signed in where the server offers
   * her. Her button opens a chat that covers the app on a narrow window and
   * sits in a column beside it on a wide one.
   *
   * Not beside or over the screens that take the whole window — those above,
   * DJ Game on an iPhone and the scoreboard override — on either width:
   * they keep the window they read, and scoring keeps the browser's Back for
   * its own save-before-leaving. Whether the chat is open is kept, so it is
   * back when the person leaves.
   */
  const health = useCallback(async () => await client.health(), [client])
  const tessAvailable = useTessAvailable(health, signedInAs)
  const [tessOpen, setTessOpen] = useState(false)
  useEffect(() => {
    if (signedInAs == null) setTessOpen(false)
  }, [signedInAs])
  const tessSuppressed =
    immersiveField || djScreen || top?.name === 'scoreboardOverride'
  const tessWide = useTessWide()
  const onboarded =
    session?.user.onboarding == null ||
    session.user.onboarding.step === 'complete'
  const tessShown =
    tessAvailable &&
    tessOpen &&
    !tessSuppressed &&
    onboarded &&
    joining == null &&
    route.name !== 'oauthApprove' &&
    route.name !== 'oauthNative'
  const closeTess = useCallback(() => {
    setTessOpen(false)
  }, [])
  // Her chat over the whole of a narrow window: Back closes it, and the
  // navigator takes no back gesture beneath it.
  const tessLayer = tessShown && !tessWide
  useTessBack(tessLayer, closeTess)
  // What the pane shows, for Tess on a wide screen, read when a message is
  // sent: its address and title, and the steps of the tab that led there.
  // A team opened by its address has no name until its page loads one.
  const teamNames = useRef(new Map<string, string>())
  const paneScreen = useRef<() => TessScreen | undefined>(() => undefined)
  paneScreen.current = () => {
    if (!tessWide) return undefined
    const describe = (frame: Pushed | undefined): TessScreen['stack'][0] => ({
      path: routePath(routeOf(tab, frame, filters)),
      title: screenTitle(tab, frame, teamNames.current)
    })
    return {
      ...describe(top),
      stack: top == null ? [] : [undefined, ...stack.slice(0, -1)].map(describe)
    }
  }
  const tessScreen = useCallback(() => paneScreen.current(), [])
  const tessColumn = tessShown && tessWide
  // Room for the chat list and a chat side by side, as `ChatWorkspace` lays
  // itself out: the pane, less Tess's column when it is open beside it.
  const chatWide = usePaneAtLeast(CHAT_WIDE_WIDTH, tessColumn)

  // The scene a frame is drawn as: the same while that screen writes its own
  // frame (a pill, a filter), another for any other screen.
  const sceneKeyOf = (index: number): string => {
    const frame = stack[index] as Pushed | undefined
    if (inChatWorkspace(tab, frame, chatWide)) return CHAT_WORKSPACE_KEY
    return frame == null
      ? rootKey(tab)
      : frame.name === 'scoreGame'
        ? scoreKey(frame.gameId)
        : frameKey(tab, stack, index, screenIdentity)
  }
  const topKey = sceneKeyOf(stack.length - 1)
  const navigationRef = useRef({ tab, top, topKey })
  navigationRef.current = { tab, top, topKey }
  /** The last frame on top that draws the header (see `chromeFrame`). */
  const chromeTop = useRef<{ frame: Pushed | undefined } | undefined>(undefined)
  /**
   * The settings visit each scene was drawn for. A settings screen is keyed
   * by it, so a new visit gives the screen on show a fresh form, as before.
   * A scene kept beneath keeps the visit it had: a Back that lands on it
   * (from Add People, say) moves the visit as it lands, and must reveal the
   * screen as it stood rather than a fresh load.
   */
  const sceneVisits = useRef(
    new Map<string, { drawn: number; landed: number }>()
  )
  const committedTopKey = useRef<string | undefined>(undefined)
  useLayoutEffect(() => {
    committedTopKey.current = topKey
  })
  const settingsVisitOf = (key: string): number => {
    const held = sceneVisits.current.get(key)
    if (held == null) {
      sceneVisits.current.set(key, {
        drawn: settingsVisit,
        landed: settingsVisit
      })
      return settingsVisit
    }
    if (key !== topKey) return held.drawn
    // Landing on top: the visit it lands with is not a new one for it,
    // unless it was asked for to make the form fresh (a save, people added).
    if (committedTopKey.current !== key) {
      if (key === freshScene.current) {
        freshScene.current = undefined
        held.drawn = settingsVisit
      }
      held.landed = settingsVisit
    }
    // Moved since, while it stayed on top: a fresh form.
    else if (settingsVisit !== held.landed) {
      held.drawn = settingsVisit
      held.landed = settingsVisit
    }
    return held.drawn
  }
  // Which way the next stack change goes, for the transition layer: set by
  // each navigation path just before it changes the stack, read by the
  // navigator in the render that shows the change, and cleared after that
  // commit so it never labels a later one.
  const navigationIntent = useRef<StackIntent | undefined>(undefined)
  const intend = useCallback(
    (direction: StackIntent['direction'], drawn = false): void => {
      navigationIntent.current = { direction, drawn }
      // The screen left stays mounted, so its field would keep the keyboard.
      if (direction !== 'none') Keyboard.dismiss()
    },
    []
  )
  useLayoutEffect(() => {
    navigationIntent.current = undefined
  })
  // A drag back pops exactly what the header's chevron would: a pushed
  // screen that draws the header, with no screen holding the chevron for
  // itself.
  const immersiveTop = isImmersive(top)
  const swipeBack =
    props.fieldPreview !== true &&
    stack.length > 0 &&
    !immersiveTop &&
    presentationOf(top) === 'push' &&
    backOverride == null &&
    // One screen over itself (the chat workspace): nothing else to reveal.
    sceneKeyOf(stack.length - 2) !== topKey
  // Why a create did not open is said on the screen it was pressed on.
  useEffect(() => {
    setCreateRefused(false)
  }, [tab, top])

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
      top?.name !== 'team' &&
      top?.name !== 'game'
    )
      return
    // Nor while an invitation is open, for the same reason.
    if (joining != null) return
    if (route.name === 'oauthApprove' || route.name === 'oauthNative') return
    // Nor between a team or season link arriving and its screen being pushed.
    if (resolvingLink.current) return
    // Nor while a step back is landing: it writes the address it lands on.
    if (steppingBack()) {
      inPlace.current = false
      return
    }
    const address = routeOf(tab, top, filters)
    const before = scoringOriginHistory()
    showRoute(address, firstRender.current || inPlace.current)
    const position = scoringOriginHistory()
    // A new branch of browser history invalidates the old Forward visits.
    if (position > before) discardChatHistoryFrom(position)
    if (tab !== 'chat' && stack.some(frame => frame.name === 'conversation'))
      chatHistory.set(scoringOriginHistory(), {
        path: routePath(address),
        tab,
        frames: stack
      })
    firstRender.current = false
    inPlace.current = false
  }, [
    joining,
    session,
    tab,
    top,
    filters,
    route.name,
    stack,
    chatHistory,
    discardChatHistoryFrom
  ])

  // Whether Android's back gesture may drag the top off. That Back walks the
  // history, so it may only when the history's previous step is the frame
  // beneath — not after a pill change, which is a step of its own, nor after
  // a tab switch. After the address effect, so it reads this move's history.
  // The same, read again as a gesture comes: the state reaches the navigator
  // a render later, and the native callback a bridge hop after that.
  const backPopsNow = useRef<() => boolean>(() => false)
  backPopsNow.current = () => {
    const previous = previousRoute()
    return (
      swipeBack &&
      systemBackPops(
        previous == null ? undefined : routePath(previous),
        routePath(routeOf(tab, stack.at(-2), filters))
      )
    )
  }
  const predictiveBackNow = useCallback(() => backPopsNow.current(), [])
  const [predictiveBack, setPredictiveBack] = useState(false)
  useEffect(() => {
    setPredictiveBack(backPopsNow.current())
    // Whatever the address effect writes the history on, so this reads the
    // history it has just written.
  }, [joining, session, tab, top, stack, filters, route.name, swipeBack])

  const goToRoute = useCallback(
    (route: Route, onHandled?: (accepted: boolean) => void): void => {
      // A sign-in, a notification or a link does not move; a history step or
      // the scorer's exit has already said which way it goes.
      if (navigationIntent.current == null) intend('none')
      const said = navigationIntent.current
      // Refused: the direction said for this move is not the next one's.
      const refused = (): void => {
        navigationIntent.current = undefined
        onHandled?.(false)
      }
      if (
        guardUmpireLeave(() => {
          navigationIntent.current = said
          goToRoute(route, onHandled)
        }, refused)
      )
        return
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
          refused()
          return
        }
        check()
          .then(accepted => {
            if (!accepted || scoringVisit.current !== visit) {
              refused()
              return
            }
            clearScoringVisit(visit)
            navigationIntent.current = said
            goToRoute(route)
            onHandled?.(true)
          })
          .catch(refused)
        return
      }
      setSettingsVisit(++settingsVisitId.current)
      setRoute(route)
      setJoining(route.name === 'join' ? route.code : undefined)
      const previous = navigationRef.current
      const returningFromScoreOptions =
        previous.top?.name === 'scoreOptions' &&
        route.name === 'game' &&
        route.tab !== 'score' &&
        route.gameId === previous.top.gameId
      const returningToScoreOptions =
        (previous.top?.name === 'scoreboardOverride' ||
          previous.top?.name === 'scoreGame') &&
        route.name === 'scoreOptions' &&
        route.gameId === previous.top.gameId
      const returnFrame = returningFromScoreOptions
        ? 'game'
        : returningToScoreOptions
          ? 'scoreOptions'
          : undefined
      const remembered = chatHistory.get(scoringOriginHistory())
      const chatReturn =
        remembered?.path === routePath(route) ? remembered : undefined
      const next =
        chatReturn?.tab ??
        (returnFrame != null ? previous.tab : (visit?.tab ?? tabOf(route)))
      if (chatReturn != null) inPlace.current = true
      if (returnFrame != null) inPlace.current = true
      setTab(next)
      setStacks(current => {
        if (chatReturn != null) return { ...current, [next]: chatReturn.frames }
        if (returnFrame != null && 'gameId' in route) {
          const held = current[next]
          const at = held.findLastIndex(
            item => item.name === returnFrame && item.gameId === route.gameId
          )
          if (at >= 0) return { ...current, [next]: held.slice(0, at + 1) }
        }
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
        // A history move onto a season already here keeps it, with the pill
        // the address names: `stackFor` has no answer for a season.
        if (route.name === 'season') {
          const at = held.findLastIndex(heldSeason(route.seasonId))
          const frame = held[at] as
            Extract<Pushed, { name: 'season' }> | undefined
          if (frame != null) {
            const { tab: pill, when } = route
            return {
              ...current,
              [next]: [...held.slice(0, at), { ...frame, tab: pill, when }]
            }
          }
        }
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
    [clearScoringVisit, guardUmpireLeave, chatHistory, intend]
  )
  // Back, Forward, or a link: the address bar noted which way it went, read
  // as it moves; the move itself may wait for an open chat to keep its place.
  const goFromAddress = useCallback(
    (route: Route, onHandled?: (accepted: boolean) => void): void => {
      const move = takeHistoryMove()
      chatListNavigation
        .navigate(() => {
          intend(move?.direction ?? 'none', move?.drawn === true)
          goToRoute(route, onHandled)
        })
        .catch((error: unknown) => {
          reportNavigationError(error)
          onHandled?.(false)
        })
    },
    [chatListNavigation, goToRoute, intend]
  )
  useBrowserBack(
    goFromAddress,
    top?.name === 'umpireSchedule' ? checkUmpireLeave : undefined,
    discardChatHistoryFrom
  )

  const captureChatLeave = useCallback(
    (change: () => void, once?: string): void => {
      if (!chatListNavigation.hasReader()) {
        change()
        return
      }
      ;(once == null
        ? chatListNavigation.navigate(change)
        : chatListNavigation.navigateOnce(once, change)
      ).catch(reportNavigationError)
    },
    [chatListNavigation]
  )
  /**
   * A link in Tess's chat. On a wide screen the pane beside it goes there and
   * the chat stays; on a narrow one the chat closes to show it. Like every
   * other way out of an open chat, it waits for the chat's reading position
   * to be kept first.
   */
  const openTessLink = (path: string): void => {
    captureChatLeave(() => {
      if (!tessWide) setTessOpen(false)
      goToRoute(routeOfUrl(path))
    })
  }

  /** The tab, or — pressed on the tab already showing — that tab's root. */
  const selectTab = (next: NavTabId): void => {
    if (
      guardUmpireLeave(() => {
        selectTab(next)
      })
    )
      return
    if (scoringVisit.current != null) {
      afterScoringLeave(() => {
        selectTab(next)
      })
      return
    }
    Keyboard.dismiss()
    captureChatLeave(() => {
      if (next === tab && stacks[tab].length > 0)
        dropRouteSuffix(
          stacks[tab],
          routePath(routeOf(tab, undefined, filters))
        )
      // Pressed again on the tab showing, it pops to the root; a switch does
      // not move.
      intend(next === tab && stacks[tab].length > 0 ? 'back' : 'none')
      setTab(next)
      setStacks(current => stacksAfterTabPress(current, tab, next))
      if (session == null || props.fieldPreview === true) {
        if (next === tab) return
        const destination = routeOf(next, undefined, filters)
        setRoute(destination)
        setJoining(undefined)
        showRoute(destination)
      }
    })
  }

  const push = (next: Pushed): void => {
    // A team, season, league or game is made on the server: with no signal
    // its form does not open, and the banner says why.
    if (caching?.offline === true && createsOnServer(next)) {
      setCreateRefused(true)
      return
    }
    if (
      guardUmpireLeave(() => {
        push(next)
      })
    )
      return
    if (scoringVisit.current != null) {
      afterScoringLeave(() => {
        push(next)
      })
      return
    }
    captureChatLeave(() => {
      intend('forward')
      setStacks(current => ({ ...current, [tab]: [...current[tab], next] }))
    }, 'push')
  }
  const openGroup = useCallback(
    (group: GroupRef): void => {
      captureChatLeave(() => {
        intend('forward')
        setStacks(current => ({
          ...current,
          [tab]: [...current[tab], { name: 'group', ...group }]
        }))
      }, 'push')
    },
    [tab, captureChatLeave, intend]
  )
  const replace = (next: Pushed): void => {
    captureChatLeave(() => {
      intend('none')
      setStacks(current => ({
        ...current,
        [tab]: [...current[tab].slice(0, -1), next]
      }))
    })
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
    if (guardUmpireLeave(pop)) return
    if (
      top?.name === 'player' &&
      isScoringPlayerChild({ ...top, name: 'player' }, scoringVisit.current)
    ) {
      intend('back')
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
    // One pop at a time while the list's position is kept: the chat root's
    // list, covered beneath a conversation, holds the reader.
    captureChatLeave(() => {
      const frames = stacks[tab].slice(0, -1)
      if (
        tab !== 'chat' &&
        stacks[tab].some(frame => frame.name === 'conversation')
      ) {
        const address = routeOf(tab, frames.at(-1), filters)
        const current = stacks[tab].at(-1)
        const origin =
          current?.name === 'conversation'
            ? retainedChatOrigin(current, frames)
            : undefined
        const position = origin ?? scoringOriginHistory() - 1
        // A retained tab can be revisited after its original browser entry
        // was removed. Own the replacement entry as well as the UI stack.
        chatHistory.set(position, { path: routePath(address), tab, frames })
        stepBackTo(address, position)
      } else popRoute()
      intend('back')
      setStacks(current => ({ ...current, [tab]: current[tab].slice(0, -1) }))
    }, 'pop')
  }
  /**
   * A drag back's pop, the edge pan's or Android's gesture. Android's Back
   * reaches the shell through the gesture without `BackHandler`, so it is
   * swallowed here as `BackHandler` swallows it while a Back or a link is
   * still being handed to the shell: a pop in the middle of that would leave
   * the address a step off the screen. The drag springs back.
   */
  const popFromDrag = (): void => {
    if (deliveringRoute()) return
    pop()
  }

  const openGame = (
    gameId: string,
    title: string,
    options: {
      tab?: 'info' | 'watch' | 'boxScore'
      autoPlay?: boolean
      pendingRequestId?: string | null
    } = {}
  ): void => {
    const { pendingRequestId, ...presentation } = options
    if (presentation.autoPlay === true && presentation.tab == null)
      presentation.tab = 'watch'
    if (pendingRequestId != null) {
      push({ name: 'notification', id: pendingRequestId })
    } else push({ name: 'game', gameId, title, ...presentation })
  }
  /** A section change on the team or season screen, into the address. */
  const setTopTab = (next: string, correcting = false): void => {
    if (correcting) inPlace.current = true
    const frame = stacks[tab].at(-1)
    if (frame?.name === 'player' && frame.tab !== next) {
      if (next === 'settings') freshSettings()
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
      userId: string,
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
      intend('forward')
      setStacks(current => ({ ...current, [tab]: [...current[tab], next] }))
    },
    [tab, intend]
  )
  /** Somebody on a people list, as the level it was opened from sees them. */
  const openPerson = (
    group: { kind: 'league' | 'season' | 'team'; id: string },
    userId: string,
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
    const next: Pushed = {
      name: 'conversation',
      conversationId: chat.id,
      title: chat.title,
      originHistory:
        top?.name === 'conversation'
          ? top.originHistory
          : tab === 'chat'
            ? undefined
            : scoringOriginHistory()
    }
    if (top?.name === 'conversation') {
      inPlace.current = true
      replace(next)
    } else {
      if (tab !== 'chat')
        chatHistory.set(scoringOriginHistory(), {
          path: routePath(routeOf(tab, top, filters)),
          tab,
          frames: stacks[tab]
        })
      push(next)
    }
  }
  const openPersonChat = async (chat: {
    id: string
    title: string
  }): Promise<void> => {
    const owner = navigationRef.current
    await chatEngine
      ?.refresh()
      .catch(() => undefined)
      .then(() => {
        if (
          navigationRef.current.tab === owner.tab &&
          navigationRef.current.top === owner.top
        )
          openChat(chat)
      })
  }
  /**
   * What every chat screen stands behind: chat's crypto core on this
   * platform, then this device set up for chat.
   */
  const gated = (screen: React.ReactNode): React.ReactNode =>
    chatEngine == null || session == null ? null : (
      <ChatCoreGate onUnavailable={reportChatCore}>
        <ChatGate
          engine={chatEngine}
          client={client}
          userId={session.user.id}
          onFailure={reportChatStart}
        >
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
    const returnPath = safeNext(
      route.name === 'signIn' ? (route.next ?? next.next) : next.next
    )
    if (returnPath != null) {
      const [path, search = ''] = returnPath.split('?')
      const destination = parseRoute(path, search)
      goToRoute(destination)
      if (
        destination.name === 'oauthApprove' ||
        destination.name === 'oauthNative'
      )
        showRoute(destination, true)
    }
  }

  const signInHere = (): void => {
    const destination: Route = {
      name: 'signIn',
      next: routePath(routeOf(tab, top, filters))
    }
    goToRoute(destination)
    showRoute(destination)
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
                  await leaveChat({ client, store: keyStore }).catch(
                    () => undefined
                  )
                  // Removing the chat device may already have revoked this
                  // session, so logout can legitimately answer unauthorized.
                  await client.signOut().catch(() => undefined)
                  client.token = undefined
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
    top?.name === 'team' ||
    top?.name === 'game'
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
            onSignedIn={signedIn}
            onSignInAgain={linkSpent => {
              const destination: Route = { name: 'signIn' }
              goToRoute(destination)
              showRoute(destination, linkSpent)
            }}
          />
        ) : (
          <LoginScreen
            next={route.name === 'signIn' ? route.next : undefined}
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
        socket={gameSocket}
        onEditPlayer={(userId, title, teamId) => {
          refreshRoles()
          scoringApproved.current = false
          // Each Settings form gets a fresh player view, so an earlier
          // form cannot change its header after it has been replaced.
          freshSettings()
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
          intend('forward')
          setStacks(current => ({ ...current, [tab]: [...stack, child] }))
        }}
        onExit={() => {
          scoringVisit.current = undefined
          inPlace.current = true
          // The cover slides down onto the game, whichever tab it lands on.
          intend('back')
          setStacks(current => ({ ...current, [tab]: [] }))
          goToRoute({ name: 'game', gameId: scoringFrame.gameId })
        }}
      />
    )
  /**
   * The screen for one frame of the tab's stack; `undefined` is the tab's
   * root. Drawn for the top, and for the frame beneath while a drag back
   * reveals it.
   *
   * What a screen writes back — its section, its title, the moment its video
   * is at, a correction that makes the next address a replace — goes to the
   * top frame, so it is dropped unless this frame is still the top: a screen
   * sliding out, or one drawn beneath a drag, must not rewrite the screen
   * now on show.
   */
  const popFrame = pop
  const replaceFrame = replace
  const pushFrame = push
  const renderFrame = (
    top: Pushed | undefined,
    key: string
  ): React.ReactNode => {
    // Its scene, not its frame object: a pill or filter written in place
    // leaves the same screen on top.
    const live = (): boolean => navigationRef.current.topKey === key
    const sceneVisit = settingsVisitOf(key)
    const writeTop: typeof setStacks = update => {
      if (live()) setStacks(update)
    }
    const topTab = (next: string, correcting?: boolean): void => {
      if (live()) setTopTab(next, correcting)
    }
    const markInPlace = (value: boolean): void => {
      if (live()) inPlace.current = value
    }
    // A write-back that is not one of the above, dropped the same way.
    const onTop =
      <Args extends unknown[]>(act: (...args: Args) => void) =>
      (...args: Args): void => {
        if (live()) act(...args)
      }
    // So are a screen's own moves: a load that answers or a save that lands
    // after the screen started sliding out must not pop, replace or push the
    // screen now on show. A touch only ever reaches the top.
    const pop = onTop(popFrame)
    const replace = onTop(replaceFrame)
    const push = onTop(pushFrame)
    return top?.name === 'conversation' || (top == null && tab === 'chat') ? (
      gated(
        <ChatWorkspace
          engine={chatEngine!}
          userId={signedInAs!}
          state={chatWorkspaceState}
          listNavigation={chatListNavigation}
          conversationId={
            top?.name === 'conversation' ? top.conversationId : undefined
          }
          onOpen={openChat}
          onNewMessage={() => {
            push({ name: 'chatNew' })
          }}
          onMembers={conversationId => {
            push({ name: 'chatInfo', conversationId })
          }}
          onTitle={(conversationId, title) => {
            writeTop(current => {
              const held = current[tab]
              const last = held[held.length - 1]
              if (
                last?.name !== 'conversation' ||
                last.conversationId !== conversationId ||
                last.title === title
              )
                return current
              return {
                ...current,
                [tab]: [...held.slice(0, -1), { ...last, title }]
              }
            })
          }}
        />
      )
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
          onOpenGroup={openGroup}
          onOpenPlayer={openPlayer}
          onLoaded={prefetchAfterHome}
          onOpenUmpireSchedule={
            umpireLeagues.length === 0
              ? undefined
              : () => {
                  push({ name: 'umpireSchedule', id: umpireLeagues[0].id })
                }
          }
        />
      ) : tab === 'search' ? (
        <DiscoverScreen
          key="search"
          client={client}
          onOpen={openGroup}
          follow={session != null}
        />
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
    ) : top.name === 'groupAddPeople' || top.name === 'groupInvites' ? (
      <GroupPeoplePage
        key={`${top.name}:${top.kind}:${top.id}`}
        client={client}
        group={{ kind: top.kind, id: top.id }}
        invites={top.name === 'groupInvites'}
        onDone={notice => {
          if (notice != null)
            setSuccessNotice({ id: Date.now(), message: notice })
          refreshRoles()
          freshSettings(sceneKeyOf(stack.length - 2))
          pop()
        }}
      />
    ) : top.name === 'teamCreatePlayer' ? (
      <CreatePlayerScreen
        key={`teamCreatePlayer:${top.id}`}
        client={client}
        teamId={top.id}
        onCreated={(name, another) => {
          setSuccessNotice({ id: Date.now(), message: `Created ${name}` })
          freshSettings(sceneKeyOf(stack.length - 2))
          if (!another) pop()
        }}
      />
    ) : top.name === 'teamAddPlayer' ? (
      <AddPlayerScene
        key={`teamAddPlayer:${top.id}`}
        client={client}
        teamId={top.id}
        onAdded={message => {
          setSuccessNotice({ id: Date.now(), message })
          freshSettings(sceneKeyOf(stack.length - 2))
          pop()
        }}
        onCancel={pop}
      />
    ) : top.name === 'autoScheduler' ? (
      <AutoSchedulerScreen
        key={top.leagueId}
        client={client}
        leagueId={top.leagueId}
        onFieldManager={() => {
          push({ name: 'fieldManager', leagueId: top.leagueId })
        }}
        onOpenSeason={seasonId => {
          push({ name: 'scheduleSeason', leagueId: top.leagueId, seasonId })
        }}
        onOpenPreview={previewId => {
          push({ name: 'schedulePreview', leagueId: top.leagueId, previewId })
        }}
      />
    ) : top.name === 'schedulePreview' ? (
      <SchedulePreviewScreen
        key={top.previewId}
        client={client}
        leagueId={top.leagueId}
        previewId={top.previewId}
        onOpenPreview={previewId => {
          replace({
            name: 'schedulePreview',
            leagueId: top.leagueId,
            previewId
          })
        }}
      />
    ) : top.name === 'scheduleSeason' ? (
      <ScheduleSeasonScreen
        key={top.seasonId}
        client={client}
        leagueId={top.leagueId}
        seasonId={top.seasonId}
      />
    ) : top.name === 'fieldManager' ? (
      <FieldManagerScreen
        key={top.leagueId}
        client={client}
        onOpenVenue={venueId => {
          push({ name: 'venue', venueId })
        }}
        onOpenPlace={placeId => {
          push({ name: 'venuePlace', placeId })
        }}
      />
    ) : top.name === 'venue' || top.name === 'venuePlace' ? (
      <VenueScreen
        key={top.name === 'venue' ? top.venueId : top.placeId}
        client={client}
        venueId={top.name === 'venue' ? top.venueId : undefined}
        placeId={top.name === 'venuePlace' ? top.placeId : undefined}
        onOpenField={(venueId, fieldId) => {
          push({ name: 'venueField', venueId, fieldId })
        }}
        onClaimed={venueId => {
          replace({ name: 'venue', venueId })
        }}
      />
    ) : top.name === 'venueField' ? (
      <FieldScreen
        key={`${top.venueId}:${top.fieldId}`}
        client={client}
        venueId={top.venueId}
        fieldId={top.fieldId}
        onGone={pop}
      />
    ) : top.name === 'seasonTimeFrame' ? (
      <SeasonTimeFrameScreen
        key={top.id}
        client={client}
        id={top.id}
        onSaved={() => {
          freshSettings(sceneKeyOf(stack.length - 2))
          pop()
        }}
      />
    ) : top.name === 'groupLocation' ? (
      <GroupLocationPage
        key={`${top.kind}:${top.id}`}
        client={client}
        kind={top.kind}
        id={top.id}
        onDone={() => {
          refreshRoles()
          freshSettings(sceneKeyOf(stack.length - 2))
          pop()
        }}
      />
    ) : top.name === 'group' ? (
      <GroupScreen
        signedIn={session != null}
        onSignIn={signInHere}
        client={client}
        groupRef={{ kind: top.kind, id: top.id }}
        chats={chatsOf(top.kind, top.id)}
        onOpenChat={openChat}
        onLoadChatPreview={loadChatPreviews}
        initialTab={top.tab}
        onTab={topTab}
        initialWhen={top.when}
        onWhen={next => {
          writeTop(current => {
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
        onAutoScheduler={league => {
          push({ name: 'autoScheduler', leagueId: league.id })
        }}
        onCreateGame={group => {
          if (group.kind !== 'league')
            push({ name: 'createGame', kind: group.kind, id: group.id })
        }}
        onOpenRequest={id => {
          push({ name: 'notification', id })
        }}
      />
    ) : top.name === 'umpireSchedule' ? (
      <UmpireScheduleScreen
        key={top.id}
        client={client}
        onBeforeLeave={registerUmpireLeave}
        route={{
          ...top,
          id: top.id === '' ? (umpireLeagues[0]?.id ?? '') : top.id
        }}
        leagues={umpireLeagues}
        onOpenTeam={teamId => {
          push({
            name: 'team',
            team: asTeamSummary({
              id: teamId,
              name: '',
              shortName: null,
              logoPath: null
            })
          })
        }}
        onOpenGame={gameId => {
          push({ name: 'game', gameId, title: '', tab: 'info' })
        }}
        onRoute={route => {
          writeTop(current => ({
            ...current,
            [tab]: [...current[tab].slice(0, -1), route]
          }))
        }}
      />
    ) : top.name === 'leagueUmpires' ? (
      <LeagueUmpiresScreen
        key={top.id}
        client={client}
        league={top.id}
        onChanged={refreshRoles}
        onOpenPerson={(userId, name) => {
          openPerson({ kind: 'league', id: top.id }, userId, name)
        }}
      />
    ) : top.name === 'umpireNoteTypes' ? (
      <UmpireLevelsScreen
        key={top.id + ':notes'}
        client={client}
        league={top.id}
        kind="notes"
      />
    ) : top.name === 'umpireTypes' ? (
      <UmpireLevelsScreen
        key={top.id + ':types'}
        client={client}
        league={top.id}
        kind="types"
      />
    ) : top.name === 'umpireLevels' ? (
      <UmpireLevelsScreen key={top.id} client={client} league={top.id} />
    ) : top.name === 'umpireRequirements' ||
      top.name === 'umpireRequirementEdit' ? (
      <UmpireRequirementsScreen
        key={`${top.name}:${top.id}`}
        client={client}
        league={top.id}
        seasonIds={
          top.name === 'umpireRequirementEdit' ? top.seasonIds : undefined
        }
        onNext={seasonIds => {
          push({ name: 'umpireRequirementEdit', id: top.id, seasonIds })
        }}
        onApplied={pop}
      />
    ) : top.name === 'groupSettings' ? (
      <GroupSettingsScreen
        key={`${top.kind}:${top.id}:${sceneVisit}`}
        client={client}
        groupRef={{ kind: top.kind, id: top.id }}
        onUmpires={name => {
          push(
            name === 'umpireSchedule'
              ? { name, id: top.id, view: 'league' }
              : { name, id: top.id }
          )
        }}

        onAddPeople={group => {
          push({ name: 'groupAddPeople', ...group, teamReturn: top.teamReturn })
        }}
        onInvites={group => {
          push({ name: 'groupInvites', ...group, teamReturn: top.teamReturn })
        }}
        onAddPlayer={teamId => {
          push({
            name: 'teamAddPlayer',
            kind: 'team',
            id: teamId,
            teamReturn: top.teamReturn
          })
        }}
        onCreatePlayer={teamId => {
          push({
            name: 'teamCreatePlayer',
            kind: 'team',
            id: teamId,
            teamReturn: top.teamReturn
          })
        }}
        onOpenTimeFrame={group => {
          push({ name: 'seasonTimeFrame', kind: 'season', id: group.id })
        }}
        onLocation={group => {
          if (group.kind !== 'season')
            push({
              name: 'groupLocation',
              kind: group.kind,
              id: group.id,
              teamReturn: top.teamReturn
            })
        }}
        onChanged={refreshRoles}
        onRequest={id => {
          push({ name: 'notification', id })
        }}

        onPromote={group => {
          push({ name: 'promoteExternal', id: group.id })
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
                if (user == null || session == null) {
                  // The server no longer takes the session: not a sign-out.
                  sessionRefused()
                  pop()
                  return
                }
                const updated = { ...session, user }
                setSession(updated)
                rememberSession(updated)
                pop()
              })
              .catch(() => undefined)
        }}
      />
    ) : top.name === 'gameSettings' ||
      (top.name === 'createGame' && top.gameId != null) ? (
      <EventSettingsScreen
        client={client}
        gameId={top.gameId!}
        onSaved={(result: GameSettingsResult) => {
          setSuccessNotice({
            id: Date.now(),
            message:
              result.notice ??
              (result.status === 'pending'
                ? 'Game proposal sent'
                : result.status === 'eventUpdated'
                  ? 'Event changes saved'
                  : 'Game changes saved')
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
      <GameFormScreen
        client={client}
        mode={{ kind: 'create', source: { kind: top.kind, id: top.id } }}
        onEventCreated={id => {
          replace({ name: 'game', gameId: id, title: '' })
        }}
        onSaved={result => {
          setSuccessNotice({
            id: Date.now(),
            message: result.notice ?? 'Game saved'
          })
          if (result.status === 'accepted' && result.gameId != null)
            replace({ name: 'game', gameId: result.gameId, title: '' })
          else replace({ name: 'notification', id: result.id })
          refreshRoles()
          refreshNotifications().catch(() => undefined)
        }}
        onCancel={pop}
      />
    ) : top.name === 'promoteExternal' ? (
      <PromoteExternalScreen
        client={client}
        teamId={top.id}
        onSent={(id, result) => {
          if (result?.status === 'accepted') {
            setSuccessNotice({ id: Date.now(), message: result.message })
            replace({ name: 'group', kind: 'team', id: top.id })
          } else replace({ name: 'notification', id })
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
        onSent={(id, result) => {
          if (result?.status === 'accepted') {
            setSuccessNotice({ id: Date.now(), message: result.message })
            if (stacks[tab].length > 1) pop()
            else
              replace({
                name: 'group',
                kind: top.kind,
                id: top.id,
                tab: top.kind === 'season' ? 'teams' : undefined
              })
          } else replace({ name: 'notification', id })
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
        onOpenTarget={notice => {
          if (notice.venueId != null)
            push({ name: 'venue', venueId: notice.venueId })
          else if (notice.gameId != null)
            push({
              name: 'game',
              gameId: notice.gameId,
              title: '',
              tab: 'info'
            })
          else if (notice.leagueId != null)
            push({ name: 'autoScheduler', leagueId: notice.leagueId })
          else if (notice.seasonId != null)
            push({
              name: 'group',
              kind: 'season',
              id: notice.seasonId,
              tab: 'schedule'
            })
          else if (notice.teamId != null)
            push({
              name: 'group',
              kind: 'team',
              id: notice.teamId,
              tab: 'schedule'
            })
        }}
        onUpload={gameId => {
          push({ name: 'game', gameId, title: '', tab: 'watch' })
        }}
        onDismissed={() => {
          refreshNotifications().catch(() => undefined)
        }}
        onDecided={() => {
          refreshRoles()
          refreshNotifications().catch(() => undefined)
        }}
      />
    ) : top.name === 'notification' ? (
      <NotificationDetailScreen
        client={client}
        id={top.id}
        onChanged={(replacementId, completion) => {
          refreshRoles()
          if (completion != null) {
            setSuccessNotice({ id: Date.now(), message: completion.notice })
            if (completion.gameId != null)
              replace({ name: 'game', gameId: completion.gameId, title: '' })
            else if (completion.source != null)
              replace({ name: 'group', ...completion.source })
            else pop()
          } else if (replacementId != null)
            replace({ name: 'notification', id: replacementId })
          refreshNotifications().catch(() => undefined)
        }}
        onUpload={gameId => {
          push({ name: 'game', gameId, title: '', tab: 'watch' })
        }}
      />
    ) : top.name === 'chatMembers' || top.name === 'chatInfo' ? (
      gated(
        <ChatInfoScreen
          showMembers={top.name === 'chatMembers'}
          engine={chatEngine!}
          client={client}
          conversationId={top.conversationId}
          userId={signedInAs!}
          onLeft={() => {
            // Out of the chat and its members, back to the list.
            writeTop(current => ({
              ...current,
              [tab]: current[tab].filter(
                step =>
                  step.name !== 'chatMembers' &&
                  step.name !== 'chatInfo' &&
                  step.name !== 'conversation'
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
            // A completed request must not navigate a scene already left.
            if (
              navigationRef.current.tab !== tab ||
              navigationRef.current.top !== top
            )
              return
            const listed = chatEngine
              ?.conversations()
              .find(chat => chat.id === conversation.id)
            const workspace =
              tab === 'chat'
                ? -1
                : stacks[tab].findLastIndex(
                    frame => frame.name === 'conversation'
                  )
            const frame = stacks[tab][workspace] as
              Extract<Pushed, { name: 'conversation' }> | undefined
            const sourceFrames = stacks[tab].slice(0, workspace)
            let originHistory =
              frame == null
                ? undefined
                : retainedChatOrigin(frame, sourceFrames)
            if (workspace >= 0 && originHistory == null) {
              // Completing a chat on another retained tab may have removed
              // this visit's history. Re-establish its source before the DM.
              const address = routeOf(tab, sourceFrames.at(-1), filters)
              showRoute(address, true)
              originHistory = scoringOriginHistory()
              chatHistory.set(originHistory, {
                path: routePath(address),
                tab,
                frames: sourceFrames
              })
            }
            const destination: Pushed = {
              name: 'conversation',
              conversationId: conversation.id,
              title: listed?.title ?? conversation.title ?? '',
              originHistory
            }
            if (originHistory != null) {
              discardChatHistoryFrom(originHistory + 1)
              chatHistory.set(originHistory + 1, {
                path: routePath(destination),
                tab,
                frames: [...stacks[tab].slice(0, workspace), destination]
              })
              finishChatChild(
                {
                  name: 'conversation',
                  conversationId: conversation.id
                },
                originHistory
              )
            } else inPlace.current = true
            // Completing the child updates the one workspace above its origin:
            // the new chat takes this screen's place, so Back goes to the list
            // rather than to a finished form.
            writeTop(current => ({
              ...current,
              [tab]: [
                ...current[tab].slice(0, workspace >= 0 ? workspace : -1),
                destination
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
              writeTop(current => ({
                ...current,
                [tab]: [...current[tab].slice(0, -1), { name: 'chatDevices' }]
              }))
            }}
          />
        </ChatCoreGate>
      )
    ) : top.name === 'apiKeyNew' ? (
      session == null ? null : (
        <NewApiKeyScreen client={client} onCreated={pop} />
      )
    ) : top.name === 'account' && session != null ? (
      <AccountScreen
        client={client}
        onCreateApiKey={() => {
          push({ name: 'apiKeyNew' })
        }}
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
        onSignOut={leaveSession}
        onSignOutRequest={() => {
          // Unsent changes go with the phone's file: ask first.
          if ((outbox?.count ?? 0) > 0) {
            setConfirmingSignOut(true)
            return
          }
          signOutNow()
        }}
        onAccountDeleted={leaveSession}
      />
    ) : top.name === 'player' ? (
      <PlayerScreen
        key={`${signedInAs ?? 'signed-out'}:${top.userId}:${top.onTeam ?? ''}:${visit == null ? '' : sceneVisit}`}
        client={client}
        onOpenChat={chatEngine == null ? undefined : openPersonChat}
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
        onTab={topTab}
        onBack={pop}
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
        onFilter={onTop(setPlayerFilter)}
        onVideoFilter={onTop(setPlayerVideoFilter)}
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
        onOpenMoment={(gameId, videoId, atSec, title, untilSec) => {
          push({
            name: 'game',
            gameId,
            title,
            videoId,
            at: atSec,
            autoPlay: true,
            ...(untilSec == null ? {} : { highlightUntil: untilSec })
          })
        }}
        onRemovedFromTeam={(teamId, name, notice) => {
          setSuccessNotice({ id: Date.now(), message: notice })
          // The request may answer after Back: the roster is then not this
          // screen's to return to.
          onTop(backToRoster)(teamId, name)
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
        signedIn={session != null}
        onSignIn={signInHere}
        client={client}
        id={top.team.id}
        team={top.team}
        onLoaded={team => {
          teamNames.current.set(top.team.id, team.name)
        }}
        onCreateGame={id => {
          push({ name: 'createGame', kind: 'team', id })
        }}
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
        onTab={topTab}
        chats={chatsOf('team', top.team.id)}
        onOpenChat={openChat}
        onLoadChatPreview={loadChatPreviews}
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
        onTab={topTab}
        chats={chatsOf('season', top.season.id)}
        onOpenChat={openChat}
        onLoadChatPreview={loadChatPreviews}
        initialWhen={top.when}
        onWhen={next => {
          writeTop(current => {
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
        onOpenChat={chatEngine == null ? undefined : openPersonChat}
        kind={top.kind}
        id={top.id}
        userId={top.userId}
        onOpenPlayer={openPlayer}
        onChanged={refreshRoles}
        onTitle={title => {
          writeTop(current => {
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
          writeTop(current => {
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
        signedIn={session != null}
        onSignIn={signInHere}
        socket={gameSocket}
        client={client}
        gameId={top.gameId}
        onSettings={() => {
          push({ name: 'gameSettings', gameId: top.gameId })
        }}
        onScoreGame={() => {
          push({ name: 'scoreOptions', gameId: top.gameId })
        }}
        onCoachGame={teamId => {
          push({ name: 'coachGame', gameId: top.gameId, teamId })
        }}
        onReplay={() => {
          push({ name: 'gameReplay', gameId: top.gameId })
        }}
        onOpenPlayer={openPlayer}
        onOpenTeam={team => {
          push({ name: 'team', team })
        }}
      />
    ) : top.name === 'scoreOptions' ? (
      <ScoreGameScreen
        key={top.gameId}
        client={client}
        gameId={top.gameId}
        onFullScoring={() => {
          push({ name: 'scoreGame', gameId: top.gameId })
        }}
        onScoreboard={() => {
          push({ name: 'scoreboardOverride', gameId: top.gameId })
        }}
      />
    ) : top.name === 'scoreboardOverride' ? (
      <ScoreboardOverrideScreen
        apiBaseUrl={apiBaseUrl}
        gameId={top.gameId}
        token={client.token}
        onSignIn={next => {
          // The board's socket refused the session (4401): not a sign-out.
          sessionRefused()
          const signIn: Route = { name: 'signIn', next }
          goToRoute(signIn)
          showRoute(signIn)
        }}
      />
    ) : top.name === 'coachGame' ? (
      <CoachGameScreen
        key={`${signedInAs ?? 'local'}:${top.gameId}:${top.teamId}`}
        client={client}
        gameId={top.gameId}
        teamId={top.teamId}
        userId={signedInAs}
        socket={gameSocket}
        onExit={onTop(() => {
          // Back to the game, on its Box score tab: a coach who does not
          // score has no Score Game tab to come back to.
          popRoute()
          writeTop(current => {
            const held = current[tab].slice(0, -1)
            const last = held.at(-1)
            return {
              ...current,
              [tab]:
                last?.name === 'game' && last.gameId === top.gameId
                  ? [...held.slice(0, -1), { ...last, tab: 'boxScore' }]
                  : [...held, gameUnder(top.gameId, 'boxScore')]
            }
          })
        })}
      />
    ) : top.name === 'gameReplay' ? (
      <GameReplayScreen
        client={client}
        socket={gameSocket}
        gameId={top.gameId}
        onExit={pop}
        onOpenPlayer={openPlayer}
        onNotReplayable={() => {
          // The replay sits on its game's page, which it gives way to without
          // leaving a step behind for Back to walk into.
          const below = stack.at(-2)
          markInPlace(true)
          if (below?.name === 'game' && below.gameId === top.gameId) pop()
          else replace(gameUnder(top.gameId))
        }}
      />
    ) : top.name === 'scoreGame' ? (
      scoringBody
    ) : top.name === 'game' ? (
      <GameScreen
        signedIn={session != null}
        onSignIn={signInHere}
        socket={gameSocket}
        client={client}
        gameId={top.gameId}
        onSettings={() => {
          push({ name: 'gameSettings', gameId: top.gameId })
        }}
        onScoreGame={onTop((resume?: GamePlaybackReturn) => {
          // The intent goes with the write: a dropped write leaves none.
          intend('forward')
          writeTop(current => {
            const held = current[tab]
            const last = held.at(-1)
            const frames =
              last?.name === 'game' && resume != null
                ? [
                    ...held.slice(0, -1),
                    { ...last, ...resume, tab: 'watch' as const }
                  ]
                : held
            return {
              ...current,
              [tab]: [...frames, { name: 'scoreOptions', gameId: top.gameId }]
            }
          })
        })}
        onCoachGame={teamId => {
          push({ name: 'coachGame', gameId: top.gameId, teamId })
        }}
        onDjGame={
          walkUpMusic.djSupported
            ? () => {
                push({ name: 'djGame', gameId: top.gameId })
              }
            : undefined
        }
        onReplay={() => {
          push({ name: 'gameReplay', gameId: top.gameId })
        }}
        onOpenPlayer={openPlayer}
        onOpenTeam={team => {
          push({ name: 'team', team })
        }}
        initialTab={top.tab === 'score' ? undefined : top.tab}
        autoPlay={top.autoPlay}
        initialVideoId={top.videoId}
        startAtSec={top.at}
        onTab={next => {
          writeTop(current => {
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
        from={top.from}
        highlightUntil={top.highlightUntil}
        onAngles={next => {
          markInPlace(!anglesOpenPage(next))
          writeTop(current => {
            const held = current[tab]
            const last = held[held.length - 1]
            if (last?.name !== 'game') return current
            return {
              ...current,
              [tab]: [...held.slice(0, -1), withAngles(last, next)]
            }
          })
          // A player opened as a page of its own, closed by its ✕: back to
          // the step it was opened over, so Back then leaves the videos page
          // instead of walking into a copy of it.
          if (next.from === null && top.from != null && live())
            stepBackTo(routeOf(tab, withAngles(top, next), filters))
        }}
        onMoment={(videoId, atSec) => {
          markInPlace(true)
          writeTop(current => {
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
          writeTop(current => {
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
  }

  // The header belongs to the last screen on top that draws one: while the
  // scorer rises over a game, the game's; while a player's settings slide off
  // back onto the scorer, the settings'.
  if (!immersiveTop) chromeTop.current = { frame: top }
  const chromeDepth = immersiveTop ? stack.length - 1 : stack.length
  const chromeFrame = immersiveTop
    ? (chromeTop.current?.frame ?? stack[chromeDepth - 1])
    : stack[chromeDepth - 1]
  const header = (
    <AppHeader
      apiBaseUrl={apiBaseUrl}
      isAdmin={isAdmin}
      buildsClient={session == null ? undefined : client}
      title={
        chromeFrame?.name === 'conversation'
          ? lstrings.chat_chats
          : titleFor(tab, chromeFrame)
      }
      contentHeight={handoffHeight}
      // The mark on every screen that is a destination in its own right —
      // home, and the two lists — and on none that was pushed on top of one,
      // where the chevron and what scrolled up into the header say where you
      // are.
      showMark={chromeFrame == null}
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
      // Under an immersive top the header shows only while the cover rises
      // over it, and Back there would pop the cover, not the screen named.
      // A chevron only where there is a screen to go back to: at a tab's root
      // an open chat overlay holds Back (its own listener closes it) without
      // lending the header one.
      onBack={
        stack.length === 0
          ? undefined
          : (backOverride ?? (immersiveTop ? undefined : pop))
      }
      tess={
        tessAvailable && !tessSuppressed
          ? {
              open: tessOpen,
              onPress: () => {
                setTessOpen(open => !open)
              }
            }
          : undefined
      }
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

  // The visible route's scope on the socket, which its screen's reads wait
  // for.
  const visibleScope =
    props.fieldPreview === true
      ? undefined
      : screenScopeOf(tab, top, walkUpMusic.djSupported)

  // The header is glass and sits **over** the content, so the page moves under
  // it; each scene therefore starts at the top of the window and is padded
  // down by the header's measured height (0 for a screen that draws its own).
  //
  // The chrome's children carry a key, and that is not decoration. React
  // reconciles children by position, so a tree that is `[header, nav]` on a
  // phone and `[header]` on a desktop would match the wrong things when the
  // window crossed the boundary. The scenes are keyed by the navigator, so
  // nothing below them notices either — the `<video>` element least of all.
  //
  // Tess's chat is keyed for the same reason: opening it on a wide window
  // turns the root into a row, the column first, and the pane — the video
  // playing in it — carries on. On a narrow one the same element is a layer
  // over the whole app, drawn above it by its z-index, and the pane stays
  // mounted underneath. Only its style changes across the boundary, so the
  // chat itself — a reply on its way, the draft and its files, the
  // microphone's socket — is never remounted by a resize or a rotation.
  //
  // The layer is modal: while it covers a narrow window, the app beneath is
  // hidden from VoiceOver and TalkBack, its floating destinations are not
  // drawn, and on the web nothing under it takes focus or a click.
  const tessPanel = tessShown && (
    <TessFrame key="tess" wide={tessWide}>
      <TessPanel
        client={client}
        onClose={closeTess}
        onNavigate={openTessLink}
        screen={tessScreen}
      />
    </TessFrame>
  )
  const bannerShown =
    bannerText != null || createRefused || heldTeams.length > 0
  const chrome = (
    <>
      <View key="header" style={styles.headerLayer}>
        {header}
        <OfflineBanner
          text={bannerText}
          refusal={createRefused ? OFFLINE_CREATE_MESSAGE : undefined}
          held={heldTeams}
          onLayout={setBannerHeight}
        />
      </View>
      {!isWide && !tessLayer && (
        <AppNav
          key="nav"
          onHeight={setNavigationHeight}
          mode="floating"
          selected={tab}
          onSelect={selectTab}
          dots={{ chat: hasUnread(chatList) }}
        />
      )}
    </>
  )
  const sceneOf = (index: number): StackScene => {
    const frame = stack[index] as Pushed | undefined
    const key = sceneKeyOf(index)
    return {
      key,
      group: tab,
      depth: index + 1,
      presentation: presentationOf(frame),
      immersive: isImmersive(frame),
      node: renderFrame(frame, key)
    }
  }
  const topScene: StackScene =
    props.fieldPreview === true
      ? {
          key: 'fieldPreview',
          group: tab,
          depth: 0,
          presentation: 'push',
          immersive: true,
          node: (
            <StandaloneField
              onExit={() => {
                selectTab('home')
              }}
            />
          )
        }
      : sceneOf(stack.length - 1)
  const retainedScene: StackScene | undefined =
    scoringFrame == null || scoringActive
      ? undefined
      : {
          key: scoreKey(scoringFrame.gameId),
          group: tab,
          depth: Math.max(0, stack.length - 1),
          presentation: 'cover',
          immersive: true,
          node: scoringBody
        }

  return withChatKeyboard(
    <GestureHandlerRootView style={styles.root}>
      <DeviceApprovalContext.Provider value={deviceApprovals}>
        <ChatOverlayHost>
          <TessOverlayProvider active={tessColumn}>
            <View style={[styles.app, tessColumn && styles.split]}>
              {tessPanel}
              <View key="pane" style={styles.pane} {...coveredBy(tessLayer)}>
                <PaneBesideTess open={tessColumn}>
                  <ScreenScopeProvider socket={gameSocket} scope={visibleScope}>
                    <StackNavigator
                      top={topScene}
                      retained={retainedScene}
                      // The field preview is one scene, with nothing beneath.
                      renderBelow={() =>
                        props.fieldPreview !== true && stack.length > 0
                          ? sceneOf(stack.length - 2)
                          : undefined
                      }
                      chrome={chrome}
                      onForget={key => sceneVisits.current.delete(key)}
                      onSwipeBack={swipeBack ? popFromDrag : undefined}
                      intent={navigationIntent}
                      // Not under Tess's layer: there Back closes the chat
                      // (`useTessBack`), and must not drag away the screen it
                      // covers.
                      predictiveBack={predictiveBack && !tessLayer}
                      predictiveBackNow={predictiveBackNow}
                      popPending={popPending}
                      headerHeight={
                        headerHeight + (bannerShown ? bannerHeight : 0)
                      }
                      navigationHeight={isWide ? 0 : navigationHeight}
                      onHandoff={setHandoff}
                      onHandoffHeight={setHandoffHeight}
                      onBackOverride={setBack}
                    />
                  </ScreenScopeProvider>
                  <TessOverlayHost />
                </PaneBesideTess>
              </View>
              <SuccessToast notice={successNotice} />
              <DeviceApprovalPrompt />
              {confirmingSignOut && (
                <ChoiceSheet
                  title="Sign Out?"
                  choices={[
                    {
                      label: 'Sign Out',
                      detail: unsentLossText(outbox?.count ?? 0),
                      destructive: true,
                      onPress: signOutNow
                    }
                  ]}
                  onClose={() => {
                    setConfirmingSignOut(false)
                  }}
                />
              )}
              {askingTeam != null && caching != null && (
                <ChoiceSheet
                  title="Player Not Saved"
                  choices={[
                    ...(askingTeam.state === 'dead'
                      ? [
                          {
                            label: 'Try Again',
                            onPress: () => {
                              caching
                                .retryTeam(askingTeam.id)
                                .catch(() => undefined)
                            }
                          }
                        ]
                      : []),
                    {
                      label: "Use Server's Copy",
                      detail:
                        "Takes the player off this phone and shows the team's roster as the server has it.",
                      destructive: true,
                      onPress: () => {
                        caching.discardTeam(askingTeam.id).catch(() => false)
                      }
                    }
                  ]}
                  onClose={() => {
                    setAskingTeam(undefined)
                  }}
                />
              )}
            </View>
          </TessOverlayProvider>
        </ChatOverlayHost>
      </DeviceApprovalContext.Provider>
    </GestureHandlerRootView>
  )
}

/** How often a session opened on the stored user is asked about again. */
export const SESSION_CONFIRM_MS = 30_000

/**
 * Whether `next` is the form for something only the server makes: a team, a
 * season, a league, or a new game or event. Editing a game that exists is
 * not one.
 */
function createsOnServer(next: Pushed): boolean {
  return (
    next.name === 'createGroup' ||
    (next.name === 'createGame' && next.gameId == null)
  )
}

/**
 * The scope the visible route holds on the socket: Home and Schedule as tabs,
 * and an event for a pushed game, its scoring, or Coach Game. The Videos tab
 * and every other screen take none.
 */
export function screenScopeOf(
  tab: NavTabId,
  top: Pushed | undefined,
  djSupported: boolean
): ScreenScope | undefined {
  if (top == null) {
    if (tab === 'home') return { scope: 'home' }
    if (tab === 'schedule') return { scope: 'schedule' }
    return undefined
  }
  switch (top.name) {
    case 'game':
    case 'scoreGame':
    case 'coachGame':
      return { scope: 'event', gameId: top.gameId }
    case 'djGame':
      // Where there is no DJ Game, its address is the game's page.
      return djSupported ? undefined : { scope: 'event', gameId: top.gameId }
    default:
      return undefined
  }
}

/**
 * The name of the screen you are on, never the name of the app.
 *
 * Home is `Your Home` rather than `TeamStation`, which the header already says
 * on the line above: the two together read `TEAMSTATION / TeamStation`, which
 * tells you nothing twice.
 */
/** Whether a frame is the season with this id. */
function heldSeason(seasonId: string): (frame: Pushed) => boolean {
  return frame => frame.name === 'season' && frame.season.id === seasonId
}

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
  if (
    route.name === 'autoScheduler' ||
    route.name === 'fieldManager' ||
    route.name === 'scheduleSeason' ||
    route.name === 'schedulePreview'
  ) {
    const league = {
      name: 'group' as const,
      kind: 'league' as const,
      id: route.leagueId
    }
    const scheduler = {
      name: 'autoScheduler' as const,
      leagueId: route.leagueId
    }
    return {
      [tab]:
        route.name === 'autoScheduler'
          ? [league, scheduler]
          : [league, scheduler, route]
    }
  }
  if (route.name === 'venueField')
    return {
      [tab]: [{ name: 'venue' as const, venueId: route.venueId }, route]
    }
  if (
    route.name === 'groupLocation' ||
    route.name === 'groupAddPeople' ||
    route.name === 'groupInvites' ||
    route.name === 'teamCreatePlayer' ||
    route.name === 'teamAddPlayer'
  ) {
    const settings = {
      name: 'groupSettings' as const,
      kind: route.kind,
      id: route.id,
      teamReturn: route.teamReturn
    }
    return { [tab]: [...stackFor(settings)[tab]!, route] }
  }
  if (route.name === 'seasonTimeFrame') {
    // Opened by its address too, the season's settings are underneath, so
    // Save and the back button land there.
    const settings = {
      name: 'groupSettings' as const,
      kind: 'season' as const,
      id: route.id
    }
    return { [tab]: [...stackFor(settings)[tab]!, route] }
  }
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
  if (
    route.name === 'scoreOptions' ||
    (route.name === 'game' && route.tab === 'score')
  )
    return {
      [tab]: [
        gameUnder(route.gameId),
        { name: 'scoreOptions', gameId: route.gameId }
      ]
    }
  // A replay sits on its game, so Exit lands on the game page.
  if (route.name === 'gameReplay')
    return { [tab]: [gameUnder(route.gameId), route] }
  if (route.name === 'djGame') return { [tab]: [route] }
  // Over the game's Box score, where the coach's Back returns.
  if (route.name === 'coachGame')
    return { [tab]: [gameUnder(route.gameId, 'boxScore'), route] }
  // Back from a directly opened dashboard returns through the scoring choices.
  if (route.name === 'scoreboardOverride') {
    return {
      [tab]: [
        gameUnder(route.gameId),
        { name: 'scoreOptions', gameId: route.gameId },
        route
      ]
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
  // Back from Create API key is Account.
  if (route.name === 'apiKeyNew')
    return { [tab]: [{ name: 'account' }, { name: 'apiKeyNew' }] }
  if (route.name === 'chatDevices') return { [tab]: [{ name: 'chatDevices' }] }
  if (route.name === 'chatLink') return { [tab]: [{ name: 'chatLink' }] }

  if (route.name === 'chatReports') return { [tab]: [{ name: 'chatReports' }] }
  if (route.name === 'chatNew') return { [tab]: [{ name: 'chatNew' }] }
  if (
    route.name === 'conversation' ||
    route.name === 'chatMembers' ||
    route.name === 'chatInfo'
  ) {
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
              route.name === 'chatInfo'
                ? { name: 'chatInfo', conversationId: route.conversationId }
                : { name: 'chatMembers', conversationId: route.conversationId }
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
  section?: 'info' | 'boxScore' | 'watch' | 'score'
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
    route.name === 'chatMembers' ||
    route.name === 'chatInfo'
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
    if (
      top.name === 'scoreGame' ||
      top.name === 'scoreOptions' ||
      top.name === 'coachGame' ||
      top.name === 'gameReplay' ||
      top.name === 'scoreboardOverride'
    ) {
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
    if (top.name === 'apiKeyNew') return { name: 'apiKeyNew' }
    if (top.name === 'chatDevices') return { name: 'chatDevices' }
    if (top.name === 'chatLink') return { name: 'chatLink' }

    if (top.name === 'chatReports') return { name: 'chatReports' }
    if (top.name === 'chatNew') return { name: 'chatNew' }
    if (top.name === 'conversation') {
      return { name: 'conversation', conversationId: top.conversationId }
    }
    if (top.name === 'chatInfo') {
      return { name: 'chatInfo', conversationId: top.conversationId }
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
 * What the app's pane takes while Tess's chat covers it: hidden from screen
 * readers on every platform, and inert on the web, where it would otherwise
 * still take the keyboard's focus and a click.
 */
function coveredBy(covered: boolean): ViewProps {
  if (!covered) return {}
  // react-native-web passes `inert` to the element; native has no such prop.
  const inert: Record<string, boolean> =
    Platform.OS === 'web' ? { inert: true } : {}
  return {
    'aria-hidden': true,
    importantForAccessibility: 'no-hide-descendants',
    ...inert
  }
}

/**
 * Tess's chat: a column on the left of a wide window, as wide as it was
 * dragged, with the divider on its right edge; on a narrow one, a layer over
 * the whole app. The same element either way, so a resize across the two
 * never remounts the chat. Only this and the pane's frame read the column's
 * width, so a drag redraws them and what reads the frame, and not the Shell.
 */
function TessFrame({
  wide,
  children
}: {
  wide: boolean
  children: React.ReactNode
}): React.ReactElement {
  const styles = getStyles(useTheme())
  const { width, max, setWidth } = useTessWidth()
  return (
    <View
      testID={wide ? 'Tess column' : 'Tess layer'}
      style={wide ? [styles.tessColumn, { width }] : styles.tessLayer}
      aria-modal={!wide}
      accessibilityViewIsModal={!wide}
    >
      {children}
      {wide && <TessDivider width={width} max={max} onResize={setWidth} />}
    </View>
  )
}

/**
 * The pane's place beside Tess's open column, for the screens that size
 * themselves to it: the column's width in from the left, the window's
 * height; none while the column is closed, and the pane is the window again.
 * Only this reads the window's exact size, so a window being resized or the
 * divider dragged redraws it and what reads the frame, and not the Shell:
 * its children are the Shell's, unchanged by its own redraws.
 */
function PaneBesideTess({
  open,
  children
}: {
  open: boolean
  children: React.ReactNode
}): React.ReactElement {
  const { width, height } = useWindowDimensions()
  const column = useTessWidth().width
  const frame = useMemo<PaneFrame | null>(
    () =>
      open
        ? {
            x: column,
            y: 0,
            width: Math.max(0, width - column),
            height
          }
        : null,
    [open, column, width, height]
  )
  return <PaneFrameProvider frame={frame}>{children}</PaneFrameProvider>
}

/**
 * What Tess is told a screen is called: the header's title, or its subject.
 * A team's name comes from `teamNames` (what its screen loaded) when the
 * route has none, and a screen with neither is called by its route's name.
 */
export function screenTitle(
  tab: NavTabId,
  top: Pushed | undefined,
  teamNames?: ReadonlyMap<string, string>
): string {
  // A team, season or game reached by its address carries an empty name
  // until its screen loads one: empty is no name at all.
  const named = (name: string | null | undefined): string | undefined =>
    name == null || name === '' ? undefined : name
  const title =
    named(titleFor(tab, top)) ??
    (top == null
      ? TAB_TITLES[tab]
      : ((top.name === 'team'
          ? (named(top.team.name) ?? named(teamNames?.get(top.team.id)))
          : top.name === 'season'
            ? named(top.season.name)
            : top.name === 'game' || top.name === 'player'
              ? named(top.title)
              : undefined) ?? top.name))
  return title.slice(0, 200)
}

const TAB_TITLES: Record<NavTabId, string> = {
  home: 'Your Home',
  videos: 'Videos',
  schedule: 'Schedule',
  search: 'Search',
  chat: 'Chat'
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
    if (top.name === 'apiKeyNew') return lstrings.api_key_new_create
    if (top.name === 'chatDevices') return lstrings.chat_devices_title
    if (top.name === 'chatLink') return lstrings.chat_link_title

    if (top.name === 'chatReports') return lstrings.chat_reports_title
    if (top.name === 'chatNew') return lstrings.chat_new_title
    if (top.name === 'conversation') {
      return top.title === '' ? lstrings.chat_title : top.title
    }
    if (top.name === 'chatMembers' || top.name === 'chatInfo')
      return lstrings.chat_information
    if (top.name === 'djGame') return lstrings.dj_game
    if (top.name === 'walkUpSong') {
      return sprintf(lstrings.walkup_title, top.playerName)
    }
    if (top.name === 'scoreboardOverride') {
      return lstrings.game_override_scoreboard
    }
    if (top.name === 'scoreOptions') return lstrings.game_score_game
    if (top.name === 'person') return top.title
    return undefined
  }
  if (tab === 'home') return 'Your Home'
  if (tab === 'chat') return lstrings.chat_chats
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
  // Tess's column on the left of a wide window, and the pane beside it.
  split: {
    flexDirection: 'row'
  },
  // Above the pane, which its divider's grab area reaches over.
  tessColumn: {
    zIndex: 1
  },
  // Her chat over the whole of a narrow window, above the header and the
  // floating destinations.
  tessLayer: {
    position: 'absolute',
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 50,
    elevation: 50
  },
  pane: {
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

function reportNavigationError(error: unknown): void {
  console.error(error)
}
