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
  Pressable,
  ScrollView,
  Text,
  View
} from 'react-native'

import type {
  DictationModel,
  RosterEntry,
  TeamStationClient
} from '../../common/api'
import { HttpError } from '../../common/errors'
import type { TagTarget } from '../../common/eventTags'
import { managesRoster } from '../../common/roles'
import type { ScoringAction } from '../../common/scoring/actions'
import {
  awaitingResult,
  completesHitOffer,
  forcedFrom,
  runnerDecisionError as baseOccupiedError,
  undoesHitOffer
} from '../../common/scoring/rules'
import type { ScoringSession as GameSession } from '../../common/scoring/session'
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
  missingDefense,
  setupEditable,
  withRosterDetails
} from './currentSetup'
import { DefensiveRosterSheet } from './DefensiveRosterSheet'
import { useDictationControls } from './DictationButton'
import { ErrorCreditSheet } from './ErrorCreditSheet'
import { EventTagEditor } from './EventTagEditor'
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
import { addPlayerDraft, type PlayerDraft } from './playerDraft'
import { RosterEditor, type RosterEditorDraft } from './RosterEditor'
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
  scoringScreenModel,
  scoringScreenReducer,
  sessionAt
} from './scoringMachine'
import { SCORING_MENU, ScoringMenuButton } from './ScoringMenuAppearance'
import { scoringFieldPlayers } from './scoringMotion'
import { scoringPreferences } from './scoringPreferences'
import { withoutPrivateNames } from './scoringRosterCache'
import { rosterStaffSide } from './scoringRosterEdit'
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
import { DevelopmentScoringSource, type ScoringSource } from './scoringSource'
import {
  type HistoryEntry,
  type Position,
  POSITIONS,
  type ScoringEvent,
  type Side
} from './scoringTypes'
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
  onEditPlayer?: (userId: number, name: string, teamId: string) => void
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
}
export function ScoringScreen(props: ScoringScreenProps): React.ReactElement {
  const theme = useTheme()
  const [opened, setOpened] = useState<GameSession>()
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
  const surface = useFieldSurface()
  const fallback = useMemo(() => new DevelopmentScoringSource(), [])
  const source = props.source ?? fallback
  useEffect(() => {
    let live = true
    setOpened(undefined)
    setRosters({})
    authorizationPending.current = false
    rightsRef.current = {}
    setRosterRights({})
    setRosterDefaultSide(undefined)
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
            return withoutPrivateNames(
              await props.client.roster(teamId).catch(() => [])
            )
          }
          return []
        }
      }
      const [away, home] = await Promise.all([
        loadRoster(game.awayTeamId),
        loadRoster(game.homeTeamId)
      ])
      const value = await source.open(game, away, home)
      if (!live) return
      rightsRef.current = rights
      setRosterRights(rights)
      setRosterDefaultSide(
        rosterStaffSide(roles, game.awayTeamId, game.homeTeamId)
      )
      openedContext.current = {
        client: props.client,
        gameId: props.gameId,
        userId: props.userId,
        source,
        session: value
      }
      setRosters({ [game.awayTeamId]: away, [game.homeTeamId]: home })
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
            Unable to load scoring.
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
      <ScoringPanel
        key={`${String(props.userId ?? 'local-scorer')}:${props.gameId}`}
        game={opened}
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
      />
      {props.active !== false && (
        <WalkUpReadinessModals readiness={readiness} />
      )}
    </>
  )
}
interface SaveStatus {
  pending: number
  offline: boolean
  readOnly: boolean
  problem: string | null
}
function statusOf(game: GameSession): SaveStatus {
  return {
    pending: game.pending,
    offline: game.offline,
    readOnly: game.readOnly,
    problem: game.problem
  }
}
function sameActions(
  a: readonly ScoringAction[],
  b: readonly ScoringAction[]
): boolean {
  return (
    a.length === b.length &&
    a.every(
      (action, index) =>
        action === b[index] ||
        JSON.stringify(action) === JSON.stringify(b[index])
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
/** What the save is doing, in a line, or nothing when everything is saved. */
export function saveStatusText(status: SaveStatus): string | null {
  if (status.readOnly) return null
  if (status.pending > 0 && status.offline)
    return `Offline — ${status.pending} ${status.pending === 1 ? 'play' : 'plays'} waiting`
  if (status.problem != null) return `Not saved: ${status.problem}`
  if (status.pending > 0) return 'Saving…'
  return null
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
function ScoringPanel(props: {
  active: boolean
  onEditPlayer?: ScoringScreenProps['onEditPlayer']
  onBeforeLeave?: ScoringScreenProps['onBeforeLeave']
  allowNavigation?: ScoringScreenProps['allowNavigation']
  onNavigationApproved?: ScoringScreenProps['onNavigationApproved']
  rosterRights: Record<string, boolean>
  rosterDefaultSide?: Side
  detailsLoading: boolean
  detailsProblem?: string
  onRefreshDetails: () => void
  game: GameSession
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
}): React.ReactElement {
  const theme = useTheme()
  // A ball in play saved without its result cannot be shown, because the
  // outcome chosen for it is logged only with the result: the screen picks
  // the game up at the pitch before it, and saves that only once the scorer
  // does something from there.
  const [model, dispatch] = useReducer(
    scoringScreenReducer,
    props.game,
    game => {
      const resumed = game.resumable()
      return scoringScreenModel(
        resumedScoringState(resumed.state, resumed.actions, true)
      )
    }
  )
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
  useEffect(() => {
    // What the screen shows of the save is read in a task of its own: the
    // count folds the whole game (`ScoringSession.picture`), which would add
    // to the stall of the tap that changed it, and the save reads the same
    // fold straight after.
    let reading: ReturnType<typeof setTimeout> | null = null
    setTagSnapshot(props.game.tagSnapshotVersion)
    const unsubscribe = props.game.subscribe(() => {
      setTagSnapshot(props.game.tagSnapshotVersion)
      reading ??= setTimeout(() => {
        reading = null
        // The session tells of every change; the screen draws again only
        // when what it shows of the save changed.
        const next = statusOf(props.game)
        setStatus(shown => (sameStatus(shown, next) ? shown : next))
      }, 0)
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
  const [dictationModel, setDictationModel] = useState<DictationModel>()
  useEffect(() => {
    let live = true
    scoringPreferences
      .read(props.userId)
      .then(value => {
        if (live) {
          setSound(value.sound !== false)
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
  const [sheet, setSheet] = useState<
    'exit' | 'settings' | 'overrides' | 'half' | 'rosters' | 'game'
  >()
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
  const actionsAllowed =
    props.active &&
    bottomActionsAllowed(state) &&
    !status.readOnly &&
    !rosterLoading &&
    setupReady
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
  const dictation = useDictationControls({
    suspended: !props.active,
    health: props.persistent ? health : noDictation,
    url: socketUrl,
    token: props.client.token,
    gameId: props.gameId,
    model: dictationModel,
    session,
    log: state.log,
    problem: state.dictation?.problem,
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
      (atRest(state) || state.reel != null) &&
      !gestureActive &&
      !tiebreaker.active &&
      !rosterLoading &&
      (lineupAccepted || hasActivePlay),
    undone,
    onActions: (transcript, actions, undo) => {
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
  const refreshSetup = async (): Promise<GameState | null> => {
    setRosterLoading(true)
    setRosterProblem(undefined)
    try {
      if (!props.persistent) return currentSetup.current
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
      const refreshed = resumedScoringState(
        resumed.state,
        resumed.actions,
        state.presentationEnabled
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
      if (
        props.game.readOnly ||
        refreshed.session.pending != null ||
        (awaitingResult(props.game.state) && !oldUnresolved)
      ) {
        setSheet(undefined)
        setDefensiveSlot(undefined)
        return null
      }
      return refreshed.session
    } catch {
      setRosterProblem('Unable to refresh the game. Please try again.')
      return null
    } finally {
      setRosterLoading(false)
    }
  }
  const openRosters = (lineup = false): void => {
    props.onRefreshDetails()
    setRosterInitial(undefined)
    setSheet('rosters')
    refreshSetup()
      .then(fresh => {
        if (fresh == null) return
        setRosterInitial(
          lineup
            ? { draft: fresh, side: battingSide(fresh), mode: 'lineup' }
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
  const chooseDefender = (id: number): void => {
    const slot = defensiveSlot
    if (slot == null || rosterLoading) return
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
  const creatingDefender = useRef(false)
  const createDefensivePlayers = async (
    add: (draft: GameState, side: Side) => void
  ): Promise<void> => {
    const slot = defensiveSlot
    if (slot == null || creatingDefender.current || rosterLoading)
      throw new Error('The game is refreshing.')
    creatingDefender.current = true
    try {
      const fresh = await refreshSetup()
      if (fresh == null) throw new Error('Unable to refresh the game.')
      if (fieldingSide(fresh) !== slot.side || !editableSetup(fresh)) {
        setDefensiveSlot(undefined)
        throw new Error('The current defense has changed.')
      }
      const draft = copyState(fresh)
      add(draft, slot.side)
      currentSetup.current = draft
      dispatch({ type: 'ROSTER', draft })
    } finally {
      creatingDefender.current = false
    }
  }
  const createDefensivePlayer = async (player: PlayerDraft): Promise<void> => {
    await createDefensivePlayers((draft, side) => {
      addPlayerDraft(draft, side, player)
    })
  }
  const createDefensivePlaceholders = async (count: number): Promise<void> => {
    await createDefensivePlayers((draft, side) => {
      addPlaceholderPlayers(draft, side, count)
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
    const named = next.map(player => {
      const person = displaySession.gameData.players[player.playerId ?? 0]
      return person == null
        ? player
        : {
            ...player,
            name: person.fullName,
            displayName: person.fullName,
            jersey: person.jersey
          }
    })
    const complete = [...named, ...emptyDefensePlayers(session)]
    previousPlayers.current = complete
    return complete
  }, [
    session,
    displaySession,
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
      .read(props.userId)
      .then(async preferences => {
        if (!live || !preferences.help || preferences.shown >= 3) return
        shownAppearances.current.add(helpKey)
        setHint(true)
        await scoringPreferences.write(props.userId, {
          ...preferences,
          shown: preferences.shown + 1
        })
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
      : []
  const advanceIds = homeWaiting ? hitOfferAdvanceIds : undefined
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
    ...scoreboardFor(session),
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
              : ['locateFielder', 'chooseThrower', 'chooseDefender'].includes(
                    state.phase
                  )
                ? [
                    ...players
                      .filter(
                        player =>
                          player.team !== 'runner' &&
                          player.hasBall !== true &&
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
          : state.moreDraft != null
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
      canPitch={
        actionsAllowed &&
        !menu &&
        sheet == null &&
        !defensiveOpen &&
        !outcomeMenu &&
        !moreOpen &&
        !tiebreaker.active &&
        state.moreDraft == null &&
        state.presentation == null
      }
      summary={summary}
      dictationControl={tiebreaker.active ? undefined : dictation.control}
      dictationLog={dictation.log}
      accessibilitySummary={`${state.celebration == null ? '' : state.celebration.kind === 'in-park' ? 'IN THE PARK HOME RUN · ' : 'HOME RUN · '}${summary} · Batter ${line.offense.batter?.fullName ?? 'waiting'} ${session.liveData.plays.currentPlay?.matchup.batSide.code === 'L' ? 'left handed' : 'right handed'} · Pitcher ${line.defense.P?.fullName ?? 'unassigned'}`}
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
            setDefensiveSlot(undefined)
          }}
          onChoose={chooseDefender}
          onAddPlayer={createDefensivePlayer}
          onAddPlaceholders={createDefensivePlaceholders}
          onRefresh={refreshDefensiveRoster}
        />
      )}
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
              maxHeight: '75%',
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
                'End Game'
              ] as const
            ).map((label, index) => (
              <ScoringMenuButton
                key={label}
                danger={index === 5}
                label={label}
                disabled={
                  // Read-only leaves only leaving and settings.
                  (status.readOnly && [2, 3, 4, 5].includes(index)) ||
                  (index === 5
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
                  else if (index === 5) setSheet('game')
                  else if (index === 4) openRosters()
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
              health={props.persistent ? health : noDictation}
              onDictationModelChange={setDictationModel}
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
                state={state}
                rosters={props.rosters}
                onDraftChange={setRosterInitial}
                onEditPlayer={props.onEditPlayer}
                canEditTeams={props.rosterRights}
                rosterLoading={props.detailsLoading}
                rosterError={props.detailsProblem}
                onRetryRoster={props.onRefreshDetails}
                onCancel={closeSheet}
                onSave={(draft, nextBatter) => {
                  dispatch({ type: 'ROSTER', draft, nextBatter })
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
      {saveStatusText(status) != null && (
        <View
          pointerEvents="none"
          style={{
            position: 'absolute',
            top: 8,
            alignSelf: 'center',
            paddingHorizontal: 12,
            paddingVertical: 4,
            borderRadius: 12,
            backgroundColor: theme.backgroundColor
          }}
        >
          <Text
            accessibilityRole="text"
            accessibilityLabel="Save status"
            style={{
              color: theme.primaryTextColor,
              fontFamily: theme.regularTextFont
            }}
          >
            {saveStatusText(status)}
          </Text>
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
