import {
  blockingCause,
  capacityCause,
  type GameKind,
  managerCauseOfOption,
  requiredCause
} from './capacity'
import { buildContextSteps, type SeasonContext } from './context'
import {
  requiredLines,
  runMatchups,
  settleTargetsSteps,
  unmetLines
} from './counts'
import {
  chooseOptions,
  fairnessRows,
  optionReasons,
  plannedGames,
  SEEDS,
  WEIGHTINGS
} from './options'
import { type Placement, placeSteps } from './placement'
import { nthSeed } from './random'
import { finishSteps, finishStepsAsync } from './steps'
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
  return finishSteps(buildOptionsSteps(input))
}

/** The same deterministic search, yielding during context and placement work. */
export async function buildOptionsAsync(
  input: EngineInput
): Promise<EngineResult> {
  return await finishStepsAsync(buildOptionsSteps(input))
}

function* buildOptionsSteps(input: EngineInput): Generator<void, EngineResult> {
  const context = yield* buildContextSteps(input)
  const blocking = blockingCause(context)
  if (blocking != null) return { options: [], blocking }

  const settled = yield* settleTargetsSteps(context, input.seed)
  const candidates: Placement[] = []
  for (let k = 0; k < SEEDS; k++) {
    const seed = nthSeed(input.seed, k)
    const matchups =
      k === 0
        ? settled.placement.matchups
        : runMatchups(context, settled.targets, seed)
    for (const [w, order] of WEIGHTINGS.entries()) {
      candidates.push(
        k === 0 && w === 0
          ? settled.placement
          : yield* placeSteps(context, matchups, nthSeed(seed, w), order)
      )
    }
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
      cause =
        settled.reducedManagerCauses.get(key) ??
        capacityCause(context, season, kind, requested)
      causes.set(key, cause)
    }
    return cause
  }

  const chosen = chooseOptions(candidates)
  const [best] = chosen
  const options = chosen.map((placement): ScheduleOption => {
    const placedCause = managerCauseOfOption(context, placement)
    return {
      games: plannedGames(placement),
      fairness: fairnessRows(context, placement),
      reasons:
        placement === best ? [] : optionReasons(context, placement, best),
      unmet:
        context.required == null
          ? unmetLines(
              context,
              settled.targets,
              placement,
              (season, kind, requested, unplaced) =>
                placedCause(season, unplaced) ??
                causeOf(season, kind, requested)
            )
          : requiredLines(
              context,
              placement,
              (season, unplaced) =>
                placedCause(season, unplaced) ??
                requiredCause(context, season, unplaced)
            ),
      score: storedScore(placement.score)
    }
  })
  return { options, blocking: null }
}
