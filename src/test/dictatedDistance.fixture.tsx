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
import * as presentation from '../app/scoring/scoringPresentation'
import { scoreboardFor } from '../app/scoring/scoringSelectors'
import type { ScoringEvent, ScoringState } from '../app/scoring/scoringTypes'
import { ThemeProvider } from '../app/theme/ThemeContext'
import { asGameDetail } from '../common/api'
import type { ScoringAction } from '../common/scoring/actions'
import { fieldInfoOf } from '../common/scoring/state'
import { scoringSession } from './scoringSession'

/**
 * Where dictated balls and pitches went, on the production field. Each
 * button scores what the live interpreter said of a sentence (served at
 * `/scenarios`) through the real reducer and `completeSentence`, at a 200 ft
 * fence, and posts each picture — when it started, when its ball came down
 * and where — and what the play stored, to `/timeline`. It reads only fields
 * the scoring screen has always had, or reads new ones optionally, so the
 * same fixture shows the game as it was before.
 */
interface Scenario {
  name: string
  said: string
  actions: ScoringAction[]
}

function fresh(): ScoringState {
  // The unit tests' game: the visitors bat 1 to 9, the home team fields 10
  // P, 11 C, 12 1B, 13 2B, 14 SS, 15 3B, 16 LF, 17 CF, 18 RF.
  const state = initialScoringState(
    scoringSession(
      asGameDetail({
        nonMemberView: false,
        id: 'dictated-distance',
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
  state.session.gameData.venue = { fieldInfo: fieldInfoOf(200) }
  return state
}
const now = (): number => performance.timeOrigin + performance.now()
const ground = (point: { x: number; z: number }): { x: number; z: number } => ({
  x: Math.round(point.x * 1000) / 1000,
  z: Math.round(point.z * 1000) / 1000
})
/** When a picture's ball comes down, from its start, in milliseconds. */
function landsAt(sequence: NonNullable<ScoringState['presentation']>): number {
  if (sequence.kind === 'hit') return sequence.flightEndMs
  if (sequence.kind === 'pitch') {
    const foul = (sequence as { foul?: { x: number; z: number } }).foul
    // The screen's own flight for a placed foul (read optionally: the game
    // before had none).
    const flight = (
      presentation as {
        foulFlightMs?: (point: { x: number; z: number }) => number
      }
    ).foulFlightMs
    return foul == null || flight == null
      ? presentation.PITCH_TIMING.plate + 400
      : presentation.PITCH_TIMING.plate + flight(foul)
  }
  return sequence.durationMs
}

interface Entry {
  at: number
  [key: string]: unknown
}

function Preview(): React.ReactElement {
  const [scenarios, setScenarios] = useState<Scenario[]>([])
  const [state, setState] = useState(fresh)
  const [name, setName] = useState('Ready')
  const timeline = useRef<Entry[]>([])
  const picture = useRef<Entry | null>(null)
  const previous = useRef<FieldPlayer[]>([])
  useEffect(() => {
    fetch('/scenarios')
      .then(async response => await response.json())
      .then(setScenarios)
      .catch(() => undefined)
  }, [])
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
    if (sequence == null || picture.current != null) return
    const extra = sequence as {
      arc?: { target: { x: number; z: number }; landingHeight?: number }
      carom?: { x: number; z: number }
      foul?: { x: number; z: number }
    }
    picture.current = {
      at: now(),
      id: sequence.id,
      kind: sequence.kind,
      stage: sequence.stage,
      durationMs: sequence.durationMs,
      landsMs: landsAt(sequence),
      ...(extra.arc == null
        ? {}
        : {
            lands: ground(extra.arc.target),
            landingHeight: extra.arc.landingHeight ?? null
          }),
      ...(extra.carom == null ? {} : { carom: ground(extra.carom) }),
      ...(extra.foul == null ? {} : { foul: ground(extra.foul) })
    }
    timeline.current.push(picture.current)
  }, [sequence])
  const { session } = state
  useEffect(() => {
    if (!finished) return
    const plays = [
      ...session.liveData.plays.allPlays,
      ...(session.liveData.plays.currentPlay == null
        ? []
        : [session.liveData.plays.currentPlay])
    ]
    const hit = plays.findLast(play => play.hitData?.coordinates != null)
    const pitches = plays
      .flatMap(play => play.playEvents)
      .filter(event => event.isPitch)
    fetch('/timeline', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name,
        outs: session.liveData.linescore.outs,
        count: {
          balls: session.liveData.linescore.balls,
          strikes: session.liveData.linescore.strikes
        },
        stored: {
          coordinates: hit?.hitData?.coordinates ?? null,
          pitches: pitches.map(event => ({
            call: event.details.code,
            type: (event.details as { type?: unknown }).type ?? null,
            pitchData: event.pitchData ?? null
          }))
        },
        timeline: timeline.current
      })
    }).catch(() => undefined)
  }, [finished, name, session])
  const play = (scenario: Scenario): void => {
    timeline.current = []
    picture.current = null
    previous.current = []
    setName(scenario.name)
    setState(
      scoringReducer(fresh(), {
        type: 'DICTATED',
        transcript: scenario.said,
        actions: scenario.actions
      })
    )
  }
  const status = `${name} — ${finished ? 'Complete' : 'Animating'}`
  return (
    <View style={{ flex: 1 }}>
      <BaseballScreen
        field={{
          players,
          scoreboard: scoreboardFor(state.session),
          selected: '',
          onSelect: () => undefined,
          // From behind the plate: the whole field to the fence is on screen.
          view: 'home',
          zoom: 1,
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
      <View
        style={{
          position: 'absolute',
          // Over the scoreboard, clear of the field.
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
        <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
          {scenarios.map(scenario => (
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
AppRegistry.registerComponent('DictatedDistance', () => Root)
AppRegistry.runApplication('DictatedDistance', {
  rootTag: document.getElementById('root')
})
