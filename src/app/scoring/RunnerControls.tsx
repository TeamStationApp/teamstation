import React from 'react'
import { Pressable, Text, View } from 'react-native'

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
import { useScoringSheetTheme } from './scoringSheetTheme'
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
  const pickerTheme = useScoringSheetTheme()
  const action = state.runnerAction
  const choice = state.pendingPlay?.fieldersChoice
  if (state.phase === 'fieldersChoice' && choice?.choosingPutout != null) {
    const runner = state.session.gameData.players[choice.choosingPutout]
    const first = Math.max(0, ...choice.runners.map(move => move.putout ?? 0))
    return (
      <ScoringSheet
        fullScreen
        title={`Who put out ${runner.fullName}?`}
        onClose={() => {
          dispatch({ type: 'CHOICE_CANCEL', generation: state.generation })
        }}
      >
        {choice.route.slice(first).map((hop, offset) => {
          const index = first + offset
          const name = state.session.gameData.players[hop.id].fullName
          return (
            <Pressable
              key={index}
              accessibilityRole="button"
              accessibilityLabel={`Putout by ${name}, ${index === 0 ? 'fielded ball' : `catch ${index}`}`}
              style={{
                minHeight: 48,
                padding: 12,
                gap: 4,
                borderBottomWidth: 1,
                borderBottomColor: pickerTheme.defaultBorderColor
              }}
              onPress={() => {
                dispatch({
                  type: 'CHOICE_DECIDE',
                  id: runner.id,
                  decision: 'out',
                  putout: index,
                  generation: state.generation
                })
              }}
            >
              <Text
                style={{
                  color: pickerTheme.primaryTextColor,
                  fontFamily: pickerTheme.semiBoldTextFont
                }}
              >
                {name}
              </Text>
              <Text
                style={{
                  color: pickerTheme.secondaryTextColor,
                  fontFamily: pickerTheme.regularTextFont
                }}
              >
                {index === 0 ? 'Fielded the ball' : `Catch ${index}`}
              </Text>
            </Pressable>
          )
        })}
      </ScoringSheet>
    )
  }
  const choiceRunners =
    state.pendingPlay?.fieldersChoice?.runners.filter(
      move => move.decision == null
    ) ?? []
  const cardAnchors = choiceRunners.map(move => {
    const point = projection?.bases[move.to % 4]
    return point == null
      ? undefined
      : {
          left: Math.max(8, Math.min(projection!.width - 208, point.x - 100)),
          top: Math.max(8, point.y - 112)
        }
  })
  const overlappingCards = cardAnchors.some(
    (anchor, index) =>
      anchor != null &&
      cardAnchors
        .slice(index + 1)
        .some(
          other =>
            other != null &&
            Math.abs(anchor.left - other.left) < 208 &&
            Math.abs(anchor.top - other.top) < 120
        )
  )
  const narrowChoice = projection != null && projection.width < 480
  const compactChoice =
    projection != null &&
    (projection.height < 420 || projection.width < 700 || overlappingCards)
  if (state.phase === 'fieldersChoice')
    return (
      <View
        pointerEvents="box-none"
        style={
          projection == null || compactChoice
            ? {
                position: 'absolute',
                ...(compactChoice ? { top: 8 } : { bottom: 130 }),
                alignSelf: 'center',
                flexDirection: narrowChoice ? 'column' : 'row',
                gap: 8
              }
            : { position: 'absolute', inset: 0 }
        }
      >
        {choiceRunners.map(move => {
          const name = state.session.gameData.players[move.playerId].fullName
          const point = compactChoice
            ? undefined
            : projection?.bases[move.to % 4]
          return (
            <View
              key={move.playerId}
              accessibilityLabel={`Fielder's choice decision for ${name}`}
              style={{
                ...(point == null
                  ? {}
                  : {
                      position: 'absolute',
                      left: Math.max(
                        8,
                        Math.min(projection!.width - 208, point.x - 100)
                      ),
                      top: Math.max(8, point.y - 112)
                    }),
                width: compactChoice
                  ? Math.min(
                      200,
                      narrowChoice
                        ? projection.width - 32
                        : (projection.width -
                            32 -
                            8 * (choiceRunners.length - 1)) /
                            choiceRunners.length
                    )
                  : 200,
                padding: 8,
                gap: 6,
                borderRadius: 8,
                backgroundColor: theme.backgroundColor
              }}
            >
              <Text
                style={{
                  color: theme.primaryTextColor,
                  textAlign: 'center',
                  fontFamily: theme.regularTextFont
                }}
              >
                {name}
              </Text>
              <View
                style={{
                  flexDirection: 'row',
                  gap: 8,
                  justifyContent: 'center'
                }}
              >
                {(['safe', 'out'] as const).map(decision => (
                  <ScoringButton
                    key={decision}
                    label={`${decision === 'safe' ? 'Safe' : 'Out'} ${name}`}
                    text={decision === 'safe' ? 'Safe' : 'Out'}
                    color={
                      decision === 'safe'
                        ? theme.scoringSafeColor
                        : theme.scoringOutColor
                    }
                    onPress={() => {
                      dispatch({
                        type: 'CHOICE_DECIDE',
                        id: move.playerId,
                        decision,
                        generation: state.generation
                      })
                    }}
                  />
                ))}
              </View>
            </View>
          )
        })}
      </View>
    )
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
