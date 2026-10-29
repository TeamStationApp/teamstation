import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import {
  ActivityIndicator,
  Platform,
  Pressable,
  ScrollView,
  StatusBar,
  Text,
  useWindowDimensions,
  View
} from 'react-native'

import type {
  DictationModel,
  RosterEntry,
  SwapSidesAnswer,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import type { TagTarget } from '../../common/eventTags'
import { managesRoster } from '../../common/roles'
import type { ScoringAction } from '../../common/scoring/actions'
import {
  type PlaysLost,
  playsLost,
  resetsPlays,
  resetWarning,
  SWAP_SCORED_ELSEWHERE,
  swapEffect,
  WITHDRAWN_GAME
} from '../../common/scoring/playsLost'
import {
  awaitingResult,
  completesHitOffer,
  forcedFrom,
  runnerDecisionError as baseOccupiedError,
  undoesHitOffer
} from '../../common/scoring/rules'
import type { ScoringSession as GameSession } from '../../common/scoring/session'
import type { DefaultLineups } from '../../common/scoring/startingSetup'
import type { GameState } from '../../common/scoring/state'
import type { WalkUpSong } from '../../common/walkUpSong'
import type { BallArcState } from '../field/ballArcModel'
import { BaseballScreen } from '../field/BaseballScreen'
import type { FieldPlayer } from '../field/fieldModel'
import { createRelay, type Relay, useRelay } from '../field/fieldPropsRelay'
import { scoringMenuFrame, WEB_MENU_BUTTON } from '../field/fieldSafeArea'
import type { BaseProjection } from '../field/fieldTypes'
import { homeRunKind, homeRunLabel } from '../field/stadiumBoundary'
import { useFieldSurface } from '../field/useFieldSurface'
import { lstrings } from '../locales/strings'
import type { Route } from '../navigation/routes'
import { useInsets } from '../platform/safeArea'
import { CachingClient } from '../sync/cachingClient'
import {
  SERVER_COPY_PENDING,
  useHeldGameControl,
  useOutboxSummary,
  usePhoneOffline
} from '../sync/useOffline'
import { useTheme } from '../theme/ThemeContext'
import {
  NO_WALK_UP_MUSIC,
  useWalkUpNote,
  type WalkUpRosters
} from '../walkup/useWalkUpNote'
import { WalkUpControl } from '../walkup/WalkUpControl'
import type { WalkUpMusic } from '../walkup/walkUpMusicTypes'
import {
  appleMusicIds,
  type ReadinessStore,
  useWalkUpReadiness
} from '../walkup/walkUpReadiness'
import { WalkUpReadinessModals } from '../walkup/WalkUpReadinessModals'
import { startingAngle, trajectoryLabel } from './battedBall'
import { battedBallField, fieldStageInstruction } from './battedBallField'
import {
  assignDefender,
  battingWarningKey,
  emptyDefensePlayers,
  lineupCountMessage,
  lineupsUnaccepted,
  missingDefense,
  setupEditable,
  shortPlayerNames,
  withRosterDetails,
  withVisibleLineups
} from './currentSetup'
import { DefensiveRosterSheet } from './DefensiveRosterSheet'
import {
  type DictatedRoster,
  openDictatedRosters,
  rosterReply
} from './dictatedRoster'
import { useDictationControls } from './DictationButton'
import { ErrorCreditSheet } from './ErrorCreditSheet'
import { EventTagEditor } from './EventTagEditor'
import { HeldGameNotice } from './HeldGameNotice'
import { MoreMenu } from './MoreMenu'
import { OutcomeControls } from './OutcomeControls'
import { OverridesEditor } from './OverridesEditor'
import { addPlaceholderPlayers } from './placeholderPlayers'
import {
  describeCompletedPlays,
  describeEntryPlays,
  describeLastPlay,
  describePlay
} from './playDescription'
import {
  addRosteredPlayer,
  type PlayerDraft,
  rosterPlayerBody
} from './playerDraft'
import {
  priorRunnerPlayers,
  usePriorRunnerCorrection
} from './priorRunnerCorrection'
import { useDictationHandover } from './rosterDictation'
import { sameValue } from './rosterDirty'
import { RosterEditor, type RosterEditorDraft } from './RosterEditor'
import { type GameChanges, listen, useRosterLive } from './rosterLive'
import { RunnerControls } from './RunnerControls'
import type { RunnerDragView } from './runnerDrag'
import { RunnerDragTargets } from './RunnerDragTargets'
import { scoringAudio } from './scoringAudio'
import { runnerDecisionError } from './scoringFlow'
import {
  actsOnOpening,
  atRest,
  copyState,
  resumedScoringState,
  rosterRefusal,
  type SavedUndone,
  type ScoringScreenModel,
  scoringScreenModel,
  scoringScreenReducer,
  sessionAt
} from './scoringMachine'
import { SCORING_MENU, ScoringMenuButton } from './ScoringMenuAppearance'
import { scoringFieldPlayers } from './scoringMotion'
import { scoringPreferences } from './scoringPreferences'
import { withoutPrivateNames } from './scoringRosterCache'
import { rosterStaffSide, scorekeeperSide } from './scoringRosterEdit'
import {
  baseIds,
  battingSide,
  bottomActionsAllowed,
  canSwitchBatter,
  fieldingSide,
  scoreboardFor
} from './scoringSelectors'
import { ScoringSettings } from './ScoringSettings'
import { ScoringButton, ScoringError, ScoringSheet } from './ScoringSheet'
import {
  defaultsOf,
  DevelopmentScoringSource,
  type ScoringSource
} from './scoringSource'
import {
  type SaveStatus,
  scoringStatusLine,
  useReconnectSaving
} from './scoringStatusLine'
import {
  SCORING_OFFLINE_BAND,
  SCORING_STATUS_MAX_WIDTH,
  scoringOfflineFrame,
  scoringStatusFrame
} from './scoringStatusPlacement'
import {
  type HistoryEntry,
  type Position,
  POSITIONS,
  type ScoringEvent,
  type Side
} from './scoringTypes'
import {
  type GameReplaced,
  type OpenedGame,
  replacedNotice,
  useGameReplaced
} from './sidesSwapped'
import {
  RunnerRosterSheet,
  TiebreakerBases,
  TiebreakerSetupSheet
} from './TiebreakerSheets'
import { dictationUrl } from './useDictation'
import { useHomeRunCelebration } from './useHomeRunCelebration'
import { useMenuEscape } from './useMenuEscape'
import { useScoringClock } from './useScoringClock'
import { useScoringExit } from './useScoringExit'
import { useTiebreakerSetup } from './useTiebreakerSetup'

export interface ScoringScreenProps {
  active?: boolean
  onEditPlayer?: (userId: string, name: string, teamId: string) => void
  onSettingsRefresh?: (refresh: () => void) => () => void
  onBeforeLeave?: (check: () => Promise<boolean>) => () => void
  allowNavigation?: (route: Route) => boolean
  onNavigationApproved?: () => void
  client: TeamStationClient
  gameId: string
  userId?: string | number
  onExit: () => void
  source?: ScoringSource
  /**
   * The phone's music, for the batter's walk-up note. The web's has nothing
   * to play, and then the note never shows.
   */
  music?: WalkUpMusic
  /** Finds a walk-up song on this phone, as a handle `music` plays. */
  resolveSong?: (
    song: WalkUpSong,
    owner: { teamId: string; userId: string }
  ) => Promise<string | null>
  /** Whether an Apple Music clip fades on the phone's volume. */
  fadeAppleMusic?: boolean
  /** Where this device remembers what it has said about offline songs. */
  readiness?: ReadinessStore
  /**
   * The app's game socket. A saved game follows it: another device's plays
   * and lineups are read in once the screen is at rest.
   */
  socket?: GameChanges
  /** How long the swap notice stays up once drawn; for tests. */
  swapNoticeMs?: number
}
/** How long the notice that home and away were swapped stays up. */
const SWAP_NOTICE_MS = 8000
/** The menu's swap, refused while a change has not reached the server. */
const SWAP_UNSAVED = "Save the game's changes before swapping. Try again."
const SWAP_CHANGED =
  'The game changed since this opened. Check what will be lost, then confirm again.'
const NOTHING_LOST: PlaysLost = { atBats: 0, innings: 0 }
export function ScoringScreen(props: ScoringScreenProps): React.ReactElement {
  const theme = useTheme()
  const [opened, setOpened] = useState<GameSession>()
  const [visibleDefaults, setVisibleDefaults] = useState<DefaultLineups>({})
  const [rosters, setRosters] = useState<WalkUpRosters>({})
  const music = props.music ?? NO_WALK_UP_MUSIC
  // Both teams' Apple Music walk-up songs, once the game and its rosters
  // are read: they go into the phone's library on the way in.
  const walkUpIds = useMemo(
    () =>
      opened == null
        ? null
        : appleMusicIds(
            Object.values(rosters).flatMap(roster =>
              roster.map(entry => entry.walkUpSong)
            )
          ),
    [opened, rosters]
  )
  const [overlay, setOverlay] = useState(false)
  const readiness = useWalkUpReadiness(music, walkUpIds, {
    screen: 'scoring',
    blocked: overlay || props.active === false,
    store: props.readiness
  })
  const [rosterRights, setRosterRights] = useState<Record<string, boolean>>({})
  const [rosterDefaultSide, setRosterDefaultSide] = useState<Side>()
  const [keeperSide, setKeeperSide] = useState<Side>()
  const [detailsLoading, setDetailsLoading] = useState(false)
  const [detailsProblem, setDetailsProblem] = useState<string>()
  const rosterRevision = useRef(0)
  const authorizationRevision = useRef(0)
  const authorizationPending = useRef(false)
  const rightsRef = useRef(rosterRights)
  const openedContext = useRef<
    | {
        client: TeamStationClient
        gameId: string
        userId: ScoringScreenProps['userId']
        source: ScoringSource
        session: GameSession
      }
    | undefined
  >(undefined)
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  /**
   * The teams the game was read with as it opened, and its play
   * generation: the rosters, rights and staff side this screen holds are
   * theirs, and its session's plays that generation's.
   */
  const [openedSides, setOpenedSides] = useState<OpenedGame>()
  /** Says, once the game opened again, that its sides were swapped. */
  const [swapNotice, setSwapNotice] = useState<string>()
  /** The phone gave up its edits, and the server's copy has not come. */
  const [copyPending, setCopyPending] = useState(false)
  const surface = useFieldSurface()
  const fallback = useMemo(() => new DevelopmentScoringSource(), [])
  const source: ScoringSource = props.source ?? fallback
  // Every action is stamped on the server's clock, measured while this is open.
  useEffect(() => source.keepTime?.(), [source])
  useEffect(() => {
    let live = true
    setOpened(undefined)
    setVisibleDefaults({})
    setRosters({})
    authorizationPending.current = false
    rightsRef.current = {}
    setRosterRights({})
    setRosterDefaultSide(undefined)
    setKeeperSide(undefined)
    setFailed(false)
    const load = async (): Promise<void> => {
      const game = await props.client.game(props.gameId)
      const roles = await props.client.myRoles().catch(() => undefined)
      const rights = {
        [game.awayTeamId]: managesRoster(roles, game.awayTeamId),
        [game.homeTeamId]: managesRoster(roles, game.homeTeamId)
      }
      const loadRoster = async (teamId: string): Promise<RosterEntry[]> => {
        try {
          return await props.client.roster(teamId, {
            includeFullNames: rights[teamId]
          })
        } catch (caught: unknown) {
          if (
            rights[teamId] &&
            caught instanceof HttpError &&
            ['unauthorized', 'forbidden', 'notFound'].includes(caught.code)
          ) {
            rights[teamId] = false
            return withoutPrivateNames(await props.client.roster(teamId))
          }
          // An unavailable roster is not an empty team: reconciliation would
          // otherwise remove the saved lineup and defense. Offer load retry.
          throw caught
        }
      }
      const [away, home, defaults] = await Promise.all([
        loadRoster(game.awayTeamId),
        loadRoster(game.homeTeamId),
        defaultsOf(props.client, game)
      ])
      const value = await source.open(game, away, home)
      if (!live) return
      setOpenedSides({
        homeTeamId: game.homeTeamId,
        awayTeamId: game.awayTeamId,
        generation: value.generation ?? game.generation
      })
      rightsRef.current = rights
      setRosterRights(rights)
      setRosterDefaultSide(
        rosterStaffSide(roles, game.awayTeamId, game.homeTeamId)
      )
      setKeeperSide(scorekeeperSide(roles, game.awayTeamId, game.homeTeamId))
      openedContext.current = {
        client: props.client,
        gameId: props.gameId,
        userId: props.userId,
        source,
        session: value
      }
      setRosters({ [game.awayTeamId]: away, [game.homeTeamId]: home })
      setVisibleDefaults(defaults)
      setCopyPending(false)
      setOpened(value)
    }
    load().catch(() => {
      if (live) setFailed(true)
    })
    return () => {
      live = false
    }
  }, [props.client, props.gameId, props.userId, source, retry])
  const refreshDetails = useCallback(async (): Promise<void> => {
    if (opened == null) return
    let revision = ++rosterRevision.current
    const authorization = ++authorizationRevision.current
    const teams = Object.values(opened.resumable().state.gameData.teams).map(
      team => team.id
    )
    setDetailsLoading(true)
    setDetailsProblem(undefined)
    authorizationPending.current = true
    rightsRef.current = {}
    setRosterRights({})
    setRosterDefaultSide(undefined)
    let rolesRead = false
    try {
      const roles = await props.client.myRoles()
      rolesRead = true
      if (authorization !== authorizationRevision.current) return
      authorizationPending.current = false
      const rights = Object.fromEntries(
        teams.map(id => [id, managesRoster(roles, id)])
      )
      rightsRef.current = rights
      setRosterRights(rights)
      const { away, home } = opened.resumable().state.gameData.teams
      setRosterDefaultSide(rosterStaffSide(roles, away.id, home.id))
      setKeeperSide(scorekeeperSide(roles, away.id, home.id))
      setRosters(held =>
        Object.fromEntries(
          Object.entries(held).map(([id, rows]) => [
            id,
            rights[id] ? rows : withoutPrivateNames(rows)
          ])
        )
      )
      // A save may finish while roles are pending. Start this data read after
      // that acknowledgment, without discarding the current permission proof.
      revision = rosterRevision.current
      const entries = await Promise.allSettled(
        teams.map(
          async id =>
            await props.client.roster(id, { includeFullNames: rights[id] })
        )
      )
      if (authorization !== authorizationRevision.current) return
      if (revision === rosterRevision.current) {
        const refused = entries.map(
          entry =>
            entry.status === 'rejected' &&
            entry.reason instanceof HttpError &&
            ['unauthorized', 'forbidden', 'notFound'].includes(
              entry.reason.code
            )
        )
        const currentRights = Object.fromEntries(
          teams.map((id, index) => [id, rights[id] && !refused[index]])
        )
        rightsRef.current = currentRights
        setRosterRights(currentRights)
        setRosters(held =>
          Object.fromEntries(
            teams.map((id, index) => {
              const entry = entries[index]
              const rows =
                entry.status === 'fulfilled' ? entry.value : (held[id] ?? [])
              return [id, currentRights[id] ? rows : withoutPrivateNames(rows)]
            })
          )
        )
        if (
          entries.some(
            (entry, index) =>
              entry.status === 'rejected' &&
              (!refused[index] || rights[teams[index]])
          )
        )
          setDetailsProblem('Unable to refresh the roster. Please try again.')
      } else {
        // A successful save invalidated this captured read. Reconcile fresh
        // data so every team's authorized names return with the current values.
        await refreshDetails()
      }
    } catch (caught: unknown) {
      if (authorization === authorizationRevision.current) {
        if (
          !rolesRead ||
          (caught instanceof HttpError &&
            ['unauthorized', 'forbidden', 'notFound'].includes(caught.code))
        ) {
          rightsRef.current = {}
          setRosterRights({})
          setRosters(held =>
            Object.fromEntries(
              Object.entries(held).map(([id, rows]) => [
                id,
                withoutPrivateNames(rows)
              ])
            )
          )
        }
        if (rolesRead && revision !== rosterRevision.current) {
          await refreshDetails()
        } else {
          setDetailsProblem('Unable to refresh the roster. Please try again.')
        }
      }
    } finally {
      if (authorization === authorizationRevision.current) {
        authorizationPending.current = false
        setDetailsLoading(false)
      }
    }
  }, [opened, props.client])
  const wasActive = useRef(props.active !== false)
  const returning = props.active !== false && !wasActive.current
  const { onSettingsRefresh } = props
  useEffect(() => {
    const active = props.active !== false
    if (active && !wasActive.current) refreshDetails().catch(() => undefined)
    wasActive.current = active
  }, [props.active, refreshDetails])
  useEffect(() => {
    let live = true
    const remove = onSettingsRefresh?.(() => {
      // Replies do not establish commit order. Fetch current server values;
      // refresh revisions prevent a captured older read from replacing them.
      if (live) refreshDetails().catch(() => undefined)
    })
    return () => {
      live = false
      remove?.()
    }
  }, [onSettingsRefresh, refreshDetails])
  useEffect(
    () => () => {
      ++rosterRevision.current
      ++authorizationRevision.current
    },
    [props.client, props.gameId, props.userId, source, retry]
  )
  // Home and away swapped under the open game: once a save on its way has
  // come back, it is opened again, as a retry opens it, on its new sides
  // with their rosters, and the scorer is told.
  const reopenedFrom = useRef<GameSession>(undefined)
  // A wait for a save on its way, stopped when the screen moves on.
  const waitingForSave = useRef<(() => void) | undefined>(undefined)
  useEffect(
    () => () => {
      waitingForSave.current?.()
      waitingForSave.current = undefined
    },
    [opened]
  )
  const reopenReplaced = useCallback(
    (change: GameReplaced): void => {
      const session = opened
      // Once for each opened game, however many callers find the change.
      if (session == null || reopenedFrom.current === session) return
      reopenedFrom.current = session
      const reopen = async (): Promise<void> => {
        // Its changes name the old sides, or plays a reset deleted: it saves
        // nothing more. What it had not saved now, and what a stale save's
        // rebase dropped, is lost; a save that landed before a swap was
        // carried to the new sides.
        session.close()
        let lost = session.pending + session.lostToSwap
        // On a phone, writes the outbox still holds for the game from before
        // would be sent stale behind it: they are given up.
        if (props.client instanceof CachingClient) {
          const queue = await props.client.outboxSummary()
          if (
            (queue.chains[`game:${props.gameId}`] ?? 0) > 0 ||
            queue.games[props.gameId] != null
          ) {
            await props.client.discardGame(props.gameId)
            lost = Math.max(lost, 1)
          }
        }
        setSwapNotice(replacedNotice(change, lost))
        setRetry(value => value + 1)
      }
      const start = (): void => {
        reopen().catch(() => {
          setSwapNotice(replacedNotice(change, 0))
          setRetry(value => value + 1)
        })
      }
      if (!session.saving) {
        start()
        return
      }
      const stop = session.subscribe(() => {
        if (session.saving) return
        stop()
        waitingForSave.current = undefined
        start()
      })
      waitingForSave.current = stop
    },
    [opened, props.client, props.gameId]
  )
  const readSides = useCallback(
    async (): Promise<OpenedGame> => await props.client.game(props.gameId),
    [props.client, props.gameId]
  )
  useGameReplaced(
    props.socket,
    props.gameId,
    opened == null ? undefined : openedSides,
    readSides,
    reopenReplaced
  )
  // A save refused because the plays were reset since the game opened. A
  // reset comes with a swap, so the game is read to say whether it did.
  useEffect(() => {
    if (opened == null) return
    let asked = false
    const check = (): void => {
      if (!opened.replaced || asked) return
      asked = true
      readSides()
        .then(game => ({
          swapped:
            openedSides != null &&
            (game.homeTeamId !== openedSides.homeTeamId ||
              game.awayTeamId !== openedSides.awayTeamId)
        }))
        .catch(() => ({ swapped: false }))
        .then(({ swapped }) => {
          reopenReplaced({ swapped, reset: true })
        })
        .catch(() => undefined)
    }
    check()
    return opened.subscribe(check)
  }, [opened, openedSides, readSides, reopenReplaced])
  // Counted from when the reopened game is drawn: the notice shows over it,
  // not over the loading view.
  const noticeMs = props.swapNoticeMs ?? SWAP_NOTICE_MS
  useEffect(() => {
    if (swapNotice == null || opened == null) return
    const timer = setTimeout(() => {
      setSwapNotice(undefined)
    }, noticeMs)
    return () => {
      clearTimeout(timer)
    }
  }, [swapNotice, opened, noticeMs])
  if (
    opened == null ||
    openedContext.current?.client !== props.client ||
    openedContext.current.gameId !== props.gameId ||
    openedContext.current.userId !== props.userId ||
    openedContext.current.source !== source ||
    openedContext.current.session !== opened
  )
    return (
      <View
        style={[
          surface.root,
          {
            backgroundColor: theme.backgroundColor,
            justifyContent: 'center',
            alignItems: 'center'
          }
        ]}
      >
        {failed ? (
          <Text
            style={{
              color: theme.primaryTextColor,
              fontFamily: theme.regularTextFont
            }}
          >
            {copyPending ? SERVER_COPY_PENDING : 'Unable to load scoring.'}
          </Text>
        ) : (
          <ActivityIndicator accessibilityLabel="Loading game" />
        )}
        {failed && (
          <ScoringButton
            label="Retry loading scoring"
            onPress={() => {
              setRetry(value => value + 1)
            }}
          />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Exit Current Game"
          onPress={props.onExit}
          style={{ padding: 20 }}
        >
          <Text
            style={{
              color: theme.primaryTextColor,
              fontFamily: theme.regularTextFont
            }}
          >
            Exit Current Game
          </Text>
        </Pressable>
      </View>
    )
  return (
    <>
      {swapNotice != null && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            // Below the scoreboard, clear of its names.
            top: '30%',
            left: 16,
            right: 16,
            zIndex: 98,
            alignItems: 'center'
          }}
        >
          <Text
            accessibilityLiveRegion="polite"
            style={{
              color: theme.scoringSurface.text,
              backgroundColor: theme.scoringSurface.background,
              fontFamily: theme.regularTextFont,
              paddingHorizontal: 16,
              paddingVertical: 10,
              borderRadius: 12,
              overflow: 'hidden'
            }}
          >
            {swapNotice}
          </Text>
        </View>
      )}
      <ScoringPanel
        key={`${String(props.userId ?? 'local-scorer')}:${props.gameId}:${retry}`}
        onReopen={arrived => {
          setCopyPending(!arrived)
          setRetry(value => value + 1)
        }}
        onSwapped={answer => {
          reopenReplaced({
            swapped: true,
            reset:
              answer.reset.atBats > 0 ||
              (openedSides?.generation != null &&
                answer.generation !== openedSides.generation)
          })
        }}
        openedSides={openedSides}
        game={opened}
        visibleDefaults={visibleDefaults}
        client={props.client}
        gameId={props.gameId}
        persistent={source.persistent === true}
        source={source}
        onExit={props.onExit}
        userId={String(props.userId ?? 'local-scorer')}
        rosters={
          returning || authorizationPending.current
            ? Object.fromEntries(
                Object.entries(rosters).map(([id, rows]) => [
                  id,
                  withoutPrivateNames(rows)
                ])
              )
            : rosters
        }
        active={props.active !== false}
        onEditPlayer={props.onEditPlayer}
        onBeforeLeave={props.onBeforeLeave}
        allowNavigation={props.allowNavigation}
        onNavigationApproved={props.onNavigationApproved}
        rosterRights={returning ? {} : rosterRights}
        rosterDefaultSide={rosterDefaultSide}
        scorekeeperSide={keeperSide}
        detailsLoading={returning || detailsLoading}
        detailsProblem={detailsProblem}
        onRefreshDetails={() => {
          refreshDetails().catch(() => undefined)
        }}
        music={music}
        resolveSong={props.resolveSong}
        fadeAppleMusic={props.fadeAppleMusic}
        onOverlay={setOverlay}
        walkUpOpen={readiness.covering}
        socket={props.socket}
      />
      {props.active !== false && (
        <WalkUpReadinessModals readiness={readiness} />
      )}
    </>
  )
}
function statusOf(game: GameSession): SaveStatus {
  return {
    pending: game.pending,
    offline: game.offline,
    readOnly: game.readOnly,
    problem: game.problem
  }
}
/**
 * Whether two logs hold the same actions. One read back from the server lists
 * an action's keys in its cleaner's order (a pinch runner's player before his
 * base), so they compare by key.
 */
export function sameActions(
  a: readonly ScoringAction[],
  b: readonly ScoringAction[]
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (action, index) => action === b[index] || sameValue(action, b[index])
    )
  )
}
export function sameStatus(a: SaveStatus, b: SaveStatus): boolean {
  return (
    a.pending === b.pending &&
    a.offline === b.offline &&
    a.readOnly === b.readOnly &&
    a.problem === b.problem
  )
}
/** A number for each Undo entry, the same for as long as the entry lasts. */
const entryIds = new WeakMap<HistoryEntry, number>()
let nextEntryId = 1
function entryId(entry: HistoryEntry): number {
  let id = entryIds.get(entry)
  if (id == null) {
    id = nextEntryId++
    entryIds.set(entry, id)
  }
  return id
}
/**
 * A reset from the stored game shows the defaults a scorer can read in place
 * of a side that is still an unseen roster order. The log is unchanged, so
 * opening does not write that lineup into the game.
 */
function reduceVisible(
  model: ScoringScreenModel,
  event: ScoringEvent | SavedUndone,
  defaults: DefaultLineups
): ScoringScreenModel {
  const next = scoringScreenReducer(model, event)
  if (
    next === model ||
    (event.type !== 'RESET' && event.type !== 'SAVED_UNDONE')
  )
    return next
  const scoring = withVisibleLineups(next.scoring, defaults)
  return scoring === next.scoring ? next : { ...next, scoring }
}

function ScoringPanel(props: {
  active: boolean
  onEditPlayer?: ScoringScreenProps['onEditPlayer']
  onBeforeLeave?: ScoringScreenProps['onBeforeLeave']
  allowNavigation?: ScoringScreenProps['allowNavigation']
  onNavigationApproved?: ScoringScreenProps['onNavigationApproved']
  rosterRights: Record<string, boolean>
  rosterDefaultSide?: Side
  /** The one side this scorekeeper keeps score for, when that is exactly one. */
  scorekeeperSide?: Side
  detailsLoading: boolean
  detailsProblem?: string
  onRefreshDetails: () => void
  game: GameSession
  /** Defaults he can read. A side he cannot see is null, and stays the stored order. */
  visibleDefaults: DefaultLineups
  client: TeamStationClient
  gameId: string
  persistent: boolean
  source: ScoringSource
  onExit: () => void
  userId: string
  rosters: WalkUpRosters
  music: WalkUpMusic
  resolveSong?: ScoringScreenProps['resolveSong']
  fadeAppleMusic?: boolean
  /** Whether one of the panel's own modals is up, which holds any other. */
  onOverlay?: (open: boolean) => void
  /**
   * The walk-up walkthrough or notice is up over the panel: the clock and
   * any replay pause, and a dictation question waits, since iOS shows one
   * modal at a time.
   */
  walkUpOpen?: boolean
  socket?: GameChanges
  /**
   * The game's stored copy changed under the session: open it again.
   * `arrived` is whether the server's copy came back to the phone.
   */
  onReopen: (arrived: boolean) => void
  /** Home and away were swapped from the menu: open the game again. */
  onSwapped: (answer: SwapSidesAnswer) => void
  /**
   * The teams the screen opened on. A guest names its side's team from
   * these, never from a later read, so the server refuses one a swap moved.
   */
  openedSides?: OpenedGame
}): React.ReactElement {
  const theme = useTheme()
  // A ball in play saved without its result cannot be shown, because the
  // outcome chosen for it is logged only with the result: the screen picks
  // the game up at the pitch before it, and saves that only once the scorer
  // does something from there.
  const visibleDefaults = props.visibleDefaults
  const [model, dispatch] = useReducer(
    (model: ScoringScreenModel, event: ScoringEvent | SavedUndone) =>
      reduceVisible(model, event, visibleDefaults),
    props.game,
    game => {
      const resumed = game.resumable()
      return scoringScreenModel(
        withVisibleLineups(
          resumedScoringState(resumed.state, resumed.actions, true),
          visibleDefaults
        )
      )
    }
  )
  /** What the server says a swap does (`ScoringSession.serverSwap`). */
  const [serverSwap, setServerSwap] = useState(props.game.serverSwap)
  const [tagSnapshot, setTagSnapshot] = useState(
    () => props.game.tagSnapshotVersion
  )
  const [historyActive, setHistoryActive] = useState(false)
  const [tagTarget, setTagTarget] = useState<TagTarget | null>(null)
  // A scoring flush may outlive this editor or the authenticated account.
  const tagSelection = useRef(0)
  const tagMounted = useRef(true)
  const tagAcknowledgments = useRef(new Map<string, string>())
  const tagContext = useRef({
    game: props.game,
    source: props.source,
    userId: props.userId,
    gameId: props.gameId,
    client: props.client
  })
  tagContext.current = {
    game: props.game,
    source: props.source,
    userId: props.userId,
    gameId: props.gameId,
    client: props.client
  }
  useEffect(() => {
    const selection = tagSelection
    const mounted = tagMounted
    mounted.current = true
    return () => {
      selection.current++
      mounted.current = false
    }
  }, [])
  const loadTags = useCallback(
    async () =>
      (await props.source.tagChoices?.(props.userId)) ?? {
        recent: [],
        popular: []
      },
    [props.source, props.userId]
  )
  const state = model.scoring
  const openedLog = useRef(state.log)
  const refreshedLog = useRef<readonly ScoringAction[] | undefined>(undefined)
  const [status, setStatus] = useState(() => statusOf(props.game))
  // On the phone a save offline is queued and answered at once, so the
  // session never says it is offline: the client does. A queue the server
  // stopped says why, over everything else.
  const phoneOffline = usePhoneOffline(props.client)
  const heldGame = useHeldGameControl(props.client, props.gameId)
  const held = heldGame?.text
  // This game's own writes still on the phone: another game's, held or not,
  // keep nothing busy here.
  const queued =
    useOutboxSummary(props.client)?.chains[`game:${props.gameId}`] ?? 0
  const reconnecting = useReconnectSaving(
    phoneOffline || status.offline,
    status.pending > 0 || queued > 0
  )
  const shownStatus = scoringStatusLine({
    held,
    status,
    phoneOffline,
    reconnecting
  })
  const statusLine = shownStatus?.text ?? null
  // A phone makes room for the offline line across the top; the web's line
  // already sits above the board (`scoringOfflineFrame`).
  const topBand =
    shownStatus?.place === 'top' && Platform.OS !== 'web'
      ? SCORING_OFFLINE_BAND
      : 0
  const atTop = shownStatus?.place === 'top'
  const statusPill = (
    <View
      style={{
        maxWidth: SCORING_STATUS_MAX_WIDTH,
        paddingHorizontal: 12,
        paddingVertical: 4,
        borderRadius: 12,
        backgroundColor: theme.backgroundColor
      }}
    >
      <Text
        accessibilityRole="text"
        accessibilityLabel="Save status"
        testID={held == null ? 'scoringSaveStatus' : 'heldGameMessage'}
        // At the top it is one line in its band, smaller rather than taller.
        numberOfLines={atTop ? 1 : undefined}
        adjustsFontSizeToFit={topBand > 0}
        style={{
          color: theme.primaryTextColor,
          fontFamily: theme.regularTextFont,
          textAlign: 'center'
        }}
      >
        {statusLine}
      </Text>
    </View>
  )
  // Another device's change heard on the game socket and not yet read in,
  // and a count that asks the screen to look again whether it can be.
  const stale = useRef(false)
  const [staleCheck, setStaleCheck] = useState(0)
  // The digests of the plays and lineups heard since, or null when what was
  // heard must be read whatever it is (a resync, a notice with no digest).
  // When this screen's session holds every one, they were its own saves'
  // echoes, and there is nothing to read.
  const echoes = useRef<Array<{
    kind: 'plays' | 'lineups'
    digest: string
  }> | null>([])
  useEffect(() => {
    // What the screen shows of the save is read in a task of its own: the
    // count folds the whole game (`ScoringSession.picture`), which would add
    // to the stall of the tap that changed it, and the save reads the same
    // fold straight after.
    let reading: ReturnType<typeof setTimeout> | null = null
    setTagSnapshot(props.game.tagSnapshotVersion)
    setServerSwap(props.game.serverSwap)
    let rebases = props.game.rebases
    const unsubscribe = props.game.subscribe(() => {
      setTagSnapshot(props.game.tagSnapshotVersion)
      // A reload that finds only this changed draws the menu again too.
      setServerSwap(props.game.serverSwap)
      reading ??= setTimeout(() => {
        reading = null
        // The session tells of every change; the screen draws again only
        // when what it shows of the save changed.
        const next = statusOf(props.game)
        setStatus(shown => (sameStatus(shown, next) ? shown : next))
      }, 0)
      // A change heard while this screen's own save was out is read in once
      // the save has stopped.
      if (stale.current && !props.game.saving && props.game.pending === 0)
        setStaleCheck(value => value + 1)
      // A save built on lineups somebody else had saved over since took
      // theirs up, with this screen's own changes on top: the screen starts
      // again from that log, so its next change is not synced over theirs.
      if (props.game.rebases !== rebases) {
        rebases = props.game.rebases
        dispatch({
          type: 'RESET',
          session: props.game.state,
          log: [...props.game.actions]
        })
      }
      // Refused, the session went back to what the server holds, and so
      // does the screen.
      if (props.game.readOnly)
        dispatch({
          type: 'RESET',
          session: props.game.state,
          log: [...props.game.actions],
          readOnly: true
        })
    })
    return () => {
      unsubscribe()
      if (reading != null) clearTimeout(reading)
    }
  }, [props.game])
  // The screen's log is the game: the session saves whatever it says.
  useEffect(() => {
    if (
      refreshedLog.current != null &&
      sameActions(state.log, refreshedLog.current)
    ) {
      refreshedLog.current = undefined
      return
    }
    refreshedLog.current = undefined
    if (state.log !== openedLog.current) props.game.sync(state.log)
  }, [props.game, state.log])
  // Undo taps into play scored before this screen opened, one at a time,
  // each from the game the one before it left: the game steps back one
  // action, and on past any step the screen cannot rest on — a ball in play
  // still waiting for its result, or a play that closes by itself, such as
  // a hit by pitch before its close — so each tap shows one step back.
  const takingBack = useRef(-1)
  useEffect(() => {
    if (model.savedUndos === 0 || takingBack.current === model.savedUndone)
      return
    takingBack.current = model.savedUndone
    props.game.sync(state.log)
    let undone = props.game.undo()
    while (
      undone.problems.length === 0 &&
      (awaitingResult(props.game.state) || actsOnOpening(props.game.state))
    )
      undone = props.game.undo()
    dispatch({
      type: 'SAVED_UNDONE',
      ...(undone.problems.length === 0
        ? {
            undone: { session: props.game.state, log: [...props.game.actions] }
          }
        : {})
    })
  }, [props.game, model.savedUndos, model.savedUndone, state.log])
  const [sound, setSound] = useState(true)
  // Once the scorer has tapped the speaker, the stored setting read as the
  // screen opened no longer decides it.
  const soundTouched = useRef(false)
  const toggleSound = (): void => {
    const next = !sound
    soundTouched.current = true
    setSound(next)
    scoringPreferences
      .update(props.userId, stored => ({ ...stored, sound: next }))
      .catch(() => undefined)
  }
  const [dictationModel, setDictationModel] = useState<DictationModel>()
  useEffect(() => {
    let live = true
    scoringPreferences
      .read(props.userId)
      .then(value => {
        if (live) {
          if (!soundTouched.current) setSound(value.sound !== false)
          setDictationModel(value.dictationModel)
          dispatch({
            type: 'PRESENTATION',
            enabled: value.animations !== false
          })
        }
      })
      .catch(() => undefined)
    return () => {
      live = false
      scoringAudio.stop()
    }
  }, [props.userId])
  useEffect(() => {
    scoringAudio.setEnabled(sound)
  }, [sound])
  const keyboard = useRef<((key: string) => boolean) | null>(null)
  const registerKeyboard = useCallback(
    (handler: ((key: string) => boolean) | null) => {
      keyboard.current = handler
    },
    []
  )
  const [gestureActive, setGestureActive] = useState(false)
  const [outcomeMenu, setOutcomeMenu] = useState(false)
  const [moreOpen, setMoreOpen] = useState(false)
  const [baseProjection, setBaseProjection] = useState<BaseProjection>()
  const [angle, setAngle] = useState(45)
  const [landingArc, setLandingArc] = useState<BallArcState | null>(null)
  useEffect(() => {
    setLandingArc(null)
    setLandingPreview(null)
  }, [state.phase, state.generation])
  const [landingPreview, setLandingPreview] = useState<{
    x: number
    z: number
  } | null>(null)
  const [menu, setMenu] = useState(false)
  const [menuButton, setMenuButton] = useState(WEB_MENU_BUTTON)
  const insets = useInsets()
  const [sheet, setSheet] = useState<
    'exit' | 'settings' | 'overrides' | 'half' | 'rosters' | 'swap' | 'game'
  >()
  const { height: windowHeight } = useWindowDimensions()
  const [swapping, setSwapping] = useState(false)
  const [swapProblem, setSwapProblem] = useState<string>()
  /** What the open swap sheet says will be lost. */
  const [swapLoses, setSwapLoses] = useState<PlaysLost>(NOTHING_LOST)
  /** Whether the open swap sheet says the swap resets the game. */
  const [swapResets, setSwapResets] = useState(false)
  const swapMounted = useRef(true)
  useEffect(
    () => () => {
      swapMounted.current = false
    },
    []
  )
  const [defensiveSlot, setDefensiveSlot] = useState<{
    position: Position
    side: Side
  }>()
  const [rosterLoading, setRosterLoading] = useState(false)
  const [rosterProblem, setRosterProblem] = useState<string>()
  const [rosterInitial, setRosterInitial] = useState<RosterEditorDraft>()
  const [acceptedLineup, setAcceptedLineup] = useState<string>()
  const defensiveOpen = defensiveSlot != null
  const confirmation = useRef<((value: boolean) => void) | null>(null)
  const confirmationReturn = useRef<typeof sheet>(undefined)
  const currentSheet = useRef(sheet)
  currentSheet.current = sheet
  const requestConfirmation = useCallback(
    async () =>
      await new Promise<boolean>(resolve => {
        confirmation.current = resolve
        confirmationReturn.current = currentSheet.current
        setMenu(false)
        setSheet('exit')
      }),
    []
  )
  const closeSheet = (): void => {
    const returning = confirmation.current != null
    confirmation.current?.(false)
    confirmation.current = null
    setSheet(returning ? confirmationReturn.current : undefined)
  }
  useEffect(
    () => () => {
      confirmation.current?.(false)
    },
    []
  )
  useMenuEscape(
    menu && props.active,
    () => {
      setMenu(false)
    },
    'Open scoring menu'
  )
  const [hint, setHint] = useState(false)
  // Read-only takes no input at all, from the pointer, the keyboard or a
  // screen reader.
  const session = state.session
  const currentSetup = useRef(session)
  currentSetup.current = session
  const displaySession = useMemo(
    () => withRosterDetails(session, props.rosters),
    [session, props.rosters]
  )
  const missing = missingDefense(session)
  const battingCount =
    session.liveData.boxscore.teams[battingSide(session)].battingOrder.length
  const lineupKey = battingWarningKey(session)
  const lineupAccepted =
    battingCount >= 9 || (battingCount > 0 && acceptedLineup === lineupKey)
  const hasActivePlay =
    session.pending != null ||
    state.pendingPlay != null ||
    awaitingResult(session)
  const setupReady = hasActivePlay || (missing.length === 0 && lineupAccepted)
  const choosingRunnerPitch =
    props.active &&
    state.phase === 'runnerPitchType' &&
    !status.readOnly &&
    !rosterLoading &&
    setupReady
  const actionsAllowed =
    props.active &&
    bottomActionsAllowed(state) &&
    !status.readOnly &&
    !rosterLoading &&
    setupReady
  /** The team the screen opened on for this side, else the one read now. */
  const openedTeam = (side: Side, read: string): string =>
    props.openedSides == null
      ? read
      : side === 'home'
        ? props.openedSides.homeTeamId
        : props.openedSides.awayTeamId
  // Home and away swap on the server at any point in the game, the screen
  // at rest. Once the game has plays, the swap resets them.
  const swappable =
    props.persistent &&
    !status.readOnly &&
    (state.phase === 'ready' || state.phase === 'awaitingBatter') &&
    state.presentation == null &&
    state.moreDraft == null
  /**
   * The game as it stands on this screen, for what a reset would delete:
   * read only while the menu or the swap sheet asks.
   */
  const pictured = (): Parameters<typeof playsLost>[0] => {
    const picture = props.game.picture()
    return { plays: [...picture.plays.values()], currentPlay: picture.current }
  }
  /**
   * Why the menu offers no swap, if it offers none: a game withdrawn, or
   * scored outside TeamStation, by the server's word on the last read. A
   * game it called scored elsewhere only for its status, marked under way
   * with nothing TeamStation scored, is reset as any other once this screen
   * has scored it: plays here, every one TeamStation's, are what the server
   * finds once they are saved. Plays imported from outside, which the
   * session holds apart from its picture, keep the refusal.
   */
  const swapRefusal = (): string | undefined => {
    if (serverSwap === 'withdrawn') return 'game was withdrawn'
    if (serverSwap !== 'scoredElsewhere') return undefined
    if (props.game.holdsImported) return 'scored outside TeamStation'
    return swapEffect(pictured(), { status: 'scheduled', withdrawn: false }) ===
      'reset'
      ? undefined
      : 'scored outside TeamStation'
  }

  /**
   * Saves what is still on its way, then swaps: a lineup change must reach
   * the server first, or it would arrive stale behind the swap. On a phone
   * a save is answered from the outbox, so its queue for this game must
   * empty too.
   */
  const confirmSwap = async (): Promise<void> => {
    setSwapProblem(undefined)
    setSwapping(true)
    try {
      const unsaved = new Error(SWAP_UNSAVED)
      await props.game.flush().catch(() => {
        throw unsaved
      })
      // A change a rebase dropped is only a notice; what could still be
      // sent stale behind the swap is a change waiting or a refused game.
      if (props.game.readOnly)
        throw new Error(props.game.problem ?? SWAP_UNSAVED)
      if (props.game.pending > 0) throw unsaved
      if (props.client instanceof CachingClient) {
        await props.client.drainOutbox()
        const queue = await props.client.outboxSummary()
        if (
          (queue.chains[`game:${props.gameId}`] ?? 0) > 0 ||
          queue.games[props.gameId] != null
        )
          throw unsaved
      }
      // The plays as the server holds them now: a phone's own answers
      // carried digests of its own until its queue drained.
      const read = await props.client.gameEvents(props.gameId)
      const losing = playsLost(read)
      // The server's word on what the swap does; an older server's, whether
      // it loses any at-bat.
      const effect = read.swap ?? (resetsPlays(read) ? 'reset' : 'swap')
      if (effect === 'scoredElsewhere') throw new Error(SWAP_SCORED_ELSEWHERE)
      if (effect === 'withdrawn') throw new Error(WITHDRAWN_GAME)
      const resets = effect === 'reset'
      if (
        losing.atBats !== swapLoses.atBats ||
        losing.innings !== swapLoses.innings ||
        resets !== swapResets
      ) {
        if (!swapMounted.current) return
        setSwapLoses(losing)
        setSwapResets(resets)
        setSwapProblem(SWAP_CHANGED)
        return
      }
      const answer = await props.client.swapGameSides(props.gameId, {
        homeTeamId: session.gameData.teams.home.id,
        awayTeamId: session.gameData.teams.away.id,
        ...(read.generation == null ? {} : { generation: read.generation }),
        ...(read.playsDigest == null ? {} : { playsDigest: read.playsDigest })
      })
      if (!swapMounted.current) return
      setSheet(undefined)
      props.onSwapped(answer)
    } catch (error) {
      if (swapMounted.current)
        setSwapProblem(error instanceof Error ? error.message : String(error))
    } finally {
      if (swapMounted.current) setSwapping(false)
    }
  }
  const tiebreaker = useTiebreakerSetup(
    state,
    actionsAllowed &&
      !menu &&
      sheet == null &&
      !defensiveOpen &&
      !outcomeMenu &&
      !historyActive &&
      tagTarget == null,
    dispatch
  )
  // A sheet, the defensive roster, the tag history and its editor, the More
  // menu, the outcome picker, the dictation question, the tiebreaker's
  // setup and runner sheets, and the runner-reason and error-credit sheets
  // are each a Modal on iOS, which presents one at a time.
  const overlaid =
    sheet != null ||
    defensiveOpen ||
    historyActive ||
    tagTarget != null ||
    moreOpen ||
    outcomeMenu ||
    tiebreaker.mode === 'settings' ||
    typeof tiebreaker.mode === 'number' ||
    state.dictationQuestion != null ||
    state.phase === 'runnerReason' ||
    state.phase === 'runnerPitch' ||
    state.phase === 'runnerErrorReuse' ||
    state.phase === 'errorCredit'
  const { onOverlay } = props
  useEffect(() => {
    onOverlay?.(overlaid)
  }, [onOverlay, overlaid])
  const pauseClock = useScoringClock(
    state,
    !props.active ||
      menu ||
      historyActive ||
      tagTarget != null ||
      sheet != null ||
      defensiveOpen ||
      outcomeMenu ||
      moreOpen ||
      tiebreaker.active ||
      gestureActive ||
      state.presentation != null ||
      props.walkUpOpen === true,
    dispatch
  )
  const setGesture = useCallback(
    (active: boolean) => {
      if (active) pauseClock()
      setGestureActive(active)
      dispatch({ type: 'GESTURE', active })
    },
    [pauseClock]
  )
  const canEditDefense =
    props.active &&
    setupEditable(state) &&
    !status.readOnly &&
    !menu &&
    sheet == null &&
    !defensiveOpen &&
    !rosterLoading &&
    !outcomeMenu &&
    !moreOpen &&
    !tiebreaker.active
  const { client } = props
  const health = useCallback(async () => await client.health(), [client])
  const socketUrl = useMemo(() => dictationUrl(client.baseUrl), [client])
  // A development game has no server to dictate to.
  const noDictation = useCallback(
    async () => ({
      status: 'ok' as const,
      version: '',
      database: 'ok' as const,
      migrations: 0,
      dictation: false,
      dictationModels: []
    }),
    []
  )
  // The last play in two lines, however many entries it took to tap.
  const lastEntry = state.past.at(-1)
  const { game } = props
  const { log, past, checkpoints } = state
  const lastPlay = useMemo(
    () =>
      describeLastPlay(log, past, session, logLength =>
        sessionAt({ log, checkpoints }, logLength, () => game.opening)
      ),
    [game, log, past, session, checkpoints]
  )
  const historyVisible = historyActive || tagTarget != null
  const tagHistory = useMemo(() => {
    if (!historyVisible) return { rows: [], detail: undefined }
    const rows = game.historyTargetsFor(session).slice(-6)
    const previous = sessionAt(
      { log, checkpoints },
      lastEntry?.logLength ?? Math.max(0, log.length - 1),
      () => game.opening
    )
    // Setup edits may change Gumbo context without creating an event.
    const latestIsTarget =
      rows.at(-1)?.id !== game.historyTargetsFor(previous).at(-1)?.id ||
      (log
        .slice(lastEntry?.logLength ?? Math.max(0, log.length - 1))
        .some(
          action => action.type !== 'lineup' && action.type !== 'gameFlow'
        ) &&
        JSON.stringify(previous.liveData.plays.currentPlay) !==
          JSON.stringify(session.liveData.plays.currentPlay))
    const targetDetail = latestIsTarget ? lastPlay : undefined
    const descriptions = describeCompletedPlays(
      log,
      new Set(
        rows
          .filter(target => target.completed === true)
          .map(target => target.atBatIndex)
      ),
      length => sessionAt({ log, checkpoints }, length, () => game.opening)
    )
    const describedRows = rows.map((target, index) => {
      const described =
        target.completed === true
          ? (descriptions.get(target.atBatIndex) ??
            (index === rows.length - 1 ? targetDetail : undefined))
          : index === rows.length - 1
            ? targetDetail
            : undefined
      return described == null
        ? target
        : {
            ...target,
            display: described,
            description: [described.primary, described.secondary]
              .filter(line => line != null && line !== '')
              .join(' ')
          }
    })
    return { rows: describedRows, detail: targetDetail }
    // Session tags mutate independently of the screen's scoring state.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    historyVisible,
    tagSnapshot,
    game,
    session,
    log,
    lastEntry,
    lastPlay,
    checkpoints
  ])
  useEffect(() => {
    setTagTarget(current => {
      if (current == null) return current
      const raw = game.eventTargets.find(target => target.id === current.id)
      const projected =
        tagHistory.rows.find(row => row.id === current.id) ??
        (current.completed === true && raw != null
          ? tagHistory.rows.find(
              row =>
                row.completed === true && row.atBatIndex === current.atBatIndex
            )
          : undefined)
      const next =
        projected ?? (raw == null ? undefined : { ...current, tag: raw.tag })
      if (
        next == null ||
        (current.id === next.id &&
          current.tag === next.tag &&
          current.atBatIndex === next.atBatIndex &&
          current.eventIndex === next.eventIndex &&
          current.completed === next.completed &&
          current.title === next.title &&
          current.description === next.description)
      )
        return current
      return next
    })
  }, [game, tagHistory.rows])
  // The last sentence's plays — each batter's, when it scored more than
  // one — once per sentence, for the dictation log.
  const played = useMemo(
    () =>
      state.dictation != null &&
      state.dictation.problem == null &&
      lastEntry?.label === state.dictation.transcript
        ? {
            id: entryId(lastEntry),
            lines: describeEntryPlays(log, past, logLength =>
              sessionAt({ log, checkpoints }, logLength, () => game.opening)
            ).flatMap(play => [
              play.primary,
              ...(play.secondary == null ? [] : [play.secondary])
            ])
          }
        : undefined,
    [state.dictation, lastEntry, log, past, checkpoints, game]
  )
  // What the last sentence left out, once per sentence, beside its plays.
  const leftOut = useMemo(
    () =>
      state.dictation?.note != null &&
      lastEntry?.label === state.dictation.transcript
        ? { id: entryId(lastEntry), text: state.dictation.note }
        : undefined,
    [state.dictation, lastEntry]
  )
  // A dictated undo: the step back the Undo button takes, but at once, so the
  // rest of the sentence is applied after it. What it took back — the
  // actions, and the game they were applied to — or null for nothing.
  const undoLast = (): {
    removed: ScoringAction[]
    before: GameState
    label?: string
  } | null => {
    scoringAudio.stop()
    if (status.readOnly) return null
    const entry = state.past.at(-1)
    if (entry != null || state.log.length === 0) {
      dispatch({ type: 'UNDO' })
      return entry == null
        ? null
        : {
            removed: state.log.slice(entry.logLength),
            before: sessionAt(state, entry.logLength, () => game.opening),
            label: entry.label
          }
    }
    // Scored before this screen opened: the game steps back one action, and
    // on past any step the screen cannot rest on, as an Undo tap does.
    props.game.sync(state.log)
    let undone = props.game.undo()
    while (
      undone.problems.length === 0 &&
      (awaitingResult(props.game.state) || actsOnOpening(props.game.state))
    )
      undone = props.game.undo()
    if (undone.problems.length > 0) return null
    dispatch({
      type: 'RESET',
      session: props.game.state,
      log: [...props.game.actions]
    })
    return {
      removed: state.log.slice(props.game.actions.length),
      before: props.game.state
    }
  }
  // The log's line for a dictated undo, from what it took back.
  const undoneLine = (
    taken: {
      removed: ScoringAction[]
      before: GameState
      label?: string
    } | null
  ): string => {
    if (taken == null) return 'Nothing to undo'
    const closing = (action: ScoringAction): boolean =>
      action.type === 'gameFlow' && action.kind === 'closePlay'
    const shown = taken.removed.filter(action => !closing(action))
    if (shown.length === 0 && taken.removed.length > 0)
      return 'Reopened the last play'
    // A tapped step that changed no play of its own ("Fielded by …") is
    // named as the Undo entry names it.
    const described =
      shown.length === 0
        ? undefined
        : describePlay(taken.before, shown, state.session)?.primary
    return `Undid ${
      described != null && described !== 'Play changed'
        ? described
        : (taken.label ?? 'the last step')
    }`
  }
  // The log's line for a dictated undo; `id` changes per undo.
  const [undone, setUndone] = useState<{ id: number; line: string }>()
  // The log's line for a dictated substitution not taken; `id` changes per
  // refusal.
  const [refused, setRefused] = useState<{ id: number; message: string }>()
  const refuse = (message: string): void => {
    setRefused(last => ({ id: (last?.id ?? 0) + 1, message }))
  }
  // While the roster sheet is open, its own dictation has the microphone
  // and the Space key.
  const dictation = useDictationControls({
    suspended: !props.active || sheet === 'rosters',
    health: props.persistent ? health : noDictation,
    url: socketUrl,
    token: props.client.token,
    gameId: props.gameId,
    model: dictationModel,
    session,
    log: state.log,
    problem: state.dictation?.problem,
    note: leftOut,
    question: props.walkUpOpen === true ? undefined : state.dictationQuestion,
    played,
    onAnswer: answer => {
      if (
        !props.active ||
        tiebreaker.active ||
        rosterLoading ||
        (!lineupAccepted && !hasActivePlay)
      )
        return
      dispatch({
        type: 'DICTATION_ANSWER',
        ...answer,
        acceptedLineup: acceptedLineup ?? null
      })
    },
    onDismissQuestion: () => {
      dispatch({ type: 'DICTATION_DISMISS' })
    },
    // While a play is drawn or a player dragged, Space is the field's.
    spaceTalks:
      props.active &&
      sheet !== 'rosters' &&
      (atRest(state) || state.reel != null) &&
      !gestureActive &&
      !tiebreaker.active &&
      !rosterLoading &&
      (lineupAccepted || hasActivePlay),
    undone,
    refused,
    onActions: (transcript, actions, roster, undo) => {
      if (!props.active || rosterLoading || tiebreaker.active) return
      if (undo === true) {
        // Undone now, before the rest of the sentence is applied. With a
        // question open, what is taken back is the unanswered sentence.
        const line =
          state.dictationQuestion != null
            ? 'Dropped the question'
            : undoneLine(undoLast())
        if (state.dictationQuestion != null)
          dispatch({ type: 'DICTATION_DISMISS' })
        setUndone(last => ({ id: (last?.id ?? 0) + 1, line }))
      }
      // A substitution opens the roster sheet with it staged, whether or
      // not the lineup has been accepted; with a play, neither is taken.
      // A read-only screen changes no roster.
      const substitution = rosterReply(
        state.session,
        transcript,
        actions,
        roster,
        atRest(state)
      )
      if (substitution != null) {
        if ('problem' in substitution) refuse(substitution.problem)
        else if (!status.readOnly)
          openRosters({ dictated: substitution.dictated })
        return
      }
      if (
        actions.length > 0 &&
        !rosterLoading &&
        (lineupAccepted || hasActivePlay)
      )
        dispatch({
          type: 'DICTATED',
          transcript,
          actions,
          acceptedLineup: acceptedLineup ?? null
        })
    }
  })
  const line = session.liveData.linescore
  const shownNames = shortPlayerNames(
    Object.values(displaySession.gameData.players)
  )
  const scoredHere = useRef(state.past.length)
  scoredHere.current = state.past.length
  // The walk-up song stops the moment the scorer leaves, not once the save
  // the exit waits on has finished.
  const stopWalkUp = useRef<() => void>(() => undefined)
  // Leaving first saves what the server has not acknowledged, and asks only
  // about changes that still did not reach it. A server that does not answer
  // holds the scorer back three seconds at most.
  const leaving = useRef<Promise<boolean> | null>(null)
  const leave = useCallback(async (): Promise<boolean> => {
    if (leaving.current != null) return await leaving.current
    const decision = (async (): Promise<boolean> => {
      stopWalkUp.current()
      if (props.persistent) {
        await Promise.race([
          props.game.flush().catch(() => undefined),
          new Promise<void>(resolve => {
            setTimeout(() => {
              resolve()
            }, 3000)
          })
        ])
        if (props.game.pending === 0) return true
      } else if (scoredHere.current === 0) return true
      return await requestConfirmation()
    })()
    leaving.current = decision
    try {
      return await decision
    } finally {
      if (leaving.current === decision) leaving.current = null
    }
  }, [props.game, props.persistent, requestConfirmation])
  const exit = useScoringExit(
    session.gamePk,
    props.persistent ? status.pending > 0 : state.past.length > 0,
    props.onExit,
    leave,
    true,
    props.allowNavigation,
    props.onNavigationApproved
  )
  const { onBeforeLeave } = props
  useEffect(() => onBeforeLeave?.(leave), [onBeforeLeave, leave])
  // The rosters are read from the server on the way in, so another scorer's
  // saved change is what the scorer edits; saving them posts at once. The
  // last one saved wins.
  const [rosterRead, setRosterRead] = useState(0)
  const shownLog = useRef(state.log)
  const resumedAppearance = useRef(
    awaitingResult(props.game.state)
      ? props.game.state.liveData.plays.currentPlay?.about.atBatIndex
      : undefined
  )
  // A peer can replace a play without changing its appearance index. Bind
  // safe resumption to the original record and its starting player context.
  const resumeIdentity = (game: GameState): string =>
    JSON.stringify({
      players: game.gameData.players,
      teams: game.liveData.boxscore.teams,
      plays: game.liveData.plays
    })
  const [originalResume] = useState(() => resumeIdentity(props.game.state))
  shownLog.current = state.log
  /**
   * Reads the game the server holds again and, when somebody else's plays
   * changed it, starts the screen again from it. The screen's own save read
   * back leaves it, and its Undo, alone. Gives the game as read, and whether
   * it is the play this screen opened on, still waiting for its result.
   */
  const followServer = async (): Promise<{
    session: GameState
    oldUnresolved: boolean
  }> => {
    const changed = await props.game.reload()
    const oldUnresolved =
      awaitingResult(props.game.state) &&
      props.game.state.liveData.plays.currentPlay?.about.atBatIndex ===
        resumedAppearance.current &&
      resumeIdentity(props.game.state) === originalResume
    const resumed = oldUnresolved
      ? props.game.resumable()
      : { state: props.game.state, actions: [...props.game.actions] }
    // Opening may close a decided play automatically. Refresh must use the
    // same current half, while retaining that close in the next saved log.
    const refreshed = withVisibleLineups(
      resumedScoringState(
        resumed.state,
        resumed.actions,
        state.presentationEnabled
      ),
      props.visibleDefaults
    )
    // The server's copy can read back differently with the same plays
    // (its players in another order). Then the screen is the game
    // already, and keeps its Undo history; only another scorer's plays
    // start it again from the server's.
    if (changed && !sameActions(shownLog.current, props.game.actions)) {
      if (oldUnresolved) refreshedLog.current = refreshed.log
      dispatch({
        type: 'RESET',
        session: refreshed.session,
        log: refreshed.log
      })
    }
    return { session: refreshed.session, oldUnresolved }
  }
  const refreshSetup = async (): Promise<GameState | null> => {
    setRosterLoading(true)
    setRosterProblem(undefined)
    try {
      if (!props.persistent) return currentSetup.current
      const { session: fresh, oldUnresolved } = await followServer()
      if (
        props.game.readOnly ||
        fresh.pending != null ||
        (awaitingResult(props.game.state) && !oldUnresolved)
      ) {
        setSheet(undefined)
        setDefensiveSlot(undefined)
        return null
      }
      return fresh
    } catch {
      setRosterProblem('Unable to refresh the game. Please try again.')
      return null
    } finally {
      setRosterLoading(false)
    }
  }
  // Another device's plays and lineups, heard on the game socket, are read
  // in once the screen is at rest: on a step where nothing is being entered,
  // with no sheet open but the rosters. A save of this screen's own still
  // out comes first, and the change is read in once it has stopped.
  const { socket, persistent, gameId } = props
  // The session as it stands when a notice arrives.
  const noticed = useRef(props.game)
  noticed.current = props.game
  /** The status a game called scored elsewhere was last read again for. */
  const unmarked = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (socket == null || !persistent) return
    return listen(socket, gameId, event => {
      if (
        event.type === 'change' &&
        (event.kind === 'plays' || event.kind === 'lineups')
      ) {
        // An older server sends no digest.
        const digest: unknown = (event.data as { digest?: unknown }).digest
        if (typeof digest === 'string')
          echoes.current?.push({ kind: event.kind, digest })
        else echoes.current = null
      } else if (event.type === 'resync') echoes.current = null
      else if (event.type === 'change' && event.kind === 'game') {
        // A withdrawal, or a game marked under way or final elsewhere, is
        // told only here: the game is read again when the notice says other
        // than the last read did of what a swap does.
        const { status, withdrawn } = event.data
        const known = noticed.current.serverSwap
        const begun = status === 'inProgress' || status === 'final'
        if (
          known == null ||
          !(
            (withdrawn != null && withdrawn !== (known === 'withdrawn')) ||
            (known === 'swap' && begun) ||
            // Called scored elsewhere for its status alone, now unmarked:
            // read once for that status, not on every save's notice.
            (known === 'scoredElsewhere' &&
              !begun &&
              !noticed.current.holdsImported &&
              unmarked.current !== status)
          )
        )
          return
        if (known === 'scoredElsewhere') unmarked.current = status
        echoes.current = null
      } else return
      stale.current = true
      setStaleCheck(value => value + 1)
    })
  }, [socket, persistent, gameId])
  const settled =
    (state.phase === 'ready' || state.phase === 'awaitingBatter') &&
    atRest(state) &&
    (sheet == null || sheet === 'rosters') &&
    !rosterLoading &&
    !defensiveOpen &&
    !gestureActive &&
    !outcomeMenu &&
    !moreOpen &&
    !historyActive &&
    tagTarget == null &&
    !tiebreaker.active &&
    state.dictationQuestion == null
  const following = useRef(false)
  const followStale = useRef<() => void>(() => undefined)
  followStale.current = () => {
    if (!stale.current || following.current || !settled) return
    if (props.game.readOnly) {
      stale.current = false
      return
    }
    if (props.game.saving || props.game.pending > 0) return
    stale.current = false
    const heard = echoes.current
    echoes.current = []
    // Only this screen's own saves were heard: the game is read already.
    if (
      heard?.every(each =>
        each.kind === 'plays'
          ? props.game.holdsPlays(each.digest)
          : props.game.holdsLineups(each.digest)
      ) === true
    )
      return
    following.current = true
    let failed = false
    const again = (): void => {
      stale.current = true
      echoes.current = null
    }
    followServer()
      .catch(() => {
        // Tried again on the next change heard or step taken.
        again()
        failed = true
      })
      .finally(() => {
        following.current = false
        // Declined: a save started while the game was being read.
        if (props.game.saving || props.game.pending > 0) again()
        if (stale.current && !failed) setStaleCheck(value => value + 1)
      })
  }
  useEffect(() => {
    followStale.current()
  }, [staleCheck, settled])
  // The microphone goes to the roster sheet on as it was here, and comes
  // back on when the sheet closes, however it closes.
  const rosterMicOn = useDictationHandover(sheet === 'rosters', dictation)
  // While the roster sheet is open, another device's saved lineups read in
  // again over a clean draft, and raise a warning over a dirty one.
  const [rosterChanged, setRosterChanged] = useState(false)
  const rosterLive = useRosterLive({
    socket: persistent ? socket : undefined,
    gameId,
    dirty: rosterChanged,
    read: async () => {
      // This screen's own save, still out, would read as another device's,
      // so it lands first. An idle session is not flushed: a flush, even of
      // nothing, makes the read of the game the sheet opens over decline.
      if (props.game.saving || props.game.pending > 0)
        await props.game.flush().catch(() => undefined)
      return (await props.client.gameLineups(gameId)).digest
    },
    onReload: () => {
      if (currentSheet.current !== 'rosters') return
      followServer()
        .then(({ session: fresh }) => {
          if (currentSheet.current !== 'rosters') return
          setRosterInitial(held => ({
            draft: fresh,
            side: held?.side ?? battingSide(fresh),
            mode: held?.mode ?? 'lineup',
            ...(held?.scrollOffsets == null
              ? {}
              : { scrollOffsets: held.scrollOffsets }),
            base: fresh
          }))
          setRosterRead(value => value + 1)
        })
        .catch(() => undefined)
    }
  })
  const { stop: stopRosterLive } = rosterLive
  useEffect(() => {
    if (sheet === 'rosters') return
    stopRosterLive()
    setRosterChanged(false)
  }, [sheet, stopRosterLive])
  const openRosters = (
    lineup: boolean | { dictated: DictatedRoster } = false
  ): void => {
    props.onRefreshDetails()
    // Before the game is read, so a change saved meanwhile is heard.
    rosterLive.start()
    if (typeof lineup === 'object') {
      // Opened only once the change is staged on the refreshed game.
      openDictatedRosters(lineup.dictated, refreshSetup, {
        open: initial => {
          setRosterInitial(initial)
          setRosterRead(value => value + 1)
          setSheet('rosters')
        },
        refuse
      }).catch(() => undefined)
      return
    }
    setRosterInitial(undefined)
    setSheet('rosters')
    refreshSetup()
      .then(fresh => {
        if (fresh == null) return
        setRosterInitial(
          lineup
            ? {
                draft: fresh,
                side: battingSide(fresh),
                mode: 'lineup',
                base: fresh
              }
            : undefined
        )
        setRosterRead(value => value + 1)
      })
      .catch(() => {
        setRosterProblem('Unable to refresh the game. Please try again.')
      })
  }
  const editableSetup = (fresh: GameState): boolean =>
    setupEditable(resumedScoringState(fresh, [], state.presentationEnabled))
  const creatingDefender = useRef(false)
  const defensiveCreation = useRef(0)
  const defensiveSlotRef = useRef(defensiveSlot)
  defensiveSlotRef.current = defensiveSlot
  const cancelDefensiveCreation = (): void => {
    defensiveCreation.current++
    creatingDefender.current = false
  }
  useEffect(
    () => () => {
      defensiveCreation.current++
    },
    []
  )
  const chooseDefender = (id: number): void => {
    const slot = defensiveSlot
    if (slot == null || rosterLoading) return
    cancelDefensiveCreation()
    refreshSetup()
      .then(fresh => {
        if (fresh == null) return
        if (
          fieldingSide(fresh) === slot.side &&
          editableSetup(fresh) &&
          fresh.liveData.boxscore.teams[slot.side].players.includes(id)
        ) {
          if (
            fresh.liveData.boxscore.teams[slot.side].defense[slot.position] !==
            id
          )
            dispatch({
              type: 'ROSTER',
              draft: assignDefender(fresh, slot.position, id)
            })
        }
        setDefensiveSlot(undefined)
      })
      .catch(() => {
        setRosterProblem('Unable to refresh the game. Please try again.')
      })
  }
  const createDefensivePlayers = async (
    prepare: (
      fresh: GameState,
      side: Side
    ) => ((draft: GameState) => void) | Promise<(draft: GameState) => void>
  ): Promise<void> => {
    const slot = defensiveSlot
    if (slot == null || creatingDefender.current || rosterLoading)
      throw new Error('The game is refreshing.')
    creatingDefender.current = true
    const attempt = ++defensiveCreation.current
    try {
      const fresh = await refreshSetup()
      if (fresh == null) throw new Error('Unable to refresh the game.')
      if (fieldingSide(fresh) !== slot.side || !editableSetup(fresh)) {
        setDefensiveSlot(undefined)
        throw new Error('The current defense has changed.')
      }
      if (
        attempt !== defensiveCreation.current ||
        defensiveSlotRef.current !== slot
      )
        return
      const add = await prepare(fresh, slot.side)
      if (
        attempt !== defensiveCreation.current ||
        defensiveSlotRef.current !== slot
      )
        return
      const current = await refreshSetup()
      if (
        attempt !== defensiveCreation.current ||
        defensiveSlotRef.current !== slot
      )
        return
      if (
        current == null ||
        fieldingSide(current) !== slot.side ||
        !editableSetup(current)
      )
        throw new Error('The current defense has changed.')
      const draft = copyState(current)
      add(draft)
      currentSetup.current = draft
      dispatch({ type: 'ROSTER', draft })
    } finally {
      if (attempt === defensiveCreation.current)
        creatingDefender.current = false
    }
  }
  const createDefensivePlayer = async (player: PlayerDraft): Promise<void> => {
    await createDefensivePlayers(async (draft, side) => {
      const entry = await props.client.createRosterPlayer(
        draft.gameData.teams[side].id,
        rosterPlayerBody(player)
      )
      return current => {
        addRosteredPlayer(current, side, entry, player)
      }
    })
  }
  const createDefensivePlaceholders = async (count: number): Promise<void> => {
    await createDefensivePlayers(async (fresh, side) => {
      const staged = copyState(fresh)
      await addPlaceholderPlayers(
        staged,
        side,
        count,
        async (side, player) =>
          await props.client.createGuestPlayer(
            fresh.gamePk,
            side,
            rosterPlayerBody(player),
            openedTeam(side, fresh.gameData.teams[side].id)
          )
      )
      return draft => {
        for (const id of staged.liveData.boxscore.teams[side].players) {
          if (draft.gameData.players[id] != null) continue
          draft.gameData.players[id] = staged.gameData.players[id]
          draft.liveData.boxscore.teams[side].players.push(id)
          if (!draft.meta.tagOrder.includes(id)) draft.meta.tagOrder.push(id)
        }
      }
    })
  }
  const refreshDefensiveRoster = (): void => {
    const slot = defensiveSlot
    if (slot == null || rosterLoading) return
    refreshSetup()
      .then(fresh => {
        if (
          fresh != null &&
          (fieldingSide(fresh) !== slot.side || !editableSetup(fresh))
        )
          setDefensiveSlot(undefined)
      })
      .catch(() => {
        setRosterProblem('Unable to refresh the game. Please try again.')
      })
  }
  const priorRunner = usePriorRunnerCorrection(
    props.game,
    state,
    props.active && !status.readOnly,
    `${props.gameId}:${props.userId}`,
    dispatch
  )
  const { phase, pendingPlay, motions, runnerAction, presentation } = state
  const previousPlayers = useRef<FieldPlayer[]>([])
  const players = useMemo(() => {
    const next = scoringFieldPlayers(
      {
        session,
        phase,
        pendingPlay,
        motions,
        runnerAction,
        presentation
      },
      previousPlayers.current
    )
    const labels = shortPlayerNames(
      Object.values(displaySession.gameData.players)
    )
    const named = priorRunnerPlayers(next, priorRunner.candidates, session).map(
      player => {
        const person = displaySession.gameData.players[player.playerId ?? 0]
        if (person == null) return player
        const label = labels.get(person.id) ?? ''
        return {
          ...player,
          name: label,
          displayName: label,
          jersey: person.jersey
        }
      }
    )
    const complete = [...named, ...emptyDefensePlayers(session)]
    previousPlayers.current = complete
    return complete
  }, [
    session,
    displaySession,
    priorRunner.candidates,
    phase,
    pendingPlay,
    motions,
    runnerAction,
    presentation
  ])
  useEffect(() => {
    setAngle(startingAngle(state))
    // startingAngle reads only these.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    state.pendingPlay?.angle,
    state.pendingPlay?.outcome,
    state.pendingPlay?.homeRunKind,
    state.generation
  ])
  // A runner drag's Safe/Out view changes every frame the finger moves. It
  // goes to the drop targets alone, not through this whole screen.
  const [runnerDrag] = useState(() => createRelay<RunnerDragView | null>(null))
  const [selected, setSelected] = useState('')
  const switchable = state.phase === 'ready' && canSwitchBatter(session)
  const note = useWalkUpNote(state, props.rosters, props.music, {
    resolve: props.resolveSong,
    fadeAppleMusic: props.fadeAppleMusic
  })
  stopWalkUp.current = note.stop
  const { stop: stopNote } = note
  useEffect(() => {
    if (!props.active) stopNote()
  }, [props.active, stopNote])
  const batterId = line.offense.batter?.id
  const shownAppearances = useRef(new Set<string>())
  const appearance = session.liveData.plays.currentPlay?.about.atBatIndex
  useEffect(() => {
    let live = true
    setHint(false)
    const helpKey = `${props.userId}:${appearance}:${batterId}`
    if (
      !switchable ||
      session.gameData.players[batterId ?? 0]?.bats !== 'switch' ||
      shownAppearances.current.has(helpKey)
    )
      return
    scoringPreferences
      .update(props.userId, preferences => {
        if (!live || !preferences.help || preferences.shown >= 3) return null
        shownAppearances.current.add(helpKey)
        setHint(true)
        return { ...preferences, shown: preferences.shown + 1 }
      })
      .catch(() => undefined)
    return () => {
      live = false
    }
    // A box change does not present the same appearance's help again.
  }, [props.userId, batterId, appearance, switchable, session.gameData.players])
  const unresolvedRunner = [...(session.pending?.movements ?? [])]
    .filter(move => move.decision === 'pending' && move.to < 4)
    .sort((a, b) => b.from - a.from)[0]
  const runnerEnabled =
    state.runnerAction?.purpose !== 'droppedThirdStrike' &&
    ['ready', 'correctionWindow', 'resolveBatter', 'runnerDecision'].includes(
      state.phase
    ) &&
    !state.motions.some(motion => !motion.complete)
  // While the throw is going round to retire the batter, a runner forced to
  // the next base can be put out there first.
  const relayForce =
    state.phase === 'chooseDefender' &&
    state.runnerAction?.purpose === 'batterRetirement' &&
    state.presentation == null &&
    !status.readOnly
  const hitOfferRetreatIds = players
    .filter(player => {
      if (player.team !== 'runner' || player.playerId == null) return false
      if (session.homeQueue.includes(player.playerId)) return false
      const from = baseIds(session).indexOf(player.playerId) + 1
      const to = from - 1
      if (!undoesHitOffer(session, player.playerId, from, to)) return false
      // Same occupancy gate as apply: do not offer retreat onto a taken base.
      return (
        baseOccupiedError(session, {
          playerId: player.playerId,
          from,
          to
        }) == null
      )
    })
    .map(player => player.id)
  // While home waits, the unforced trailer may retreat or re-take the offer —
  // not drag past the offered base toward home (that would no-op).
  const hitOfferAdvanceIds = players
    .filter(player => {
      if (player.team !== 'runner' || player.playerId == null) return false
      if (session.homeQueue.includes(player.playerId)) return false
      const from = baseIds(session).indexOf(player.playerId) + 1
      return completesHitOffer(session, player.playerId, from, from + 1)
    })
    .map(player => player.id)
  const hitOfferHomeIds = [
    ...new Set([...hitOfferRetreatIds, ...hitOfferAdvanceIds])
  ]
  const homeWaiting =
    state.phase === 'homeDecision' &&
    !state.motions.some(motion => !motion.complete)
  const runnerIds =
    !setupReady || rosterLoading
      ? []
      : relayForce
        ? players
            .filter(
              player =>
                player.team === 'runner' &&
                player.batting !== true &&
                player.playerId != null &&
                forcedFrom(
                  session,
                  baseIds(session).indexOf(player.playerId) + 1
                )
            )
            .map(player => player.id)
        : homeWaiting
          ? hitOfferHomeIds
          : runnerEnabled
            ? players
                .filter(
                  player =>
                    player.team === 'runner' &&
                    (state.phase === 'resolveBatter' ||
                    state.runnerAction?.returnPhase === 'resolveBatter'
                      ? player.playerId === unresolvedRunner?.playerId
                      : player.batting !== true)
                )
                .map(player => player.id)
            : []
  const retreatIds =
    state.phase === 'correctionWindow' || state.phase === 'homeDecision'
      ? hitOfferRetreatIds
      : priorRunner.candidates.map(item => `offense-${item.runner}`)
  const advanceIds = homeWaiting
    ? hitOfferAdvanceIds
    : priorRunner.candidates.some(item => item.from === 4)
      ? runnerIds.filter(
          id =>
            !priorRunner.candidates.some(
              item => item.from === 4 && id === `offense-${item.runner}`
            )
        )
      : undefined
  const instruction =
    state.presentation != null
      ? undefined
      : (fieldStageInstruction(state) ??
        (state.phase === 'resolveBatter'
          ? unresolvedRunner?.from === 0
            ? 'Drag batter to a base, or hold to mark Out'
            : `Resolve ${session.gameData.players[unresolvedRunner?.playerId ?? 0]?.fullName ?? 'runner'}: drag to a base, or hold to mark Out`
          : undefined))
  const celebrationPaused =
    !props.active ||
    menu ||
    sheet != null ||
    defensiveOpen ||
    outcomeMenu ||
    moreOpen ||
    tiebreaker.active
  useHomeRunCelebration(state.celebration, celebrationPaused, dispatch)
  const fieldScoreboard = {
    // The roster's current numbers, as the fielders' uniforms show them.
    ...scoreboardFor(displaySession),
    celebration:
      state.celebration == null
        ? undefined
        : { ...state.celebration, paused: celebrationPaused }
  }
  const summary =
    instruction == null
      ? state.phase === 'awaitingBatter'
        ? 'Next batter is on base. Update lineup to continue.'
        : `${session.gameData.teams.away.name} ${line.teams.away.runs} · ${session.gameData.teams.home.name} ${line.teams.home.runs} · ${line.inningState} ${line.currentInningOrdinal} · ${line.balls} balls ${line.strikes} strikes ${line.outs} outs · Pitches ${scoreboardFor(session).pitchCount}`
      : `${instruction}${state.phase === 'trajectory' ? ` ${angle}° ${trajectoryLabel(angle)}` : ''}`
  const dispatchRunner = (event: ScoringEvent): void => {
    if (event.type === 'DEFENDER') {
      const runner = players.find(
        player =>
          player.playerId === state.runnerAction?.playerId &&
          player.team === 'runner'
      )
      dispatch({
        ...event,
        runnerPoint: runner == null ? undefined : { ...runner.position }
      })
    } else dispatch(event)
  }
  const setupWarning =
    !status.readOnly &&
    setupEditable(state) &&
    !menu &&
    sheet == null &&
    !defensiveOpen &&
    !rosterLoading &&
    !outcomeMenu &&
    !moreOpen &&
    !tiebreaker.active
  const openLineup = (): void => {
    openRosters(true)
  }
  const setupInstruction = setupWarning
    ? missing.length > 0
      ? `Missing defensive positions\n${missing.join(', ')}`
      : !lineupAccepted
        ? 'Insufficient batting lineup.'
        : undefined
    : undefined
  const defensiveIds = canEditDefense
    ? players
        .filter(player => player.team === 'defense')
        .map(player => player.id)
    : []
  const fieldPlayers =
    tiebreaker.mode === 'bases' || typeof tiebreaker.mode === 'number'
      ? players.filter(player => player.team !== 'defense')
      : players
  return (
    <BaseballScreen
      suspended={!props.active}
      topBand={topBand}
      setupToast={
        setupInstruction === 'Insufficient batting lineup.'
          ? {
              message: lineupCountMessage(battingCount),
              onSetLineup: openLineup,
              onAcceptLineup:
                battingCount > 0
                  ? () => {
                      setAcceptedLineup(lineupKey)
                    }
                  : undefined
            }
          : undefined
      }
      field={{
        teams: session.gameData.teams,
        players: fieldPlayers,
        tapIds: defensiveIds,
        onPlayerTap: id => {
          if (!canEditDefense) return
          const player = players.find(item => item.id === id)
          if (player == null || !POSITIONS.includes(player.label as Position))
            return
          setDefensiveSlot({
            position: player.label as Position,
            side: fieldingSide(session)
          })
          const side = fieldingSide(session)
          refreshSetup()
            .then(fresh => {
              if (
                fresh != null &&
                (fieldingSide(fresh) !== side || !editableSetup(fresh))
              )
                setDefensiveSlot(undefined)
            })
            .catch(() => {
              setRosterProblem('Unable to refresh the game. Please try again.')
            })
        },
        onBaseProjection: setBaseProjection,
        ...battedBallField(
          state,
          angle,
          landingArc,
          menu ||
            sheet != null ||
            defensiveOpen ||
            outcomeMenu ||
            moreOpen ||
            tiebreaker.active,
          {
            dispatch,
            landing: arc => {
              setLandingArc(arc)
              setLandingPreview(arc.target)
            },
            angle: setAngle
          }
        ),
        onLandingPreview: setLandingPreview,
        presentation: state.presentation,
        presentationPaused:
          menu ||
          sheet != null ||
          outcomeMenu ||
          moreOpen ||
          tiebreaker.active ||
          props.walkUpOpen === true,
        onPresentationContact: (id, generation) => {
          dispatch({ type: 'PRESENTATION_CONTACT', id, generation })
        },
        onPresentationDone: (id, generation, stage) => {
          dispatch({ type: 'PRESENTATION_DONE', id, generation, stage })
        },
        onGestureActive: setGesture,
        onRunnerDrag: runnerDrag.set,
        runnerSafeError: (id, to) => {
          const player = players.find(item => item.id === id)
          if (player?.playerId == null) return 'Runner unavailable'
          if (
            priorRunner.candidates.some(
              candidate =>
                candidate.runner === player.playerId && candidate.to === to
            )
          )
            return undefined
          return runnerDecisionError({
            ...state,
            runnerAction: {
              playerId: player.playerId,
              from: baseIds(session).indexOf(player.playerId) + 1,
              to,
              origin: state.pendingPlay == null ? 'between' : 'current',
              returnPhase: state.phase
            }
          })
        },
        onRunnerDrop: (id, to, decision, generation) => {
          if (tiebreaker.active || generation !== state.generation) return
          const player = players.find(item => item.id === id)
          if (player?.playerId == null) return
          if (priorRunner.drop(player.playerId, to)) return
          dispatch({
            type: 'RUNNER_DROP',
            id: player.playerId,
            to,
            decision,
            generation
          })
        },
        onMovementComplete: (id, generation) => {
          dispatch({ type: 'MOTION_DONE', id, generation })
        },
        hintBatSide: hint
          ? session.liveData.plays.currentPlay?.matchup.batSide.code === 'R'
            ? 'L'
            : 'R'
          : undefined,
        scoreboard: fieldScoreboard,
        interaction: {
          generation: state.generation,
          runnerIds,
          retreatIds,
          advanceIds,
          selectableIds:
            status.readOnly ||
            menu ||
            sheet != null ||
            defensiveOpen ||
            outcomeMenu ||
            moreOpen ||
            tiebreaker.active ||
            state.presentation != null
              ? []
              : [
                    'locateFielder',
                    'chooseThrower',
                    'chooseDefender',
                    'runnerError'
                  ].includes(state.phase)
                ? [
                    ...players
                      .filter(
                        player =>
                          player.team !== 'runner' &&
                          (state.phase === 'runnerError' ||
                            player.hasBall !== true) &&
                          player.emptyPosition !== true
                      )
                      .map(player => player.id),
                    ...(relayForce ? runnerIds : [])
                  ]
                : [
                    ...defensiveIds,
                    ...runnerIds,
                    ...(switchable && batterId != null
                      ? [`offense-${batterId}`]
                      : [])
                  ],
          gestures:
            status.readOnly ||
            menu ||
            sheet != null ||
            defensiveOpen ||
            outcomeMenu ||
            moreOpen ||
            tiebreaker.active ||
            state.presentation != null
              ? []
              : ['trajectory', 'locateLanding'].includes(state.phase)
                ? ['trajectory']
                : ['place']
        },
        onTrajectoryAccepted: (value, generation, dragged) => {
          if (tiebreaker.active) return
          scoringAudio.unlock()
          dispatch({
            type: 'TRAJECTORY',
            angle: value,
            generation,
            // The scorer's own angle: one a drag turned, or one accepted off
            // where the control started, as a tap after the keyboard's
            // arrows or their Enter leaves it.
            dragged: dragged === true || value !== startingAngle(state)
          })
        },
        registerKeyboard,
        onFieldPlacement: event => {
          if (tiebreaker.active) return
          const id = players.find(
            player => player.id === event.entityId
          )?.playerId
          if (id != null && state.phase === 'runnerError')
            dispatchRunner({
              type: 'RUNNER_ERROR',
              id,
              generation: event.generation
            })
          if (
            id != null &&
            (state.phase === 'chooseThrower' ||
              state.phase === 'chooseDefender')
          )
            dispatchRunner({
              type: state.phase === 'chooseThrower' ? 'THROWER' : 'DEFENDER',
              id,
              point: event.point,
              generation: event.generation
            })
          if (id != null && state.phase === 'locateFielder')
            dispatch({
              type: 'FIELDER',
              id,
              point: event.point,
              landingHeight: event.landingHeight,
              generation: event.generation
            })
        },
        selected,
        onSelect: setSelected,
        view: 'home',
        zoom: 1.25,
        movementRevision: state.generation + session.meta.sequence,
        selectableIds:
          switchable &&
          !status.readOnly &&
          !tiebreaker.active &&
          !menu &&
          sheet == null &&
          batterId != null
            ? [`offense-${batterId}`]
            : [],
        onPlayerPlacement: (id, point) => {
          if (tiebreaker.active) return
          if (id === `offense-${batterId}`) {
            const rendered = players.find(player => player.id === id)
            if (rendered != null) {
              rendered.target = { x: point.x >= 0 ? 4 : -4, z: 0 }
            }
            dispatch({ type: 'SWITCH_SIDE', side: point.x >= 0 ? 'L' : 'R' })
            setHint(false)
          }
        }
      }}
      onDismissHint={
        hint && !menu && sheet == null
          ? () => {
              setHint(false)
            }
          : undefined
      }
      walkUpControl={
        note.shown ? (
          <WalkUpControl
            batterName={note.batterName}
            playing={note.playing}
            dimmed={note.dimmed}
            toast={note.toast}
            onPress={note.handlePress}
          />
        ) : undefined
      }
      moreControl={
        <MoreMenu
          state={state}
          disabled={
            menu ||
            sheet != null ||
            outcomeMenu ||
            tiebreaker.active ||
            !actionsAllowed
          }
          onActive={active => {
            if (active) pauseClock()
            setMoreOpen(active)
          }}
          onChoose={input => {
            if (
              !actionsAllowed ||
              menu ||
              sheet != null ||
              outcomeMenu ||
              tiebreaker.active
            )
              return
            setHint(false)
            setMoreOpen(false)
            if (
              input.action === 'Place a Runner (Tiebreaker)' &&
              input.base == null
            )
              tiebreaker.handleOpen()
            else dispatch({ type: 'MORE', input })
          }}
        />
      }
      ballInPlayControl={
        <OutcomeControls
          hasRunners={baseIds(session).some(id => id != null)}
          disabled={
            !actionsAllowed ||
            menu ||
            sheet != null ||
            moreOpen ||
            tiebreaker.active ||
            state.moreDraft != null
          }
          onActive={setOutcomeMenu}
          onChoose={(outcome, contactKind) => {
            if (
              !actionsAllowed ||
              menu ||
              sheet != null ||
              moreOpen ||
              tiebreaker.active
            )
              return
            scoringAudio.unlock()
            setHint(false)
            // Closed with the choice, so the field takes input the moment it asks.
            setOutcomeMenu(false)
            dispatch({ type: 'OUTCOME', outcome, contactKind })
          }}
        />
      }
      onMenuButton={setMenuButton}
      sound={{ on: sound, onToggle: toggleSound }}
      onMenu={() => {
        if (tiebreaker.active) return
        pauseClock()
        setOutcomeMenu(false)
        setMenu(value => !value)
      }}
      historyRows={tagHistory.rows}
      tagHistoryDetail={tagHistory.detail}
      onHistoryOpen={
        props.source.saveTag == null || tiebreaker.active
          ? undefined
          : () => {
              if (tiebreaker.active) return
              pauseClock()
              setHistoryActive(true)
            }
      }
      onTagSelect={target => {
        tagSelection.current++
        setTagTarget(target)
      }}
      onHistoryClose={() => {
        setHistoryActive(false)
      }}
      onUndo={() => {
        scoringAudio.stop()
        if (status.readOnly || rosterLoading) return
        tiebreaker.handleClose()
        // The reducer decides, from the state every earlier tap left, whether
        // this one is the screen's to take back or the saved game's.
        dispatch({ type: 'UNDO' })
      }}
      onPitch={kind => {
        if (
          choosingRunnerPitch &&
          !menu &&
          sheet == null &&
          !outcomeMenu &&
          !moreOpen &&
          !tiebreaker.active &&
          (kind === 'ball' || kind === 'called' || kind === 'swing')
        ) {
          scoringAudio.unlock()
          dispatch({ type: 'RUNNER_PITCH_KIND', kind })
          return
        }
        if (
          !actionsAllowed ||
          menu ||
          sheet != null ||
          outcomeMenu ||
          moreOpen ||
          tiebreaker.active
        )
          return
        scoringAudio.unlock()
        if (kind !== 'play') dispatch({ type: 'PITCH', kind })
        setHint(false)
      }}
      historyLabel={
        status.readOnly
          ? undefined
          : (state.past.at(-1)?.label ??
            (state.log.length > 0 ? 'Last play' : undefined))
      }
      historyDetail={status.readOnly ? undefined : lastPlay}
      // Read-only asks nothing of the scorer, so it shows no instruction.
      instruction={
        setupInstruction ??
        (status.readOnly
          ? undefined
          : state.moreDraft != null && !choosingRunnerPitch
            ? `Drag a runner for ${state.moreDraft.action}`
            : (instruction ??
              (state.phase === 'awaitingBatter'
                ? 'Next batter is on base. Update lineup to continue.'
                : undefined)))
      }
      instructionStatus={
        state.pendingPlay?.outcome === 'Home Run' &&
        ['locateLanding', 'trajectory'].includes(state.phase)
          ? homeRunLabel(
              landingPreview != null
                ? homeRunKind(landingPreview)
                : (state.pendingPlay.homeRunKind ?? 'in-park')
            )
          : undefined
      }
      instructionDetail={
        state.phase === 'trajectory'
          ? `${angle}° ${trajectoryLabel(angle)}`
          : undefined
      }
      finishLabel={
        state.phase === 'chooseDefender'
          ? lstrings.scoring_finish_defensive_play
          : lstrings.scoring_finish_at_bat
      }
      remainingMs={
        !status.readOnly &&
        state.phase === 'correctionWindow' &&
        state.presentation == null
          ? state.correctionWindow?.remainingMs
          : undefined
      }
      canFinish={
        !status.readOnly &&
        (state.phase === 'correctionWindow' ||
          (state.phase === 'chooseDefender' &&
            state.runnerAction?.thrower != null)) &&
        !menu &&
        sheet == null &&
        !outcomeMenu &&
        !tiebreaker.active &&
        !gestureActive &&
        state.presentation == null &&
        !state.motions.some(
          motion => !motion.complete && motion.purpose !== 'approachFirst'
        )
      }
      onFinish={
        status.readOnly ||
        (state.phase !== 'chooseDefender' && state.phase !== 'correctionWindow')
          ? undefined
          : () => {
              if (
                gestureActive ||
                menu ||
                sheet != null ||
                outcomeMenu ||
                moreOpen ||
                tiebreaker.active
              )
                return
              if (state.phase === 'chooseDefender') {
                dispatchRunner({
                  type: 'DEFENDER',
                  generation: state.generation
                })
                return
              }
              dispatch({
                type: 'CLOSE_PLAY',
                generation: state.generation,
                revision: state.correctionWindow?.revision,
                sequence: session.meta.sequence
              })
            }
      }
      onCameraGesture={setGesture}
      enabledPitchKinds={
        choosingRunnerPitch ? ['ball', 'called', 'swing'] : undefined
      }
      canPitch={
        (actionsAllowed || choosingRunnerPitch) &&
        !menu &&
        sheet == null &&
        !defensiveOpen &&
        !outcomeMenu &&
        !moreOpen &&
        !tiebreaker.active &&
        (state.moreDraft == null || choosingRunnerPitch) &&
        state.presentation == null
      }
      summary={summary}
      dictationControl={tiebreaker.active ? undefined : dictation.control}
      dictationLog={dictation.log}
      accessibilitySummary={`${state.celebration == null ? '' : state.celebration.kind === 'in-park' ? 'IN THE PARK HOME RUN · ' : 'HOME RUN · '}${summary} · Batter ${line.offense.batter == null ? 'waiting' : (shownNames.get(line.offense.batter.id) ?? 'waiting')} ${session.liveData.plays.currentPlay?.matchup.batSide.code === 'L' ? 'left handed' : 'right handed'} · Pitcher ${line.defense.P == null ? 'unassigned' : (shownNames.get(line.defense.P.id) ?? 'unassigned')}`}
    >
      {tiebreaker.mode === 'settings' && (
        <TiebreakerSetupSheet
          outs={line.outs}
          onPlace={tiebreaker.handlePlace}
          onOuts={tiebreaker.handleSetOuts}
          onClose={tiebreaker.handleClose}
          problem={tiebreaker.problem}
        />
      )}
      {tiebreaker.mode === 'bases' && (
        <TiebreakerBases
          projection={baseProjection}
          occupied={baseIds(session)}
          onChoose={tiebreaker.handleChooseBase}
          onCancel={tiebreaker.handleClose}
        />
      )}
      {typeof tiebreaker.mode === 'number' && (
        <RunnerRosterSheet
          session={displaySession}
          base={tiebreaker.mode}
          onChoose={tiebreaker.handleChooseRunner}
          onClose={tiebreaker.handleBack}
          problem={tiebreaker.problem}
        />
      )}
      {defensiveSlot != null && (
        <DefensiveRosterSheet
          session={displaySession}
          side={fieldingSide(session)}
          position={defensiveSlot.position}
          busy={rosterLoading}
          problem={rosterProblem}
          onClose={() => {
            cancelDefensiveCreation()
            setDefensiveSlot(undefined)
          }}
          onChoose={chooseDefender}
          onAddPlayer={createDefensivePlayer}
          onCancelCreate={cancelDefensiveCreation}
          onAddPlaceholders={createDefensivePlaceholders}
          onRefresh={refreshDefensiveRoster}
        />
      )}
      {priorRunner.overlay}
      <ErrorCreditSheet state={state} dispatch={dispatch} />
      <RelayedRunnerDragTargets
        relay={runnerDrag}
        hides={view =>
          view.to < view.from ||
          // homeDecision retreat-only: no Safe/Out on a hold at the offered base
          (homeWaiting &&
            retreatIds.includes(view.id) &&
            advanceIds?.includes(view.id) !== true)
        }
        onChoose={decision => {
          keyboard.current?.(decision === 'safe' ? 's' : 'o')
          keyboard.current?.('Enter')
        }}
        onCancel={() => {
          keyboard.current?.('Escape')
        }}
      />
      {state.moreDraft != null && state.runnerDraft == null && (
        <View
          style={{ position: 'absolute', bottom: 130, alignSelf: 'center' }}
        >
          <ScoringButton
            label="Cancel"
            onPress={() => {
              dispatch({ type: 'RUNNER_CANCEL' })
            }}
          />
        </View>
      )}
      {!menu &&
        sheet == null &&
        !tiebreaker.active &&
        state.presentation == null && (
          <RunnerControls
            state={state}
            anchor={null}
            projection={baseProjection}
            dispatch={dispatchRunner}
          />
        )}
      {menu && (
        <>
          <Pressable
            accessibilityLabel="Dismiss scoring menu"
            onPress={() => {
              setMenu(false)
            }}
            style={{ position: 'absolute', inset: 0, zIndex: 99 }}
          />
          <ScrollView
            style={{
              position: 'absolute',
              ...scoringMenuFrame(menuButton),
              // The space below its top, so all seven rows fit a phone held
              // sideways; before the window is measured, three quarters.
              maxHeight:
                windowHeight > 0
                  ? Math.max(
                      SCORING_MENU.rowHeight,
                      windowHeight - scoringMenuFrame(menuButton).top - 8
                    )
                  : '75%',
              zIndex: 100,
              overflow: 'hidden',
              backgroundColor: SCORING_MENU.background,
              borderColor: SCORING_MENU.border,
              borderWidth: 1,
              borderRadius: 12
            }}
          >
            {(
              [
                'Exit Current Game',
                'Settings',
                'Overrides',
                'End Half Inning',
                'Set Team Rosters',
                'Swap Home and Away',
                'End Game'
              ] as const
            ).map((label, index) => (
              <ScoringMenuButton
                key={label}
                danger={index === 6}
                label={label}
                subtext={
                  // Whether a swap resets the game, as the server will decide it.
                  index !== 5
                    ? undefined
                    : (swapRefusal() ??
                      (resetsPlays(pictured())
                        ? 'resets all game plays'
                        : undefined))
                }
                disabled={
                  // Read-only leaves only leaving and settings.
                  (status.readOnly && [2, 3, 4, 5, 6].includes(index)) ||
                  (index === 5
                    ? !swappable || swapRefusal() != null
                    : index === 6
                      ? !(
                          state.phase === 'ready' ||
                          state.phase === 'awaitingBatter'
                        ) ||
                        state.presentation != null ||
                        state.moreDraft != null ||
                        state.session.final ||
                        props.game.atBatOpen
                      : index === 3
                        ? state.phase !== 'ready' ||
                          state.presentation != null ||
                          state.moreDraft != null
                        : (index === 2 || index === 4) &&
                          (state.presentation != null ||
                            state.moreDraft != null ||
                            (state.phase !== 'ready' &&
                              state.phase !== 'awaitingBatter')))
                }
                onPress={() => {
                  setMenu(false)
                  if (index === 0) exit()
                  else if (index === 6) setSheet('game')
                  else if (index === 5) {
                    const now = pictured()
                    setSwapProblem(undefined)
                    setSwapLoses(playsLost(now))
                    setSwapResets(resetsPlays(now))
                    setSheet('swap')
                  } else if (index === 4) openRosters()
                  else
                    setSheet(
                      (['exit', 'settings', 'overrides', 'half'] as const)[
                        index
                      ]
                    )
                }}
              />
            ))}
          </ScrollView>
        </>
      )}
      {sheet != null && (
        <ScoringSheet
          visible={props.active || sheet === 'exit'}
          headerless={sheet === 'rosters'}
          textCancel
          fullScreen={sheet === 'rosters'}
          tall={sheet === 'settings'}
          done={sheet === 'settings'}
          swipeToDismiss={sheet === 'settings'}
          scroll={sheet !== 'rosters'}
          title={
            {
              exit: 'Exit Current Game',
              settings: 'Settings',
              overrides: 'Overrides',
              half: 'End Half Inning',
              rosters: 'Set Team Rosters',
              swap: 'Swap Home and Away',
              game: 'End Game'
            }[sheet]
          }
          onClose={closeSheet}
        >
          {sheet === 'exit' && (
            <>
              <Text
                style={{
                  color: theme.scoringSurface.text,
                  fontFamily: theme.regularTextFont
                }}
              >
                {props.persistent
                  ? `${status.pending} ${status.pending === 1 ? 'change has' : 'changes have'} not reached the server yet and will be lost.`
                  : 'Your local development scoring will be discarded.'}
              </Text>
              <ScoringButton
                label="Discard and Exit"
                color={theme.scoringSurface.dangerFill}
                onPress={() => {
                  confirmation.current?.(true)
                  confirmation.current = null
                  setSheet(undefined)
                }}
              />
            </>
          )}
          {sheet === 'settings' && (
            <ScoringSettings
              userId={props.userId}
              onSoundChange={setSound}
              onAnimationsChange={enabled => {
                dispatch({ type: 'PRESENTATION', enabled })
              }}
            />
          )}
          {sheet === 'rosters' &&
            (rosterLoading ? (
              <ActivityIndicator
                accessibilityLabel="Refreshing game"
                color={theme.scoringSurface.accent}
              />
            ) : rosterProblem != null ? (
              <>
                <ScoringError message={rosterProblem} />
                <ScoringButton
                  label="Retry refreshing game"
                  onPress={() => {
                    openRosters(rosterInitial != null)
                  }}
                />
              </>
            ) : (
              <RosterEditor
                key={rosterRead}
                initialDraft={rosterInitial}
                defaultSide={props.rosterDefaultSide}
                scorekeeperSide={props.scorekeeperSide}
                state={state}
                rosters={props.rosters}
                unaccepted={lineupsUnaccepted(state, props.visibleDefaults)}
                onDraftChange={setRosterInitial}
                conflict={rosterLive.conflict}
                onDirtyChange={setRosterChanged}
                onEditPlayer={props.onEditPlayer}
                onCreateGuest={async (side, player) =>
                  await props.client.createGuestPlayer(
                    state.session.gamePk,
                    side,
                    rosterPlayerBody(player),
                    openedTeam(side, state.session.gameData.teams[side].id)
                  )
                }
                onCreatePlayer={async (teamId, player) =>
                  await props.client.createRosterPlayer(
                    teamId,
                    rosterPlayerBody(player)
                  )
                }
                canEditTeams={props.rosterRights}
                rosterLoading={props.detailsLoading}
                rosterError={props.detailsProblem}
                onRetryRoster={props.onRefreshDetails}
                dictate={{
                  health: props.persistent ? health : noDictation,
                  url: socketUrl,
                  token: props.client.token,
                  gameId: props.gameId,
                  model: dictationModel,
                  log: state.log,
                  startEnabled: rosterMicOn
                }}
                onCancel={() => {
                  // Back to the server's copy, with the other device's
                  // change.
                  if (rosterLive.conflict) {
                    stale.current = true
                    echoes.current = null
                    setStaleCheck(value => value + 1)
                  }
                  closeSheet()
                }}
                onSave={async (draft, nextBatter, runners) => {
                  const problem = rosterRefusal(
                    state,
                    draft,
                    nextBatter,
                    runners
                  )
                  if (problem != null) throw new Error(problem)
                  dispatch({ type: 'ROSTER', draft, nextBatter, runners })
                  closeSheet()
                }}
              />
            ))}
          {sheet === 'overrides' && (
            <OverridesEditor
              state={state}
              onApply={draft => {
                dispatch({ type: 'OVERRIDE', draft })
                closeSheet()
              }}
            />
          )}
          {sheet === 'swap' && (
            <>
              <Text
                style={{
                  color: theme.scoringSurface.text,
                  fontFamily: theme.regularTextFont
                }}
              >
                {swapResets ? `${resetWarning(swapLoses)} ` : ''}
                {session.gameData.teams.home.name} will bat first, and{' '}
                {session.gameData.teams.away.name} will be at home. Lineups,
                guests and unavailable players move with their teams.
                {swapResets
                  ? ' Lineups go back to how they were at the first pitch.'
                  : ''}
              </Text>
              {swapProblem != null && (
                <Text
                  accessibilityRole="alert"
                  style={{
                    color: theme.scoringSurface.danger,
                    fontFamily: theme.regularTextFont
                  }}
                >
                  {swapProblem}
                </Text>
              )}
              <ScoringButton
                label={swapResets ? 'Reset and Swap' : 'Confirm Swap'}
                color={swapResets ? theme.scoringSurface.dangerFill : undefined}
                disabled={swapping}
                onPress={() => {
                  confirmSwap().catch(() => undefined)
                }}
              />
            </>
          )}
          {sheet === 'game' && (
            <>
              <Text
                style={{
                  color: theme.scoringSurface.text,
                  fontFamily: theme.regularTextFont
                }}
              >
                End the game at {session.gameData.teams.away.name}{' '}
                {line.teams.away.runs}, {session.gameData.teams.home.name}{' '}
                {line.teams.home.runs}? Undo takes it back.
              </Text>
              <ScoringButton
                label="Confirm End Game"
                onPress={() => {
                  dispatch({ type: 'END_GAME' })
                  closeSheet()
                }}
              />
            </>
          )}
          {sheet === 'half' && (
            <>
              <Text
                style={{
                  color: theme.scoringSurface.text,
                  fontFamily: theme.regularTextFont
                }}
              >
                End {line.inningState} of the {line.currentInningOrdinal}{' '}
                inning?
              </Text>
              <ScoringButton
                label="Confirm End Half Inning"
                onPress={() => {
                  dispatch({ type: 'END_HALF' })
                  closeSheet()
                }}
              />
            </>
          )}
        </ScoringSheet>
      )}
      {topBand > 0 && (
        // The band's fill is dark: the status bar's text goes light over it.
        <StatusBar barStyle="light-content" />
      )}
      {statusLine != null && (
        // Offline, across the very top in a band the field starts under.
        // Anything else on the phone above the bottom deck, clear of the
        // scoreboard and ☰. A held game's line is a button: what to do
        // about it.
        <View
          pointerEvents={heldGame == null ? 'none' : 'box-none'}
          style={
            atTop
              ? scoringOfflineFrame(
                  Platform.OS !== 'web',
                  insets,
                  theme.scoringSurface.background
                )
              : scoringStatusFrame(Platform.OS !== 'web', insets)
          }
        >
          {heldGame == null ? (
            statusPill
          ) : (
            <HeldGameNotice held={heldGame} onSettled={props.onReopen}>
              {statusPill}
            </HeldGameNotice>
          )}
        </View>
      )}
      {state.session.final && (
        <View
          pointerEvents="none"
          style={{ position: 'absolute', top: 36, alignSelf: 'center' }}
        >
          <Text
            accessibilityLabel="Game over"
            style={{
              color: theme.primaryTextColor,
              fontFamily: theme.regularTextFont
            }}
          >
            Game over
          </Text>
        </View>
      )}
      {status.readOnly && (
        <View
          accessibilityLabel="Scoring is read-only"
          style={{
            position: 'absolute',
            inset: 0,
            zIndex: 200,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: 'rgba(0,0,0,0.55)'
          }}
        >
          <Text
            style={{
              color: '#fff',
              fontFamily: theme.regularTextFont,
              padding: 20,
              textAlign: 'center'
            }}
          >
            {status.problem}
          </Text>
          <ScoringButton label="Exit Current Game" onPress={props.onExit} />
        </View>
      )}
      {tagTarget != null && (
        <EventTagEditor
          key={tagSelection.current}
          target={tagTarget}
          loadChoices={loadTags}
          onClose={() => {
            tagSelection.current++
            setTagTarget(null)
          }}
          saveTag={async tag => {
            const selected = tagSelection.current
            const token = props.client.token
            await props.game.flush()
            const currentContext = (): boolean => {
              const current = tagContext.current
              return !(
                !tagMounted.current ||
                current.game !== props.game ||
                current.source !== props.source ||
                current.userId !== props.userId ||
                current.gameId !== props.gameId ||
                current.client !== props.client ||
                props.client.token !== token
              )
            }
            if (selected !== tagSelection.current || !currentContext())
              throw new Error(
                'The tag selection changed. Open the event again.'
              )
            if (props.game.pending > 0 || props.game.problem != null)
              throw new Error(
                'Save the scoring event before assigning a tag. Try again.'
              )
            if (
              !props.game.eventTargets.some(
                target => target.id === tagTarget.id
              )
            )
              throw new Error('This scoring event no longer exists')
            let snapshot = props.game.tagSnapshotVersion
            const result = await props.source.saveTag!(
              props.game,
              tagTarget.id,
              tag,
              props.userId
            )
            if (!currentContext())
              throw new Error(
                'The tag selection changed. Open the event again.'
              )
            // Commit revisions distinguish delayed requests from delayed responses.
            const superseded = (): boolean => {
              const acknowledged = tagAcknowledgments.current.get(
                result.targetId
              )
              return (
                acknowledged != null &&
                (result.revision.length < acknowledged.length ||
                  (result.revision.length === acknowledged.length &&
                    result.revision < acknowledged))
              )
            }
            if (superseded()) return
            let acknowledgedTag = result.tag
            // A reload or another accepted write may have adopted a newer label.
            // Read storage again rather than overwrite that snapshot with this reply.
            while (snapshot !== props.game.tagSnapshotVersion) {
              snapshot = props.game.tagSnapshotVersion
              const storedTag = await props.game.readEventTag(result.targetId)
              if (!currentContext())
                throw new Error(
                  'The tag selection changed. Open the event again.'
                )
              if (superseded()) return
              if (storedTag === undefined)
                throw new Error('This scoring event no longer exists')
              acknowledgedTag = storedTag
            }
            if (!props.game.setEventTag(result.targetId, acknowledgedTag))
              throw new Error('This scoring event no longer exists')
            tagAcknowledgments.current.set(result.targetId, result.revision)
          }}
        />
      )}
    </BaseballScreen>
  )
}

/** The drop targets, redrawn from the drag's relay on their own. */
function RelayedRunnerDragTargets({
  relay,
  hides,
  onChoose,
  onCancel
}: {
  relay: Relay<RunnerDragView | null>
  hides: (view: RunnerDragView) => boolean
  onChoose: (decision: 'safe' | 'out') => void
  onCancel: () => void
}): React.ReactElement {
  const view = useRelay(relay)
  return (
    <RunnerDragTargets
      view={view == null || hides(view) ? null : view}
      onChoose={onChoose}
      onCancel={onCancel}
    />
  )
}
