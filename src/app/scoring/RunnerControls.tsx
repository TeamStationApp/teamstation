import React from 'react'
import { Text, View } from 'react-native'

import { hasEligiblePitch, homeBackProposal } from '../../common/scoring/rules'
import { CancelAction } from '../components/CancelAction'
import type { BaseProjection } from '../field/fieldTypes'
import { lstrings } from '../locales/strings'
import { useTheme } from '../theme/ThemeContext'
import {
  hasCurrentRunnerPitch,
  runnerDecisionError,
  runnerReasons
} from './scoringFlow'
import { ScoringButton, ScoringError, ScoringSheet } from './ScoringSheet'
import type { ScoringEvent, ScoringState } from './scoringTypes'
export function RunnerControls({
  state,
  anchor,
  projection,
  dispatch
}: {
  state: ScoringState
  anchor: { x: number; y: number } | null
  projection?: BaseProjection
  dispatch: (event: ScoringEvent) => void
}): React.ReactElement | null {
  const theme = useTheme()
  const action = state.runnerAction
  if (state.phase === 'runnerErrorReuse')
    return (
      <ScoringSheet
        title="Was this the same error?"
        onClose={() => {
          dispatch({ type: 'RUNNER_CANCEL' })
        }}
      >
        <ScoringButton
          row
          label="Use previous error"
          onPress={() => {
            dispatch({ type: 'RUNNER_ERROR_REUSE', reuse: true })
          }}
        />
        <ScoringButton
          row
          label="Record another error"
          onPress={() => {
            dispatch({ type: 'RUNNER_ERROR_REUSE', reuse: false })
          }}
        />
      </ScoringSheet>
    )
  if (state.phase === 'runnerError' || state.phase === 'runnerPitchType')
    return (
      <View style={{ position: 'absolute', bottom: 130, alignSelf: 'center' }}>
        <CancelAction
          accessibilityLabel="Cancel"
          onPress={() => {
            dispatch({ type: 'RUNNER_CANCEL' })
          }}
        />
      </View>
    )
  if (state.phase === 'runnerPitch' && action?.reason === 'Passed Ball')
    return (
      <ScoringSheet
        title="Was the passed ball the previous pitch?"
        onClose={() => {
          dispatch({ type: 'RUNNER_CANCEL' })
        }}
      >
        <ScoringButton
          row
          label="YES"
          disabled={!hasCurrentRunnerPitch(state)}
          onPress={() => {
            dispatch({ type: 'RUNNER_PITCH', addBall: false })
          }}
        />
        <ScoringButton
          row
          label="NO"
          disabled={state.session.pending != null}
          onPress={() => {
            dispatch({ type: 'RUNNER_PITCH_NEW' })
          }}
        />
        {state.session.pending != null && (
          <ScoringError message="Finish the current play before adding another pitch." />
        )}
      </ScoringSheet>
    )
  if (state.phase === 'runnerPitch')
    return (
      <ScoringSheet
        title={action!.reason!}
        onClose={() => {
          dispatch({ type: 'RUNNER_CANCEL' })
        }}
      >
        <ScoringButton
          row
          label="Add a pitched ball to the count"
          disabled={state.session.pending != null}
          onPress={() => {
            dispatch({ type: 'RUNNER_PITCH', addBall: true })
          }}
        />
        <ScoringButton
          row
          label={`Use previous pitch as ${action!.reason!.toLowerCase()}`}
          disabled={!hasEligiblePitch(state.session)}
          onPress={() => {
            dispatch({ type: 'RUNNER_PITCH', addBall: false })
          }}
        />
        {!hasEligiblePitch(state.session) && (
          <ScoringError message="No previous ball or strike is available." />
        )}
        {state.session.pending != null && (
          <ScoringError message="Finish the current play before adding another pitch." />
        )}
      </ScoringSheet>
    )
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
  const home = state.phase === 'homeDecision'
  if (!home && (state.phase !== 'runnerDecision' || action == null)) return null
  const id = home ? state.session.homeQueue[0] : action!.playerId
  const stationary = action?.from === action?.to
  const currentHold = !home && stationary && action?.origin === 'current'
  const error = home ? undefined : runnerDecisionError(state)
  const base = home ? 0 : action!.to % 4
  const baseLabel = [
    lstrings.scoring_at_home,
    lstrings.scoring_at_first,
    lstrings.scoring_at_second,
    lstrings.scoring_at_third
  ][base]
  const point = projection?.bases[base] ?? anchor
  const vertical = base !== 2
  const width = vertical ? 130 : 220
  const tall =
    home && homeBackProposal(state.session) != null ? 254 : vertical ? 204 : 138
  const position =
    point == null
      ? undefined
      : {
          position: 'absolute' as const,
          left: Math.max(
            8,
            Math.min(
              (projection?.width ?? 10000) - width - 8,
              point.x +
                (base === 3 ? -width - 16 : base === 2 ? -width / 2 : 16)
            )
          ),
          top: Math.max(
            8,
            Math.min(
              (projection?.height ?? 10000) - 128 - tall,
              point.y - tall / 2
            )
          ),
          width,
          gap: 6,
          padding: 8,
          borderRadius: 8,
          backgroundColor: theme.backgroundColor
        }
  return (
    <View
      accessibilityLabel={`${home ? 'Home plate' : 'Runner'} decision for ${state.session.gameData.players[id].fullName}`}
      style={
        position ?? {
          position: 'absolute',
          bottom: 130,
          alignSelf: 'center',
          gap: 6,
          padding: 10,
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
          flexDirection: vertical ? 'column' : 'row',
          gap: 8,
          justifyContent: 'center'
        }}
      >
        {!currentHold && (home || action!.to > 0) && (
          <ScoringButton
            decision
            secondaryLabel={baseLabel}
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
          decision
          secondaryLabel={baseLabel}
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
        {home && homeBackProposal(state.session) != null && (
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
