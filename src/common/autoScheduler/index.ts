import {
  blockingCause,
  capacityCause,
  type GameKind,
  requiredCause
} from './capacity'
import { buildContext, type SeasonContext } from './context'
import { requiredLines, runMatchups, settleTargets, unmetLines } from './counts'
import {
  chooseOptions,
  fairnessRows,
  optionReasons,
  plannedGames,
  SEEDS,
  WEIGHTINGS
} from './options'
import { place, type Placement } from './placement'
import { nthSeed } from './random'
import type { EngineInput, EngineResult, ScheduleOption } from './types'

/** A score as stored: rounded, so the JSON reads cleanly and compares stably. */
function storedScore(score: readonly number[]): number[] {
  return score.map(value => Math.round(value * 1e6) / 1e6)
}

/**
 * The Auto-Scheduler: up to three schedule options for the run, the
 * recommended one first, or the blocking reason when no new game fits at
 * all. Pure and deterministic: the same input gives the same result.
 *
 * It settles the counts every option is built at (equal for every team,
 * lowered only as far as the field time requires), searches from six seeds
 * under three weightings, and keeps the best and the next best that differ
 * enough from it. Given `required` matchups, it places exactly those
 * instead, with no lowering, and reports any it couldn't place.
 */
export function buildOptions(input: EngineInput): EngineResult {
  const context = buildContext(input)
  const blocking = blockingCause(context)
  if (blocking != null) return { options: [], blocking }

  const settled = settleTargets(context, input.seed)
  const candidates: Placement[] = []
  for (let k = 0; k < SEEDS; k++) {
    const seed = nthSeed(input.seed, k)
    const matchups =
      k === 0
        ? settled.placement.matchups
        : runMatchups(context, settled.targets, seed)
    WEIGHTINGS.forEach((order, w) => {
      candidates.push(
        k === 0 && w === 0
          ? settled.placement
          : place(context, matchups, nthSeed(seed, w), order)
      )
    })
  }

  const causes = new Map<string, string>()
  const causeOf = (
    season: SeasonContext,
    kind: GameKind,
    requested: number
  ): string => {
    const key = `${season.season.id}|${kind}`
    let cause = causes.get(key)
    if (cause == null) {
      cause = capacityCause(context, season, kind, requested)
      causes.set(key, cause)
    }
    return cause
  }

  const chosen = chooseOptions(candidates)
  const [best] = chosen
  const options = chosen.map((placement): ScheduleOption => ({
    games: plannedGames(placement),
    fairness: fairnessRows(context, placement),
    reasons: placement === best ? [] : optionReasons(context, placement, best),
    unmet:
      context.required == null
        ? unmetLines(context, settled.targets, placement, causeOf)
        : requiredLines(context, placement, (season, unplaced) =>
            requiredCause(context, season, unplaced)
          ),
    score: storedScore(placement.score)
  }))
  return { options, blocking: null }
}
