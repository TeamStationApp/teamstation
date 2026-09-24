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
import type { BallArcState } from '../field/ballArcModel'
import { BaseballScreen } from '../field/BaseballScreen'
import type { FieldPlayer } from '../field/fieldModel'
import type { BaseProjection } from '../field/fieldTypes'
import { homeRunKind, homeRunLabel } from '../field/stadiumBoundary'
import { useFieldSurface } from '../field/useFieldSurface'
import { useTheme } from '../theme/ThemeContext'
import { allowedAngle, trajectoryLabel } from './battedBall'
import { battedBallField, fieldStageInstruction } from './battedBallField'
import { ErrorCreditSheet } from './ErrorCreditSheet'
import { MoreMenu } from './MoreMenu'
import { OutcomePicker } from './OutcomePicker'
import { OverridesEditor } from './OverridesEditor'
import { RosterEditor } from './RosterEditor'
import { RunnerControls } from './RunnerControls'
import type { RunnerDragView } from './runnerDrag'
import { RunnerDragTargets } from './RunnerDragTargets'
import { runnerDecisionError } from './runnerRules'
import { scoringAudio } from './scoringAudio'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { scoringFieldPlayers } from './scoringMotion'
import { scoringPreferences } from './scoringPreferences'
import { baseIds, canSwitchBatter, scoreboardFor } from './scoringSelectors'
import { ScoringSettings } from './ScoringSettings'
import { ScoringButton, ScoringSheet } from './ScoringSheet'
import {
  DevelopmentScoringStateSource,
  type ScoringStateSource
} from './scoringStateSource'
import type { ScoringEvent, ScoringSessionState } from './scoringTypes'
import { useMenuEscape } from './useMenuEscape'
import { useScoringClock } from './useScoringClock'
import { useScoringExit } from './useScoringExit'

const developmentSource = new DevelopmentScoringStateSource()
export interface ScoringScreenProps {
  client: GameStationClient
  gameId: string
  userId?: string
  onExit: () => void
  source?: ScoringStateSource
}
export function ScoringScreen(props: ScoringScreenProps): React.ReactElement {
  const theme = useTheme()
  const [session, setSession] = useState<ScoringSessionState>()
  const [failed, setFailed] = useState(false)
  const surface = useFieldSurface()
  const source = props.source ?? developmentSource
  useEffect(() => {
    let live = true
    setSession(undefined)
    setFailed(false)
    const load = async (): Promise<void> => {
      const game = await props.client.game(props.gameId)
      const [away, home] = await Promise.all([
        props.client.roster(game.awayTeamId).catch(() => []),
        props.client.roster(game.homeTeamId).catch(() => [])
      ])
      const value = await source.load(game, away, home)
      if (live) setSession(value)
    }
    load().catch(() => {
      if (live) setFailed(true)
    })
    return () => {
      live = false
    }
  }, [props.client, props.gameId, source])
  if (session == null)
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
            Game not found.
          </Text>
        ) : (
          <ActivityIndicator accessibilityLabel="Loading game" />
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
    <ScoringSession
      key={props.gameId}
      initial={session}
      source={source}
      onExit={props.onExit}
      userId={props.userId ?? 'local-scorer'}
    />
  )
}
function ScoringSession(props: {
  initial: ScoringSessionState
  source: ScoringStateSource
  onExit: () => void
  userId: string
}): React.ReactElement {
  const theme = useTheme()
  const [state, dispatch] = useReducer(scoringReducer, props.initial, session =>
    initialScoringState(session, true)
  )
  const [sound, setSound] = useState(true)
  useEffect(() => {
    let live = true
    scoringPreferences
      .read(props.userId)
      .then(value => {
        if (live) setSound(value.sound !== false)
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
  const [sheet, setSheet] = useState<
    'exit' | 'settings' | 'overrides' | 'half' | 'rosters'
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
  const [saveFailed, setSaveFailed] = useState(false)
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
  const stateRef = useRef(state)
  stateRef.current = state
  const session = state.session
  const line = session.liveData.linescore
  const exit = useScoringExit(
    session.gamePk,
    state.past.length > 0,
    props.onExit,
    requestConfirmation
  )
  const { phase, pendingPlay, motions, homeQueue, runnerAction, presentation } =
    state
  const previousPlayers = useRef<FieldPlayer[]>([])
  const players = useMemo(() => {
    const next = scoringFieldPlayers(
      {
        session,
        phase,
        pendingPlay,
        motions,
        homeQueue,
        runnerAction,
        presentation
      },
      previousPlayers.current
    )
    previousPlayers.current = next
    return next
  }, [
    session,
    phase,
    pendingPlay,
    motions,
    homeQueue,
    runnerAction,
    presentation
  ])
  useEffect(() => {
    setAngle(
      allowedAngle(
        state.pendingPlay?.angle ?? 45,
        state.pendingPlay?.outcome ?? '',
        state.pendingPlay?.homeRunKind
      )
    )
  }, [
    state.pendingPlay?.angle,
    state.pendingPlay?.outcome,
    state.pendingPlay?.homeRunKind,
    state.generation
  ])
  const [runnerDrag, setRunnerDrag] = useState<RunnerDragView | null>(null)
  const [selected, setSelected] = useState('')
  const switchable = state.phase === 'ready' && canSwitchBatter(session)
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
  useEffect(() => {
    let live = true
    props.source.save(session).then(
      () => {
        if (live) setSaveFailed(false)
      },
      () => {
        if (live) setSaveFailed(true)
      }
    )
    return () => {
      live = false
    }
  }, [props.source, session])
  const unresolvedRunner = [...(state.pendingPlay?.movements ?? [])]
    .filter(move => move.decision === 'pending' && move.to < 4)
    .sort((a, b) => b.from - a.from)[0]
  const runnerEnabled =
    ['ready', 'correctionWindow', 'resolveBatter', 'runnerDecision'].includes(
      state.phase
    ) && !state.motions.some(motion => !motion.complete)
  const runnerIds = runnerEnabled
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
  const instruction =
    state.presentation != null
      ? undefined
      : (fieldStageInstruction(state) ??
        (state.phase === 'resolveBatter'
          ? unresolvedRunner?.from === 0
            ? 'Drag batter to a base, or hold to mark Out'
            : `Resolve ${session.gameData.players[unresolvedRunner?.playerId ?? 0]?.fullName ?? 'runner'}: drag to a base, or hold to mark Out`
          : undefined))
  const fieldScoreboard = scoreboardFor(session)
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
        onRunnerDrag: setRunnerDrag,
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
          selectableIds:
            menu ||
            sheet != null ||
            outcomeMenu ||
            moreOpen ||
            state.presentation != null
              ? []
              : ['locateFielder', 'chooseThrower', 'chooseDefender'].includes(
                    state.phase
                  )
                ? players
                    .filter(
                      player =>
                        player.team !== 'runner' && player.hasBall !== true
                    )
                    .map(player => player.id)
                : [
                    ...runnerIds,
                    ...(switchable && batterId != null
                      ? [`offense-${batterId}`]
                      : [])
                  ],
          gestures:
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
        onTrajectoryAccepted: (value, generation) => {
          scoringAudio.unlock()
          dispatch({ type: 'TRAJECTORY', angle: value, generation })
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
          switchable && !menu && sheet == null && batterId != null
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
      moreControl={
        <MoreMenu
          state={state}
          disabled={
            menu ||
            sheet != null ||
            outcomeMenu ||
            state.phase !== 'ready' ||
            state.presentation != null ||
            state.moreDraft != null
          }
          onActive={active => {
            if (active) pauseClock()
            setMoreOpen(active)
          }}
          onChoose={input => {
            setHint(false)
            dispatch({ type: 'MORE', input })
          }}
        />
      }
      ballInPlayControl={
        <OutcomePicker
          hasRunners={baseIds(session).some(id => id != null)}
          disabled={
            state.phase !== 'ready' ||
            state.presentation != null ||
            menu ||
            sheet != null ||
            moreOpen ||
            state.moreDraft != null
          }
          onActive={setOutcomeMenu}
          onChoose={outcome => {
            scoringAudio.unlock()
            setHint(false)
            dispatch({ type: 'OUTCOME', outcome })
          }}
        />
      }
      onMenu={() => {
        pauseClock()
        setOutcomeMenu(false)
        setMenu(value => !value)
      }}
      onUndo={() => {
        scoringAudio.stop()
        dispatch({ type: 'UNDO' })
      }}
      onPitch={kind => {
        scoringAudio.unlock()
        if (kind !== 'play') dispatch({ type: 'PITCH', kind })
        setHint(false)
      }}
      historyLabel={state.past.at(-1)?.label}
      instruction={
        state.moreDraft != null
          ? `Drag a runner for ${state.moreDraft.action}`
          : state.pendingPlay?.outcome === 'Home Run' &&
              ['locateLanding', 'trajectory'].includes(state.phase)
            ? `${instruction} ${homeRunLabel(landingPreview != null ? homeRunKind(landingPreview) : (state.pendingPlay.homeRunKind ?? 'in-park'))}`
            : (instruction ??
              (state.phase === 'awaitingBatter'
                ? 'Next batter is on base. Update lineup to continue.'
                : undefined))
      }
      instructionDetail={
        state.phase === 'trajectory'
          ? `${angle}° ${trajectoryLabel(angle)}`
          : undefined
      }
      finishLabel={
        state.phase === 'chooseDefender'
          ? 'Finish defensive play'
          : 'Finish at-bat'
      }
      remainingMs={
        state.phase === 'correctionWindow' && state.presentation == null
          ? state.correctionWindow?.remainingMs
          : undefined
      }
      canFinish={
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
        state.phase !== 'chooseDefender' && state.phase !== 'correctionWindow'
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
        state.phase === 'ready' &&
        !menu &&
        sheet == null &&
        !outcomeMenu &&
        !moreOpen &&
        state.moreDraft == null &&
        state.presentation == null
      }
      summary={summary}
      accessibilitySummary={`${summary} · Batter ${line.offense.batter?.fullName ?? 'waiting'} ${session.liveData.plays.currentPlay?.matchup.batSide.code === 'L' ? 'left handed' : 'right handed'} · Pitcher ${line.defense.P?.fullName ?? 'unassigned'}`}
    >
      <ErrorCreditSheet state={state} dispatch={dispatch} />
      <RunnerDragTargets
        view={runnerDrag}
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
              right: 12,
              top: 64,
              maxHeight: '75%',
              zIndex: 100,
              overflow: 'hidden',
              backgroundColor: theme.backgroundColor,
              borderRadius: 8
            }}
          >
            {(
              [
                'Exit Current Game',
                'Settings',
                'Overrides',
                'End Half Inning',
                'Set Team Rosters',
                'Resume Game'
              ] as const
            ).map((label, index) => (
              <ScoringButton
                key={label}
                row
                label={label}
                disabled={
                  index === 3
                    ? state.phase !== 'ready' ||
                      state.presentation != null ||
                      state.moreDraft != null
                    : (index === 2 || index === 4) &&
                      (state.presentation != null ||
                        state.moreDraft != null ||
                        (state.phase !== 'ready' &&
                          state.phase !== 'awaitingBatter'))
                }
                onPress={() => {
                  setMenu(false)
                  if (index === 0) exit()
                  else if (index !== 5)
                    setSheet(
                      (
                        [
                          'exit',
                          'settings',
                          'overrides',
                          'half',
                          'rosters'
                        ] as const
                      )[index]
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
          title={
            {
              exit: 'Exit Current Game',
              settings: 'Settings',
              overrides: 'Overrides',
              half: 'End Half Inning',
              rosters: 'Set Team Rosters'
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
                Your local development scoring will be discarded.
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
            <ScoringSettings userId={props.userId} onSoundChange={setSound} />
          )}
          {sheet === 'rosters' && (
            <RosterEditor
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
      {saveFailed && (
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Retry saving"
          onPress={() => {
            props.source
              .save(stateRef.current.session)
              .then(() => {
                setSaveFailed(false)
              })
              .catch(() => undefined)
          }}
        >
          <Text>Unable to save. Retry</Text>
        </Pressable>
      )}
    </BaseballScreen>
  )
}
