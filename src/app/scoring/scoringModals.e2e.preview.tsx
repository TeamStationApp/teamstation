import React, { useState } from 'react'
import { Pressable, Text, View } from 'react-native'
import { SafeAreaProvider } from 'react-native-safe-area-context'

import { asGameDetail } from '../../common/api'
import { completeMotions } from '../../test/scoringHelpers'
import { scoringSession } from '../../test/scoringSession'
import { ThemeProvider, useTheme } from '../theme/ThemeContext'
import { ErrorCreditSheet } from './ErrorCreditSheet'
import { RunnerControls } from './RunnerControls'
import { initialScoringState, scoringReducer } from './scoringMachine'
import type { ScoringEvent, ScoringState } from './scoringTypes'

/** Controlled renderer fixtures supplement gestures blocked on the base branch. */
export function modalRendererFixture(kind: string): ScoringState {
  const session = scoringSession(
    asGameDetail({
      nonMemberView: false,
      id: 'modal-preview',
      awayTeamId: 'away',
      homeTeamId: 'home',
      awayTeamName: 'Owls',
      homeTeamName: 'Hawks',
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
  )
  for (const player of Object.values(session.gameData.players))
    player.fullName = player.id === 2 ? 'Mike Trout' : 'Mookie Betts'
  let state = initialScoringState(session)
  const step = (event: ScoringEvent): void => {
    state = completeMotions(scoringReducer(state, event))
  }
  if (kind === 'error-credit') {
    step({ type: 'OUTCOME', outcome: 'Error' })
    step({
      type: 'FIELDER',
      id: 10,
      point: { x: 0, z: -25 },
      generation: state.generation
    })
    step({ type: 'TRAJECTORY', angle: 25, generation: state.generation })
    step({
      type: 'THROWER',
      id: 10,
      point: { x: 0, z: -25 },
      generation: state.generation
    })
    step({ type: 'DEFENDER', generation: state.generation })
  } else {
    step({
      type: 'MORE',
      input: { action: 'Place a Runner (Tiebreaker)', playerId: 2, base: 1 }
    })
    step({
      type: 'RUNNER_DROP',
      id: 2,
      to: 2,
      decision: kind === 'runner-advance' ? 'safe' : 'out',
      generation: state.generation
    })
  }
  return state
}

function Preview(): React.ReactElement {
  const theme = useTheme()
  const [state, setState] = useState<ScoringState>()
  const dispatch = (event: ScoringEvent): void => {
    if (event.type === 'RUNNER_CANCEL' || event.type === 'ERROR_CANCEL')
      setState(undefined)
    else
      setState(previous =>
        previous == null
          ? previous
          : completeMotions(scoringReducer(previous, event))
      )
  }
  return (
    <View
      style={{
        flex: 1,
        justifyContent: 'center',
        gap: 16,
        padding: 24,
        backgroundColor: theme.backgroundColor
      }}
    >
      <Text style={{ color: theme.primaryTextColor }}>
        Controlled scoring modal fixtures
      </Text>
      {['runner-advance', 'runner-out', 'error-credit'].map(kind => (
        <Pressable
          key={kind}
          accessibilityRole="button"
          accessibilityLabel={`Preview ${kind}`}
          onPress={() => {
            setState(modalRendererFixture(kind))
          }}
          style={{ padding: 12 }}
        >
          <Text
            style={{ color: theme.primaryTextColor }}
          >{`Preview ${kind}`}</Text>
        </Pressable>
      ))}
      {state != null && (
        <>
          {state.phase !== 'runnerReason' && state.phase !== 'errorCredit' && (
            <Text style={{ color: theme.primaryTextColor }}>
              Fixture event saved
            </Text>
          )}
          <RunnerControls state={state} anchor={null} dispatch={dispatch} />
          <ErrorCreditSheet state={state} dispatch={dispatch} />
        </>
      )}
    </View>
  )
}

export function Root(): React.ReactElement {
  return (
    <SafeAreaProvider>
      <ThemeProvider>
        <Preview />
      </ThemeProvider>
    </SafeAreaProvider>
  )
}
