import React, { useEffect, useMemo, useRef, useState } from 'react'
import { Pressable, Text, View } from 'react-native'

import {
  type PriorRunner,
  priorRunners,
  returnPriorRunner
} from '../../common/scoring/priorRunner'
import type { ScoringSession } from '../../common/scoring/session'
import type { GameState } from '../../common/scoring/state'
import { Button } from '../components/Button'
import { CancelAction } from '../components/CancelAction'
import type { FieldPlayer } from '../field/fieldModel'
import { useInsets } from '../platform/safeArea'
import { useTheme } from '../theme/ThemeContext'
import { homeQueuePoint } from './scoringMotion'
import { ScoringSheet } from './ScoringSheet'
import type { ScoringEvent, ScoringState } from './scoringTypes'

export function usePriorRunnerCorrection(
  game: ScoringSession,
  state: ScoringState,
  enabled: boolean,
  identity: string,
  dispatch: (event: ScoringEvent) => void
): {
  candidates: PriorRunner[]
  drop: (runner: number, to: number) => boolean
  overlay: React.ReactElement
} {
  const context = { game, state, enabled, identity }
  const live = useRef<typeof context | null>(context)
  live.current = context
  const [proposal, setProposal] = useState<{
    context: typeof context
    runner: PriorRunner
  } | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const candidates = useMemo(
    () =>
      enabled && state.phase === 'ready' ? priorRunners(state.session) : [],
    [enabled, state.phase, state.session]
  )
  useEffect(
    () => () => {
      live.current = null
    },
    []
  )
  useEffect(() => {
    setProposal(null)
    setNotice(null)
  }, [game, enabled, identity])
  useEffect(() => {
    if (notice == null) return
    const timer = setTimeout(() => {
      setNotice(null)
    }, 5000)
    return () => {
      clearTimeout(timer)
    }
  }, [notice])
  const valid = (held: typeof context): boolean => {
    const now = live.current
    return (
      now != null &&
      now.enabled &&
      !now.game.readOnly &&
      now.game === held.game &&
      now.identity === held.identity &&
      now.state.phase === 'ready' &&
      now.state.session === held.state.session &&
      now.state.log === held.state.log &&
      JSON.stringify(now.game.actions) === JSON.stringify(held.state.log) &&
      now.state.generation === held.state.generation
    )
  }
  const commit = (held: typeof context, runner: PriorRunner): void => {
    setProposal(null)
    if (!valid(held)) return
    const corrected = returnPriorRunner(
      game.opening,
      held.state.log,
      held.state.session,
      runner.runner,
      runner.to
    )
    if (
      corrected == null ||
      game.sync(corrected.log, corrected.retainedEvents, true).length > 0
    )
      return
    dispatch({ type: 'RESET', session: game.state, log: corrected.log })
    setNotice(
      `Runner did not advance on prior play. Sent back to ${['', '1st', '2nd', '3rd'][runner.to]}.`
    )
  }
  return {
    candidates,
    drop(runner: number, to: number): boolean {
      const candidate = candidates.find(
        item => item.runner === runner && item.to === to
      )
      if (candidate == null) return false
      if (
        state.session.liveData.plays.currentPlay?.playEvents.some(
          event => event.isPitch
        ) === true
      )
        setProposal({ context, runner: candidate })
      else commit(context, candidate)
      return true
    },
    overlay: (
      <PriorRunnerOverlay
        notice={notice}
        dismiss={() => {
          setNotice(null)
        }}
        confirm={
          proposal != null && valid(proposal.context)
            ? () => {
                commit(proposal.context, proposal.runner)
              }
            : undefined
        }
        cancel={() => {
          setProposal(null)
        }}
      />
    )
  }
}

export function PriorRunnerOverlay({
  notice,
  dismiss,
  confirm,
  cancel
}: {
  notice: string | null
  dismiss: () => void
  confirm?: () => void
  cancel: () => void
}): React.ReactElement {
  const theme = useTheme()
  const insets = useInsets()
  return (
    <>
      {notice != null && (
        <View
          pointerEvents="box-none"
          style={{
            position: 'absolute',
            top: insets.top + 8,
            left: 12,
            right: 12,
            zIndex: 20
          }}
        >
          <Pressable
            accessibilityRole="alert"
            accessibilityLabel={notice}
            onPress={dismiss}
            style={{
              backgroundColor: '#FFD54F',
              borderRadius: 10,
              paddingHorizontal: 12,
              paddingVertical: 9
            }}
          >
            <Text
              style={{
                color: '#212121',
                fontFamily: theme.regularTextFont,
                fontSize: 14
              }}
            >
              {notice}
            </Text>
          </Pressable>
        </View>
      )}
      {confirm != null && (
        <ScoringSheet title="Correct prior play" headerless onClose={cancel}>
          <View
            style={{
              gap: theme.rem(1),
              paddingHorizontal: theme.rem(1),
              paddingBottom: theme.rem(1)
            }}
          >
            <Text
              accessibilityRole="header"
              style={{
                textAlign: 'left',
                fontFamily: theme.semiBoldTextFont,
                fontSize: theme.rem(1.125),
                lineHeight: theme.rem(1.5),
                color: theme.scoringSurface.text
              }}
            >
              Pitch events have occurred since the runner advanced. Are you sure
              you want to send back the runner from the prior play?
            </Text>
            <Button
              label="Yes, send back runner"
              accessibilityLabel="Yes, send back runner"
              style={{ alignSelf: 'center', maxWidth: '100%' }}
              onPress={confirm}
            />
            <CancelAction accessibilityLabel="Cancel" onPress={cancel} />
          </View>
        </ScoringSheet>
      )}
    </>
  )
}

/** Scoring-only handles for runners who have already crossed home. */
export function priorRunnerPlayers(
  players: FieldPlayer[],
  candidates: PriorRunner[],
  state: GameState
): FieldPlayer[] {
  return [
    ...players,
    ...candidates
      .filter(item => item.from === 4)
      .map((item, index) => {
        const person = state.gameData.players[item.runner]
        // Separate the return handle from the current batter beside the plate.
        const position = homeQueuePoint(index + 15)
        return {
          id: `offense-${item.runner}`,
          playerId: item.runner,
          label: 'Runner',
          name: person.fullName,
          displayName: person.fullName,
          jersey: person.jersey,
          team: 'runner' as const,
          uniformSide:
            person.teamId === state.gameData.teams.home.id
              ? ('home' as const)
              : ('away' as const),
          position,
          target: { ...position },
          runnerBase: 4,
          speed: 0,
          heading: 0,
          stride: 0
        }
      })
  ]
}
