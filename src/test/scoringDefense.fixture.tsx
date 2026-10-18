import React, { useState } from 'react'
import { AppRegistry, Pressable, Text, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { BaseballScreen } from '../app/field/BaseballScreen'
import { createDevelopmentSession } from '../app/scoring/developmentSession'
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

/** Renderer acceptance fixture. The interpreter integration supplies its real
 * action output at /cases; all scoring and animation below is production code.
 */
function fresh(runner = false): ScoringState {
  const state = initialScoringState(
    createDevelopmentSession(
      asGameDetail({
        nonMemberView: false,
        id: 'defense-preview',
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
      }),
      [],
      []
    ),
    true
  )
  if (runner)
    state.session.liveData.linescore.offense.first = playerRef(state.session, 5)
  return state
}
function Preview(): React.ReactElement {
  const [state, setState] = useState(() => fresh(true))
  const [label, setLabel] = useState('Ready')
  const dispatch = (event: ScoringEvent): void => {
    setState(s => scoringReducer(s, event))
  }
  const play = async (index: number): Promise<void> => {
    const cases = (await (await fetch('/cases')).json()) as Array<{
      said: string
      actions: ScoringAction[]
    }>
    const example = cases[index]
    setLabel(example.said)
    setState(
      scoringReducer(fresh(index === 0), {
        type: 'DICTATED',
        transcript: example.said,
        actions: example.actions
      })
    )
  }
  const finished = atRest(state)
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
        <Text
          accessibilityLabel={`${label} — ${finished ? 'Complete' : 'Animating'}`}
        >
          {label} — {finished ? 'Complete' : 'Animating'}
        </Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-around' }}>
          {['6-4-3', '3-1', 'Pickoff'].map((name, index) => (
            <Pressable
              key={name}
              accessibilityRole="button"
              accessibilityLabel={`Play ${name}`}
              onPress={() => {
                if (index < 2)
                  play(index).catch((error: unknown) => {
                    setLabel(String(error))
                  })
                else {
                  const before = fresh(true)
                  setLabel('Failed pickoff')
                  setState(
                    scoringReducer(before, {
                      type: 'RUNNER_DROP',
                      id: 5,
                      to: 1,
                      decision: 'safe',
                      generation: before.generation
                    })
                  )
                }
              }}
            >
              <Text>{name}</Text>
            </Pressable>
          ))}
        </View>
      </View>
      <BaseballScreen
        field={{
          players: scoringFieldPlayers(state),
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
        onUndo={() => {
          dispatch({ type: 'UNDO' })
        }}
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
AppRegistry.registerComponent('ScoringDefense', () => Root)
AppRegistry.runApplication('ScoringDefense', {
  rootTag: document.getElementById('root')
})
