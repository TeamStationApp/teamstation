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

import type { GameStationClient } from '../../common/api'
import type { ScoringAction } from '../../common/scoring/actions'
import {
  awaitingResult,
  completesHitOffer,
  forcedFrom,
  runnerDecisionError as baseOccupiedError,
  undoesHitOffer
} from '../../common/scoring/rules'
import type { ScoringSession as GameSession } from '../../common/scoring/session'
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
import { useTheme } from '../theme/ThemeContext'
import {
  NO_WALK_UP_MUSIC,
  useWalkUpNote,
  type WalkUpRosters
} from '../walkup/useWalkUpNote'
import { WalkUpControl } from '../walkup/WalkUpControl'
import type { WalkUpMusic } from '../walkup/walkUpMusicTypes'
import { startingAngle, trajectoryLabel } from './battedBall'
import { battedBallField, fieldStageInstruction } from './battedBallField'
import { DictationButton } from './DictationButton'
import { ErrorCreditSheet } from './ErrorCreditSheet'
import { MoreMenu } from './MoreMenu'
import { OutcomeControls } from './OutcomeControls'
import { OverridesEditor } from './OverridesEditor'
import { describeLastPlay } from './playDescription'
import { RosterEditor } from './RosterEditor'
import { RunnerControls } from './RunnerControls'
import type { RunnerDragView } from './runnerDrag'
import { RunnerDragTargets } from './RunnerDragTargets'
import { scoringAudio } from './scoringAudio'
import { runnerDecisionError } from './scoringFlow'
import {
  actsOnOpening,
  atRest,
  resumedScoringState,
  scoringScreenModel,
  scoringScreenReducer,
  sessionAt
} from './scoringMachine'
import { SCORING_MENU, ScoringMenuButton } from './ScoringMenuAppearance'
import { scoringFieldPlayers } from './scoringMotion'
import { scoringPreferences } from './scoringPreferences'
import {
  baseIds,
  bottomActionsAllowed,
  canSwitchBatter,
  scoreboardFor
} from './scoringSelectors'
import { ScoringSettings } from './ScoringSettings'
import { ScoringButton, ScoringSheet } from './ScoringSheet'
import { DevelopmentScoringSource, type ScoringSource } from './scoringSource'
import type { ScoringEvent } from './scoringTypes'
import { dictationUrl } from './useDictation'
import { useHomeRunCelebration } from './useHomeRunCelebration'
import { useMenuEscape } from './useMenuEscape'
import { useScoringClock } from './useScoringClock'
import { useScoringExit } from './useScoringExit'

export interface ScoringScreenProps {
  client: GameStationClient
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
}
export function ScoringScreen(props: ScoringScreenProps): React.ReactElement {
  const theme = useTheme()
  const [opened, setOpened] = useState<GameSession>()
  const [rosters, setRosters] = useState<WalkUpRosters>({})
  const [failed, setFailed] = useState(false)
  const [retry, setRetry] = useState(0)
  const surface = useFieldSurface()
  const fallback = useMemo(() => new DevelopmentScoringSource(), [])
  const source = props.source ?? fallback
  useEffect(() => {
    let live = true
    setOpened(undefined)
    setFailed(false)
    const load = async (): Promise<void> => {
      const game = await props.client.game(props.gameId)
      const [away, home] = await Promise.all([
        props.client.roster(game.awayTeamId).catch(() => []),
        props.client.roster(game.homeTeamId).catch(() => [])
      ])
      const value = await source.open(game, away, home)
      if (!live) return
      setRosters({ [game.awayTeamId]: away, [game.homeTeamId]: home })
      setOpened(value)
    }
    load().catch(() => {
      if (live) setFailed(true)
    })
    return () => {
      live = false
    }
  }, [props.client, props.gameId, source, retry])
  if (opened == null)
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
    <ScoringPanel
      key={`${String(props.userId ?? 'local-scorer')}:${props.gameId}`}
      game={opened}
      client={props.client}
      gameId={props.gameId}
      persistent={source.persistent === true}
      onExit={props.onExit}
      userId={String(props.userId ?? 'local-scorer')}
      rosters={rosters}
      music={props.music ?? NO_WALK_UP_MUSIC}
      resolveSong={props.resolveSong}
      fadeAppleMusic={props.fadeAppleMusic}
    />
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
function ScoringPanel(props: {
  game: GameSession
  client: GameStationClient
  gameId: string
  persistent: boolean
  onExit: () => void
  userId: string
  rosters: WalkUpRosters
  music: WalkUpMusic
  resolveSong?: ScoringScreenProps['resolveSong']
  fadeAppleMusic?: boolean
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
  const state = model.scoring
  const openedLog = useRef(state.log)
  const [status, setStatus] = useState(() => statusOf(props.game))
  useEffect(() => {
    // What the screen shows of the save is read in a task of its own: the
    // count folds the whole game (`ScoringSession.picture`), which would add
    // to the stall of the tap that changed it, and the save reads the same
    // fold straight after.
    let reading: ReturnType<typeof setTimeout> | null = null
    const unsubscribe = props.game.subscribe(() => {
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
  useEffect(() => {
    let live = true
    scoringPreferences
      .read(props.userId)
      .then(value => {
        if (live) {
          setSound(value.sound !== false)
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
  const confirmation = useRef<((value: boolean) => void) | null>(null)
  const requestConfirmation = useCallback(
    async () =>
      await new Promise<boolean>(resolve => {
        confirmation.current = resolve
        setMenu(false)
        setSheet('exit')
      }),
    []
  )
  const closeSheet = (): void => {
    confirmation.current?.(false)
    confirmation.current = null
    setSheet(undefined)
  }
  useEffect(
    () => () => {
      confirmation.current?.(false)
    },
    []
  )
  useMenuEscape(
    menu,
    () => {
      setMenu(false)
    },
    'Open scoring menu'
  )
  const [hint, setHint] = useState(false)
  const pauseClock = useScoringClock(
    state,
    menu ||
      sheet != null ||
      outcomeMenu ||
      moreOpen ||
      gestureActive ||
      state.presentation != null,
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
  // Read-only takes no input at all, from the pointer, the keyboard or a
  // screen reader.
  const actionsAllowed = bottomActionsAllowed(state) && !status.readOnly
  const session = state.session
  const { client } = props
  const health = useCallback(async () => await client.health(), [client])
  // The last play in two lines, however many entries it took to tap.
  const { game } = props
  const { log, past, checkpoints } = state
  const lastPlay = useMemo(
    () =>
      describeLastPlay(log, past, session, logLength =>
        sessionAt({ log, checkpoints }, logLength, () => game.opening)
      ),
    [game, log, past, session, checkpoints]
  )
  const socketUrl = useMemo(() => dictationUrl(client.baseUrl), [client])
  const line = session.liveData.linescore
  const scoredHere = useRef(state.past.length)
  scoredHere.current = state.past.length
  // The walk-up song stops the moment the scorer leaves, not once the save
  // the exit waits on has finished.
  const stopWalkUp = useRef<() => void>(() => undefined)
  // Leaving first saves what the server has not acknowledged, and asks only
  // about changes that still did not reach it. A server that does not answer
  // holds the scorer back three seconds at most.
  const leave = useCallback(async (): Promise<boolean> => {
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
  }, [props.game, props.persistent, requestConfirmation])
  const exit = useScoringExit(
    session.gamePk,
    props.persistent ? status.pending > 0 : state.past.length > 0,
    props.onExit,
    leave
  )
  // The rosters are read from the server on the way in, so another scorer's
  // saved change is what the scorer edits; saving them posts at once. The
  // last one saved wins.
  const [rosterRead, setRosterRead] = useState(0)
  const shownLog = useRef(state.log)
  shownLog.current = state.log
  const openRosters = (): void => {
    setSheet('rosters')
    if (!props.persistent) return
    props.game
      .reload()
      .then(changed => {
        // The server's copy can read back differently with the same plays
        // (its players in another order). Then the screen is the game
        // already, and keeps its Undo history; only another scorer's plays
        // start it again from the server's.
        if (!changed || sameActions(shownLog.current, props.game.actions))
          return
        dispatch({
          type: 'RESET',
          session: props.game.state,
          log: [...props.game.actions]
        })
        // The editor starts again from the game the server holds.
        setRosterRead(value => value + 1)
      })
      .catch(() => undefined)
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
    previousPlayers.current = next
    return next
  }, [session, phase, pendingPlay, motions, runnerAction, presentation])
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
  const runnerIds = relayForce
    ? players
        .filter(
          player =>
            player.team === 'runner' &&
            player.batting !== true &&
            player.playerId != null &&
            forcedFrom(session, baseIds(session).indexOf(player.playerId) + 1)
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
  const celebrationPaused = menu || sheet != null || outcomeMenu || moreOpen
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
  return (
    <BaseballScreen
      field={{
        teams: session.gameData.teams,
        players,
        onBaseProjection: setBaseProjection,
        ...battedBallField(
          state,
          angle,
          landingArc,
          menu || sheet != null || outcomeMenu || moreOpen,
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
        presentationPaused: menu || sheet != null || outcomeMenu || moreOpen,
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
          if (generation !== state.generation) return
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
            outcomeMenu ||
            moreOpen ||
            state.presentation != null
              ? []
              : ['locateFielder', 'chooseThrower', 'chooseDefender'].includes(
                    state.phase
                  )
                ? [
                    ...players
                      .filter(
                        player =>
                          player.team !== 'runner' && player.hasBall !== true
                      )
                      .map(player => player.id),
                    ...(relayForce ? runnerIds : [])
                  ]
                : [
                    ...runnerIds,
                    ...(switchable && batterId != null
                      ? [`offense-${batterId}`]
                      : [])
                  ],
          gestures:
            status.readOnly ||
            menu ||
            sheet != null ||
            outcomeMenu ||
            moreOpen ||
            state.presentation != null
              ? []
              : ['trajectory', 'locateLanding'].includes(state.phase)
                ? ['trajectory']
                : ['place']
        },
        onTrajectoryAccepted: (value, generation, dragged) => {
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
          !menu &&
          sheet == null &&
          batterId != null
            ? [`offense-${batterId}`]
            : [],
        onPlayerPlacement: (id, point) => {
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
          disabled={menu || sheet != null || outcomeMenu || !actionsAllowed}
          onActive={active => {
            if (active) pauseClock()
            setMoreOpen(active)
          }}
          onChoose={input => {
            if (!actionsAllowed || menu || sheet != null || outcomeMenu) return
            setHint(false)
            setMoreOpen(false)
            dispatch({ type: 'MORE', input })
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
            state.moreDraft != null
          }
          onActive={setOutcomeMenu}
          onChoose={(outcome, contactKind) => {
            if (!actionsAllowed || menu || sheet != null || moreOpen) return
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
        pauseClock()
        setOutcomeMenu(false)
        setMenu(value => !value)
      }}
      onUndo={() => {
        scoringAudio.stop()
        if (status.readOnly) return
        // The reducer decides, from the state every earlier tap left, whether
        // this one is the screen's to take back or the saved game's.
        dispatch({ type: 'UNDO' })
      }}
      onPitch={kind => {
        if (!actionsAllowed || menu || sheet != null || outcomeMenu || moreOpen)
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
        status.readOnly
          ? undefined
          : state.moreDraft != null
            ? `Drag a runner for ${state.moreDraft.action}`
            : (instruction ??
              (state.phase === 'awaitingBatter'
                ? 'Next batter is on base. Update lineup to continue.'
                : undefined))
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
                moreOpen
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
        !outcomeMenu &&
        !moreOpen &&
        state.moreDraft == null &&
        state.presentation == null
      }
      summary={summary}
      accessibilitySummary={`${state.celebration == null ? '' : state.celebration.kind === 'in-park' ? 'IN THE PARK HOME RUN · ' : 'HOME RUN · '}${summary} · Batter ${line.offense.batter?.fullName ?? 'waiting'} ${session.liveData.plays.currentPlay?.matchup.batSide.code === 'L' ? 'left handed' : 'right handed'} · Pitcher ${line.defense.P?.fullName ?? 'unassigned'}`}
    >
      <ErrorCreditSheet state={state} dispatch={dispatch} />
      {props.persistent && (
        <DictationButton
          health={health}
          url={socketUrl}
          gameId={props.gameId}
          session={session}
          log={state.log}
          problem={state.dictation?.problem}
          question={state.dictationQuestion}
          onAnswer={answer => {
            dispatch({ type: 'DICTATION_ANSWER', ...answer })
          }}
          onDismissQuestion={() => {
            dispatch({ type: 'DICTATION_DISMISS' })
          }}
          // While a play is drawn or a player dragged, Space is the field's.
          spaceTalks={(atRest(state) || state.reel != null) && !gestureActive}
          onActions={(transcript, actions) => {
            dispatch({ type: 'DICTATED', transcript, actions })
          }}
        />
      )}
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
      {!menu && sheet == null && state.presentation == null && (
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
          textCancel={sheet === 'rosters'}
          fullScreen={sheet === 'rosters'}
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
                  color: theme.primaryTextColor,
                  fontFamily: theme.regularTextFont
                }}
              >
                {props.persistent
                  ? `${status.pending} ${status.pending === 1 ? 'change has' : 'changes have'} not reached the server yet and will be lost.`
                  : 'Your local development scoring will be discarded.'}
              </Text>
              <ScoringButton
                label="Discard and Exit"
                color={theme.dangerColor}
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
          {sheet === 'rosters' && (
            <RosterEditor
              key={rosterRead}
              state={state}
              onSave={(draft, nextBatter) => {
                dispatch({ type: 'ROSTER', draft, nextBatter })
                closeSheet()
              }}
            />
          )}
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
                  color: theme.primaryTextColor,
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
                  color: theme.primaryTextColor,
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
