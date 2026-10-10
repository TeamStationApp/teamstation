import { useEffect, useRef, useState } from 'react'

import { baseIds } from '../../common/scoring/rules'
import { moreEligibility } from './moreActions'
import { scoringReducer } from './scoringMachine'
import type { ScoringEvent, ScoringState } from './scoringTypes'
import { recentRunnerIds } from './tiebreaker'

type SetupMode = 'settings' | 'bases' | number

/** Owns transient selection; the scoring reducer owns every saved change. */
export function useTiebreakerSetup(
  state: ScoringState,
  allowed: boolean,
  dispatch: (event: ScoringEvent) => void
): {
  mode: SetupMode | undefined
  active: boolean
  problem?: string
  handleOpen: () => void
  handleClose: () => void
  handlePlace: () => void
  handleChooseBase: (base: number) => void
  handleChooseRunner: (id: number) => void
  handleSetOuts: (outs: number) => void
  handleBack: () => void
} {
  const [mode, setMode] = useState<SetupMode>()
  const [problem, setProblem] = useState<string>()
  const latest = useRef({ state, allowed, dispatch, mode })
  latest.current = { state, allowed, dispatch, mode }
  const eligible =
    allowed && moreEligibility(state, 'Place a Runner (Tiebreaker)') == null
  useEffect(() => {
    if (!eligible) {
      setMode(undefined)
      setProblem(undefined)
    }
  }, [eligible])
  const valid = (): boolean => {
    const current = latest.current
    return (
      current.allowed &&
      moreEligibility(current.state, 'Place a Runner (Tiebreaker)') == null
    )
  }
  const move = (next: SetupMode | undefined): void => {
    setProblem(undefined)
    setMode(next)
  }
  return {
    mode: eligible ? mode : undefined,
    active: eligible && mode != null,
    problem,
    handleOpen: () => {
      if (valid()) move('settings')
    },
    handleClose: () => {
      move(undefined)
    },
    handlePlace: () => {
      if (valid()) move('bases')
    },
    handleBack: () => {
      if (valid()) move('bases')
    },
    handleChooseBase: base => {
      if (!valid() || latest.current.mode !== 'bases') return
      if (
        ![1, 2, 3].includes(base) ||
        baseIds(latest.current.state.session)[base - 1] != null
      )
        return
      move(base)
    },
    handleChooseRunner: id => {
      const current = latest.current
      if (!valid() || typeof current.mode !== 'number') return
      if (!recentRunnerIds(current.state.session).includes(id)) {
        setProblem('This player is no longer available. Choose another runner.')
        return
      }
      const event: ScoringEvent = {
        type: 'MORE',
        input: {
          action: 'Place a Runner (Tiebreaker)',
          base: current.mode,
          playerId: id
        }
      }
      // The same reducer validates the latest state before showing success.
      const next = scoringReducer(current.state, event)
      if (next.log.length === current.state.log.length) {
        setProblem(
          'Unable to place this runner. Choose an empty base and try again.'
        )
        return
      }
      current.dispatch(event)
      move('settings')
    },
    handleSetOuts: outs => {
      if (valid() && latest.current.mode === 'settings')
        latest.current.dispatch({ type: 'TIEBREAKER_OUTS', outs })
    }
  }
}
