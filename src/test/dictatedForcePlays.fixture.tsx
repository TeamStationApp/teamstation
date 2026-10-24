import React, { useEffect, useMemo, useRef, useState } from 'react'
import { AppRegistry, Pressable, Text, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { BaseballScreen } from '../app/field/BaseballScreen'
import type { FieldPlayer } from '../app/field/fieldModel'
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
 * Dictated force plays, the third out and the pitch before a ball in play,
 * on the production field. Each button scores one sentence as the model
 * returned it, through the real reducer, and posts to `/timeline` what the
 * field was given to draw — each picture with its wall-clock start and end —
 * with the outs, the half, the runs, the errors, the bases and the note the
 * sentence left. A status line shows the same, so frames show it too.
 *
 * It reads `wild` and the note optionally: run from the game as it was
 * before, it records the same scenarios without them.
 */
const F = { P: 10, C: 11, B1: 12, B2: 13, SS: 14, B3: 15, LF: 16 }
const FIRST = 5
const SECOND = 6
const THIRD = 7

interface Scenario {
  name: string
  said: string
  bases: { first?: number; second?: number; third?: number }
  outs: number
  actions: ScoringAction[]
}
const grounder = (fielder: number): ScoringAction => ({
  type: 'ballInPlay',
  contact: 'swing',
  trajectory: 'ground_ball',
  fielder
})
const overthrow: ScoringAction[] = [
  grounder(F.SS),
  {
    type: 'runnerMovement',
    runner: FIRST,
    to: '2B',
    out: true,
    reason: 'Force Out'
  },
  { type: 'result', eventType: 'field_error' },
  { type: 'fieldingPlay', fielders: [F.SS], error: F.SS, errorKind: 'throwing' }
]
const SCENARIOS: Scenario[] = [
  {
    name: 'F1',
    said: "Grounder to the shortstop, who tags second for fielder's choice.",
    bases: { first: FIRST },
    outs: 1,
    actions: [grounder(F.SS), { type: 'result', eventType: 'fielders_choice' }]
  },
  {
    name: 'F2',
    said: 'Grounder to third, and the third baseman takes third base for the out.',
    bases: { first: FIRST, second: SECOND },
    outs: 0,
    actions: [
      grounder(F.B3),
      { type: 'result', eventType: 'field_out', outBy: 'throw' }
    ]
  },
  {
    name: 'F3',
    said: 'Grounder to the shortstop, he tags second for the out, but overthrows first. For an error, and the batter is safe.',
    bases: { first: FIRST },
    outs: 0,
    actions: overthrow
  },
  {
    name: 'F4',
    said: 'Grounder to the shortstop, he tags second for the out, but overthrows first. For an error, and the batter is safe.',
    bases: { first: FIRST },
    outs: 2,
    actions: overthrow
  },
  {
    name: 'F5',
    said: "Pop fly to left field. And it's caught for the out, but the runner tags up and takes home.",
    bases: { second: SECOND, third: THIRD },
    outs: 2,
    actions: [
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'popup',
        fielder: F.LF,
        direction: 'left'
      },
      { type: 'result', eventType: 'field_out', outBy: 'catch' },
      { type: 'runnerMovement', runner: THIRD, to: 'home' }
    ]
  },
  {
    name: 'F6',
    said: 'Line drive single to left.',
    bases: {},
    outs: 0,
    actions: [
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'line_drive',
        direction: 'left'
      },
      { type: 'result', eventType: 'single' }
    ]
  },
  {
    name: 'F7',
    said: 'Bunt down the third base line, and he beats it out for a single.',
    bases: {},
    outs: 0,
    actions: [
      { type: 'ballInPlay', contact: 'bunt', fielder: F.B3, direction: 'left' },
      { type: 'result', eventType: 'single' }
    ]
  }
]

function fresh(scenario?: Scenario): ScoringState {
  // The unit tests' game: the visitors bat 1 to 9, the home team fields 10
  // P, 11 C, 12 1B, 13 2B, 14 SS, 15 3B, 16 LF, 17 CF, 18 RF.
  const state = initialScoringState(
    scoringSession(
      asGameDetail({
        nonMemberView: false,
        id: 'dictated-force-plays',
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
  if (scenario == null) return state
  const line = state.session.liveData.linescore
  for (const key of ['first', 'second', 'third'] as const) {
    const id = scenario.bases[key]
    if (id != null) line.offense[key] = playerRef(state.session, id)
  }
  line.outs = scenario.outs
  return state
}
const now = (): number => performance.timeOrigin + performance.now()

interface Entry {
  type: 'picture'
  at: number
  [key: string]: unknown
}

function Preview(): React.ReactElement {
  const [state, setState] = useState(() => fresh())
  const [name, setName] = useState('Ready')
  const timeline = useRef<Entry[]>([])
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
        ...(sequence.kind === 'hit'
          ? {
              contactMs: sequence.contactMs,
              pitched: 'pitcher' in sequence && sequence.pitcher != null
            }
          : {}),
        ...(sequence.kind === 'throw'
          ? {
              thrower: sequence.thrower,
              receiver: sequence.receiver,
              runner: sequence.runner,
              unassisted: sequence.unassisted,
              safe: sequence.safe === true,
              wild: 'wild' in sequence && sequence.wild === true
            }
          : {})
      }
      timeline.current.push(picture.current)
    }
  }, [sequence])
  const { session } = state
  const line = session.liveData.linescore
  const dictation = state.dictation as { note?: string } | undefined
  const note = dictation?.note
  // A sentence the screen did not apply: what it asked, or why it refused.
  const unapplied =
    state.dictationQuestion != null
      ? `Asked: ${state.dictationQuestion.question}`
      : state.dictation?.problem != null
        ? `Refused: ${state.dictation.problem.message}`
        : undefined
  useEffect(() => {
    if (!finished) return
    fetch('/timeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        outs: line.outs,
        top: line.isTopInning,
        runs: line.teams.away.runs,
        errors: line.teams.home.errors,
        bases: Object.fromEntries(
          (['first', 'second', 'third'] as const).map(key => [
            key,
            line.offense[key]?.id ?? null
          ])
        ),
        note: note ?? null,
        unapplied: unapplied ?? null,
        timeline: timeline.current
      })
    }).catch(() => undefined)
  }, [finished, name, line, note, unapplied])
  const play = (scenario: Scenario): void => {
    timeline.current = []
    picture.current = null
    previous.current = []
    const before = fresh(scenario)
    setName(scenario.name)
    setState(
      scoringReducer(before, {
        type: 'DICTATED',
        transcript: scenario.said,
        actions: scenario.actions
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
        <Text accessibilityLabel={status}>{status}</Text>
        <Text>
          {line.isTopInning ? 'Top' : 'Bottom'} · {line.outs} outs · runs{' '}
          {line.teams.away.runs} · errors {line.teams.home.errors}
        </Text>
        <Text>{unapplied ?? note ?? 'Nothing left out'}</Text>
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
        summary={`${line.outs} outs`}
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
AppRegistry.registerComponent('DictatedForcePlays', () => Root)
AppRegistry.runApplication('DictatedForcePlays', {
  rootTag: document.getElementById('root')
})
