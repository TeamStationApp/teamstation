import React, { useEffect, useMemo, useReducer, useRef, useState } from 'react'
import { ActivityIndicator, Pressable, Text, View } from 'react-native'

import type { GameStationClient } from '../../common/api'
import { BaseballScreen } from '../field/BaseballScreen'
import { useFieldSurface } from '../field/useFieldSurface'
import { fieldPlayersFor } from './fieldAdapter'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { scoringPreferences } from './scoringPreferences'
import { canSwitchBatter, scoreboardFor } from './scoringSelectors'
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
  const [menu, setMenu] = useState(false)
  const [hint, setHint] = useState(false)
  const [saveFailed, setSaveFailed] = useState(false)
  const stateRef = useRef(state)
  stateRef.current = state
  const session = state.session
  const line = session.liveData.linescore
  const exit = useScoringExit(
    session.gamePk,
    state.past.length > 0,
    props.onExit
  )
  const players = useMemo(() => fieldPlayersFor(session), [session])
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
  const summary =
    state.phase === 'awaitingBatter'
      ? 'Next batter is on base. Update lineup to continue.'
      : `${session.gameData.teams.away.name} ${line.teams.away.runs} · ${session.gameData.teams.home.name} ${line.teams.home.runs} · ${line.inningState} ${line.currentInningOrdinal} · ${line.balls} balls ${line.strikes} strikes ${line.outs} outs · Pitches ${scoreboardFor(session).pitchCount}`
  return (
    <BaseballScreen
      field={{
        players,
        hintBatSide: hint
          ? session.liveData.plays.currentPlay?.matchup.batSide.code === 'R'
            ? 'L'
            : 'R'
          : undefined,
        scoreboard: scoreboardFor(session),
        selected,
        onSelect: setSelected,
        view: 'home',
        zoom: 1.25,
        movementRevision: state.generation + session.meta.sequence,
        selectableIds:
          switchable && batterId != null ? [`offense-${batterId}`] : [],
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
      onMenu={() => {
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
      canPitch={state.phase === 'ready' && !menu}
      summary={summary}
      accessibilitySummary={`${summary} · Batter ${line.offense.batter?.fullName ?? 'waiting'} ${session.liveData.plays.currentPlay?.matchup.batSide.code === 'L' ? 'left handed' : 'right handed'} · Pitcher ${line.defense.P?.fullName ?? 'unassigned'}`}
    >
      {hint && (
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
            backgroundColor: '#14382df2',
            borderRadius: 8
          }}
        >
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Exit Current Game"
            onPress={exit}
            style={{ padding: 16 }}
          >
            <Text style={{ color: 'white' }}>Exit Current Game</Text>
          </Pressable>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Resume Game"
            onPress={() => {
              setMenu(false)
            }}
            style={{ padding: 16 }}
          >
            <Text style={{ color: 'white' }}>Resume Game</Text>
          </Pressable>
        </View>
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
