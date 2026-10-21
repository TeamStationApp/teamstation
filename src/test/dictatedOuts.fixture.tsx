import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AppRegistry, Pressable, Text, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { BaseballScreen } from '../app/field/BaseballScreen'
import { BASES, type FieldPlayer } from '../app/field/fieldModel'
import {
  atRest,
  initialScoringState,
  scoringReducer
} from '../app/scoring/scoringMachine'
import { scoringFieldPlayers } from '../app/scoring/scoringMotion'
import { playerRef, scoreboardFor } from '../app/scoring/scoringSelectors'
import type { ScoringEvent, ScoringState } from '../app/scoring/scoringTypes'
import { ThemeProvider } from '../app/theme/ThemeContext'
import { asGameDetail } from '../common/api'
import type { ScoringAction } from '../common/scoring/actions'
import { scoringSession } from './scoringSession'

/**
 * Dictated outs on the production field. Each button scores one sentence as
 * the model returns it, through the real reducer and `completeSentence`, and
 * posts what the field was given to draw — each picture with its wall-clock
 * start and end, and each runner motion as it starts — to `/timeline`.
 */
const F = { P: 10, C: 11, B1: 12, B2: 13, SS: 14, B3: 15, LF: 16 }
const RUNNER = 5
const BATTER = -1

interface Scenario {
  name: string
  said: string
  bases: { first?: number; second?: number }
  actions: ScoringAction[]
}
const grounder = (fielder: number): ScoringAction => ({
  type: 'ballInPlay',
  contact: 'swing',
  trajectory: 'ground_ball',
  fielder
})
const thrownOut: ScoringAction = {
  type: 'result',
  eventType: 'field_out',
  outBy: 'throw'
}
const relay = [
  { id: F.B3, point: { x: -20, z: -35 } },
  { id: F.B2, point: { ...BASES[2] } },
  { id: F.B1, point: { ...BASES[1] } }
]
const SCENARIOS: Scenario[] = [
  {
    name: 'E1',
    said: 'Ground ball to short, throws him out at first.',
    bases: {},
    actions: [grounder(F.SS), thrownOut]
  },
  {
    name: 'E2',
    said: 'Six four three double play.',
    bases: { first: RUNNER },
    actions: [grounder(F.SS), thrownOut]
  },
  {
    name: 'E3',
    said: 'Fly ball to left, caught, and the throw to second doubles off the runner.',
    bases: { first: RUNNER },
    actions: [
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'fly_ball',
        fielder: F.LF
      },
      { type: 'result', eventType: 'field_out', outBy: 'catch' },
      {
        type: 'runnerMovement',
        runner: RUNNER,
        to: '2B',
        out: true,
        fielders: [F.LF, F.SS]
      }
    ]
  },
  {
    name: 'E4',
    said: 'Grounder to first, tosses it to the pitcher for the out at first.',
    bases: {},
    actions: [grounder(F.B1), thrownOut]
  },
  {
    name: 'E5',
    said: "Fielder's choice. Ground ball to third, the throw to second gets the runner.",
    bases: { first: RUNNER },
    actions: [
      grounder(F.B3),
      { type: 'result', eventType: 'fielders_choice' },
      {
        type: 'runnerMovement',
        runner: RUNNER,
        to: '2B',
        out: true,
        fielders: [F.B3, F.B2]
      },
      { type: 'runnerMovement', runner: BATTER, to: '1B' }
    ]
  },
  {
    name: 'E6',
    said: "Fielder's choice. Ground ball to third.",
    bases: { first: RUNNER },
    actions: [
      grounder(F.B3),
      { type: 'result', eventType: 'fielders_choice' },
      {
        type: 'runnerMovement',
        runner: BATTER,
        to: '1B',
        fielders: relay.map(hop => hop.id),
        locations: relay.map(hop => hop.point)
      },
      { type: 'runnerMovement', runner: RUNNER, to: '2B' }
    ]
  },
  {
    name: 'E7',
    said: 'Runner caught stealing second, catcher to short.',
    bases: { first: RUNNER },
    actions: [
      {
        type: 'baseRunning',
        kind: 'caught_stealing',
        runner: RUNNER,
        to: '2B',
        fielders: [F.C, F.SS]
      }
    ]
  },
  {
    name: 'E8',
    said: 'Caught stealing third, the third baseman takes it himself.',
    bases: { second: RUNNER },
    actions: [
      {
        type: 'baseRunning',
        kind: 'caught_stealing',
        runner: RUNNER,
        to: '3B',
        fielders: [F.B3]
      }
    ]
  }
]

function fresh(bases: Scenario['bases']): ScoringState {
  // The unit tests' game: the visitors bat 1 to 9, the home team fields 10
  // P, 11 C, 12 1B, 13 2B, 14 SS, 15 3B, 16 LF, 17 CF, 18 RF.
  const state = initialScoringState(
    scoringSession(
      asGameDetail({
        nonMemberView: false,
        id: 'dictated-outs',
        awayTeamId: 'away',
        homeTeamId: 'home',
        awayTeamName: 'Silver Rockets',
        homeTeamName: 'Copper Comets',
        seasonId: null,
        startAt: null,
        venue: null,
        status: 'scheduled',
        homeScore: null,
        awayScore: null,
        ingestStatus: 'pending',
        ingestMessage: null,
        canScore: true,
        videos: []
      })
    ),
    true
  )
  const offense = state.session.liveData.linescore.offense
  if (bases.first != null) offense.first = playerRef(state.session, bases.first)
  if (bases.second != null)
    offense.second = playerRef(state.session, bases.second)
  return state
}
/** The sentence's actions, with the batter's id in place of `BATTER`. */
function said(state: ScoringState, scenario: Scenario): ScoringAction[] {
  const batter = state.session.liveData.plays.currentPlay!.matchup.batter.id
  return scenario.actions.map(action =>
    'runner' in action && action.runner === BATTER
      ? { ...action, runner: batter }
      : action
  )
}
const now = (): number => performance.timeOrigin + performance.now()
const ground = (point: { x: number; z: number }): { x: number; z: number } => ({
  x: Math.round(point.x * 1000) / 1000,
  z: Math.round(point.z * 1000) / 1000
})

interface Entry {
  type: 'picture' | 'motion'
  at: number
  [key: string]: unknown
}

function Preview(): React.ReactElement {
  const [state, setState] = useState(() => fresh({}))
  const [name, setName] = useState('Ready')
  const timeline = useRef<Entry[]>([])
  const seen = useRef(new Set<string>())
  const picture = useRef<Entry | null>(null)
  const previous = useRef<FieldPlayer[]>([])
  // As the scoring screen does: a runner already moving keeps his place.
  const players = useMemo(() => {
    const next = scoringFieldPlayers(state, previous.current)
    previous.current = next
    return next
  }, [state])
  const dispatch = (event: ScoringEvent): void => {
    setState(s => scoringReducer(s, event))
  }
  const finished = name !== 'Ready' && atRest(state)
  const sequence = state.presentation
  useEffect(() => {
    if (picture.current != null && picture.current.id !== sequence?.id) {
      picture.current.end = now()
      picture.current = null
    }
    if (sequence != null && picture.current == null) {
      picture.current = {
        type: 'picture',
        at: now(),
        id: sequence.id,
        kind: sequence.kind,
        stage: sequence.stage,
        durationMs: sequence.durationMs,
        ...(sequence.kind === 'throw'
          ? {
              thrower: sequence.thrower,
              receiver: sequence.receiver,
              runner: sequence.runner,
              to: ground(sequence.to),
              runnerFrom: ground(sequence.runnerFrom),
              unassisted: sequence.unassisted,
              safe: sequence.safe === true
            }
          : {})
      }
      timeline.current.push(picture.current)
    }
    for (const motion of state.motions)
      if (
        motion.held !== true &&
        !motion.complete &&
        !seen.current.has(motion.id)
      ) {
        seen.current.add(motion.id)
        timeline.current.push({
          type: 'motion',
          at: now(),
          playerId: motion.playerId,
          first: ground(motion.waypoints[0]),
          last: ground(motion.waypoints.at(-1)!)
        })
      }
  }, [sequence, state.motions])
  const { session } = state
  useEffect(() => {
    if (!finished) return
    fetch('/timeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        outs: session.liveData.linescore.outs,
        bases: Object.fromEntries(
          (['first', 'second', 'third'] as const).map(key => [
            key,
            session.liveData.linescore.offense[key]?.id ?? null
          ])
        ),
        timeline: timeline.current
      })
    }).catch(() => undefined)
  }, [finished, name, session])
  const play = (scenario: Scenario): void => {
    timeline.current = []
    seen.current = new Set()
    picture.current = null
    previous.current = []
    const before = fresh(scenario.bases)
    setName(scenario.name)
    setState(
      scoringReducer(before, {
        type: 'DICTATED',
        transcript: scenario.said,
        actions: said(before, scenario)
      })
    )
  }
  const status = `${name} — ${finished ? 'Complete' : 'Animating'}`
  return (
    <View style={{ flex: 1 }}>
      <View
        style={{
          position: 'absolute',
          top: 70,
          left: 8,
          right: 60,
          zIndex: 100,
          padding: 8,
          backgroundColor: 'white',
          gap: 6
        }}
      >
        <Text accessibilityLabel={status}>
          {status} · {state.session.liveData.linescore.outs} outs
        </Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
          {SCENARIOS.map(scenario => (
            <Pressable
              key={scenario.name}
              accessibilityRole="button"
              accessibilityLabel={`Play ${scenario.name}`}
              onPress={() => {
                play(scenario)
              }}
            >
              <Text>{scenario.name}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <BaseballScreen
        field={{
          players,
          scoreboard: scoreboardFor(state.session),
          selected: '',
          onSelect: () => undefined,
          view: 'home',
          zoom: 1.25,
          presentation: state.presentation,
          onPresentationContact: (id, generation) => {
            dispatch({ type: 'PRESENTATION_CONTACT', id, generation })
          },
          onPresentationDone: (id, generation, stage) => {
            dispatch({ type: 'PRESENTATION_DONE', id, generation, stage })
          },
          onMovementComplete: (id, generation) => {
            dispatch({ type: 'MOTION_DONE', id, generation })
          }
        }}
        onMenu={() => undefined}
        onUndo={() => undefined}
        onPitch={() => undefined}
        canPitch={false}
        summary={`${state.session.liveData.linescore.outs} outs`}
      />
    </View>
  )
}
function Root(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <Preview />
      </ThemeProvider>
    </SafeAreaProvider>
  )
}
AppRegistry.registerComponent('DictatedOuts', () => Root)
AppRegistry.runApplication('DictatedOuts', {
  rootTag: document.getElementById('root')
})
