import React, {
  useCallback,
  useEffect,
  useMemo,
  useReducer,
  useRef,
  useState
} from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'

import type { GameStationClient } from '../../common/api'
import { BaseballScreen } from '../field/BaseballScreen'
import { useFieldSurface } from '../field/useFieldSurface'
import { allowedAngle, trajectoryLabel } from './battedBall'
import { fieldPlayersFor } from './fieldAdapter'
import { OutcomePicker } from './OutcomePicker'
import { OverridesEditor } from './OverridesEditor'
import { RosterEditor } from './RosterEditor'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { scoringPreferences } from './scoringPreferences'
import { canSwitchBatter, scoreboardFor } from './scoringSelectors'
import { ScoringSettings } from './ScoringSettings'
import { ScoringButton, ScoringSheet } from './ScoringSheet'
import {
  DevelopmentScoringStateSource,
  type ScoringStateSource
} from './scoringStateSource'
import type { ScoringSessionState } from './scoringTypes'
import { SwitchHitterHint } from './SwitchHitterHint'
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
            backgroundColor: '#102b23',
            justifyContent: 'center',
            alignItems: 'center'
          }
        ]}
      >
        {failed ? (
          <Text style={{ color: 'white' }}>Game not found.</Text>
        ) : (
          <ActivityIndicator accessibilityLabel="Loading game" />
        )}
        <Pressable
          accessibilityRole="button"
          accessibilityLabel="Exit Current Game"
          onPress={props.onExit}
          style={{ padding: 20 }}
        >
          <Text style={{ color: 'white' }}>Exit Current Game</Text>
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
  const [state, dispatch] = useReducer(
    scoringReducer,
    props.initial,
    initialScoringState
  )
  const [outcomeMenu, setOutcomeMenu] = useState(false)
  const [angle, setAngle] = useState(45)
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
  const [hint, setHint] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
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
  const selectingDefense = [
    'locateFielder',
    'trajectory',
    'chooseThrower',
    'chooseDefender'
  ].includes(state.phase)
  const players = useMemo(
    () =>
      fieldPlayersFor(session).map(player => ({
        ...player,
        suppressed: selectingDefense && player.team === 'runner',
        ...(player.playerId === state.pendingPlay?.fielder &&
        state.pendingPlay?.location != null
          ? {
              position: { ...state.pendingPlay.location },
              target: { ...state.pendingPlay.location }
            }
          : {})
      })),
    [
      session,
      selectingDefense,
      state.pendingPlay?.fielder,
      state.pendingPlay?.location
    ]
  )
  useEffect(() => {
    setAngle(state.pendingPlay?.angle ?? 45)
  }, [state.pendingPlay?.angle, state.generation])
  const [selected, setSelected] = useState('')
  const switchable = state.phase === 'ready' && canSwitchBatter(session)
  const batterId = line.offense.batter?.id
  const shownAppearances = useRef(new Set<string>())
  const appearance = session.liveData.plays.currentPlay?.about.atBatIndex
  useEffect(() => {
    let live = true
    setHint(false)
    const helpKey = `${props.userId}:${appearance}:${batterId}`
    if (!switchable || shownAppearances.current.has(helpKey)) return
    scoringPreferences
      .read(props.userId)
      .then(async preferences => {
        if (!live || !preferences.help || preferences.shown >= 3) return
        shownAppearances.current.add(helpKey)
        setSelected(`offense-${batterId}`)
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
  }, [props.userId, batterId, appearance, switchable])
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
  const instruction =
    state.phase === 'locateFielder'
      ? 'Drag fielder to location of fielded ball.'
      : state.phase === 'trajectory'
        ? 'Drag up and down for ball trajectory.'
        : undefined
  const fieldScoreboard = {
    ...scoreboardFor(session),
    instruction,
    detail:
      instruction == null ? undefined : `${angle}° ${trajectoryLabel(angle)}`
  }
  const summary =
    instruction == null
      ? state.phase === 'awaitingBatter'
        ? 'Next batter is on base. Update lineup to continue.'
        : `${session.gameData.teams.away.name} ${line.teams.away.runs} · ${session.gameData.teams.home.name} ${line.teams.home.runs} · ${line.inningState} ${line.currentInningOrdinal} · ${line.balls} balls ${line.strikes} strikes ${line.outs} outs · Pitches ${scoreboardFor(session).pitchCount}`
      : `${instruction}${state.phase === 'trajectory' ? ` ${angle}° ${trajectoryLabel(angle)}` : ''}`
  return (
    <BaseballScreen
      field={{
        players,
        hintBatSide: hint
          ? session.liveData.plays.currentPlay?.matchup.batSide.code === 'R'
            ? 'L'
            : 'R'
          : undefined,
        scoreboard: fieldScoreboard,
        interaction: {
          generation: state.generation,
          selectableIds:
            menu || sheet != null || outcomeMenu
              ? []
              : state.phase === 'locateFielder'
                ? players
                    .filter(player => player.team !== 'runner')
                    .map(player => player.id)
                : switchable && batterId != null
                  ? [`offense-${batterId}`]
                  : [],
          gestures:
            menu || sheet != null || outcomeMenu
              ? []
              : state.phase === 'trajectory'
                ? ['trajectory']
                : ['place']
        },
        arc:
          state.pendingPlay?.location == null
            ? null
            : { target: state.pendingPlay.location, angle },
        arcMode:
          state.phase === 'trajectory' && !menu && sheet == null
            ? 'edit'
            : 'off',
        onArcChange: arc => {
          setAngle(allowedAngle(arc.angle, state.pendingPlay?.outcome ?? ''))
        },
        onTrajectoryAccepted: (value, generation) => {
          dispatch({ type: 'TRAJECTORY', angle: value, generation })
        },
        onFieldPlacement: event => {
          const id = players.find(
            player => player.id === event.entityId
          )?.playerId
          if (id != null && state.phase === 'locateFielder')
            dispatch({
              type: 'FIELDER',
              id,
              point: event.point,
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
      ballInPlayControl={
        <OutcomePicker
          disabled={state.phase !== 'ready' || menu || sheet != null}
          onActive={setOutcomeMenu}
          onChoose={outcome => {
            setHint(false)
            dispatch({ type: 'OUTCOME', outcome })
          }}
        />
      }
      onMenu={() => {
        setOutcomeMenu(false)
        setMenu(value => !value)
      }}
      onUndo={() => {
        dispatch({ type: 'UNDO' })
      }}
      onPitch={kind => {
        if (kind !== 'play') dispatch({ type: 'PITCH', kind })
        setHint(false)
      }}
      historyLabel={state.past.at(-1)?.label}
      canPitch={
        state.phase === 'ready' && !menu && sheet == null && !outcomeMenu
      }
      summary={summary}
      accessibilitySummary={`${summary} · Batter ${line.offense.batter?.fullName ?? 'waiting'} ${session.liveData.plays.currentPlay?.matchup.batSide.code === 'L' ? 'left handed' : 'right handed'} · Pitcher ${line.defense.P?.fullName ?? 'unassigned'}`}
    >
      {hint && !menu && sheet == null && (
        <SwitchHitterHint
          onDismiss={() => {
            setHint(false)
          }}
        />
      )}
      {menu && (
        <View
          style={{
            position: 'absolute',
            right: 12,
            top: 64,
            padding: 12,
            gap: 6,
            backgroundColor: '#14382df2',
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
              label={label}
              disabled={
                index === 3
                  ? state.phase !== 'ready'
                  : (index === 2 || index === 4) &&
                    state.phase !== 'ready' &&
                    state.phase !== 'awaitingBatter'
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
        </View>
      )}
      {sheet != null && (
        <ScoringSheet
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
              <Text style={{ color: 'white' }}>
                Your local development scoring will be discarded.
              </Text>
              <ScoringButton
                label="Discard and Exit"
                color="#963f3f"
                onPress={() => {
                  confirmation.current?.(true)
                  confirmation.current = null
                  setSheet(undefined)
                }}
              />
            </>
          )}
          {sheet === 'settings' && <ScoringSettings userId={props.userId} />}
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
              <Text style={{ color: 'white' }}>
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
