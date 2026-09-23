import React from 'react'
import { Text, View } from 'react-native'

import { useTheme } from '../theme/ThemeContext'
import {
  homeBackProposal,
  runnerDecisionError,
  runnerReasons
} from './runnerRules'
import { ScoringButton, ScoringError, ScoringSheet } from './ScoringSheet'
import type { ScoringEvent, ScoringState } from './scoringTypes'
export function RunnerControls({
  state,
  anchor,
  dispatch
}: {
  state: ScoringState
  anchor: { x: number; y: number } | null
  dispatch: (event: ScoringEvent) => void
}): React.ReactElement | null {
  const theme = useTheme()
  const action = state.runnerAction
  if (state.phase === 'runnerReason')
    return (
      <ScoringSheet
        title={action?.decision === 'safe' ? 'Runner advance' : 'Runner out'}
        onClose={() => {
          dispatch({ type: 'RUNNER_CANCEL' })
        }}
      >
        {runnerReasons(state).map(reason => (
          <ScoringButton
            row
            key={reason}
            label={reason}
            onPress={() => {
              dispatch({ type: 'RUNNER_REASON', reason })
            }}
          />
        ))}
      </ScoringSheet>
    )
  if (state.phase === 'chooseDefender')
    return (
      <View style={{ position: 'absolute', bottom: 130, alignSelf: 'center' }}>
        <ScoringButton
          label="Done"
          onPress={() => {
            dispatch({ type: 'DEFENDER', generation: state.generation })
          }}
        />
      </View>
    )
  const home = state.phase === 'homeDecision'
  if (!home && (state.phase !== 'runnerDecision' || action == null)) return null
  const id = home ? state.homeQueue[0] : action!.playerId
  const stationary = action?.from === action?.to
  const currentHold = !home && stationary && action?.origin === 'current'
  const error = home ? undefined : runnerDecisionError(state)
  return (
    <View
      accessibilityLabel={`${home ? 'Home plate' : 'Runner'} decision for ${state.session.gameData.players[id].fullName}`}
      style={
        home || anchor == null
          ? {
              position: 'absolute',
              bottom: 130,
              alignSelf: 'center',
              gap: 6,
              padding: 10,
              backgroundColor: theme.backgroundColor,
              borderRadius: 8
            }
          : {
              position: 'absolute',
              left: Math.max(8, anchor.x - 110),
              top: Math.max(90, anchor.y - 70),
              width: 220,
              gap: 6,
              padding: 8,
              backgroundColor: theme.backgroundColor,
              borderRadius: 8
            }
      }
    >
      <Text
        style={{
          color: theme.primaryTextColor,
          fontFamily: theme.regularTextFont,
          textAlign: 'center'
        }}
      >
        {state.session.gameData.players[id].fullName}
      </Text>
      <View
        style={{
          flexDirection: !home && stationary ? 'column' : 'row',
          gap: 8,
          justifyContent: 'center'
        }}
      >
        {!currentHold && (home || action!.to > 0) && (
          <ScoringButton
            label={!home && stationary ? 'Safe from Pickoff' : 'Safe'}
            color={theme.scoringSafeColor}
            disabled={error != null}
            onPress={() => {
              dispatch(
                home
                  ? { type: 'HOME', decision: 'safe' }
                  : { type: 'RUNNER_DECIDE', decision: 'safe' }
              )
            }}
          />
        )}
        <ScoringButton
          label="Out"
          color={theme.scoringOutColor}
          onPress={() => {
            dispatch(
              home
                ? { type: 'HOME', decision: 'out' }
                : { type: 'RUNNER_DECIDE', decision: 'out' }
            )
          }}
        />
        {home && homeBackProposal(state) != null && (
          <ScoringButton
            label="Back"
            onPress={() => {
              dispatch({ type: 'HOME', decision: 'back' })
            }}
          />
        )}
      </View>
      <ScoringError message={error} />
    </View>
  )
}
