import type { ScoringAction } from './actions'

/**
 * How old a displaced action's time must be for the action that takes its
 * place to take it too. A correction made on the spot lands within seconds
 * either way, and a new pitch after an Undo must not take the undone one's
 * moment; a correction made later puts the pitch back where it happened.
 */
export const REPLACED_KEEPS_TIME_MS = 60_000

/** An action written out, as `sync` compares two, once per action. */
const actionKeys = new WeakMap<ScoringAction, string>()
export function keyOf(action: ScoringAction): string {
  let key = actionKeys.get(action)
  if (key == null) {
    key = JSON.stringify(action)
    actionKeys.set(action, key)
  }
  return key
}

/** Actions a cut took off a log, written out by `keyOf`, with their times. */
export interface DisplacedActions {
  keys: readonly string[]
  times: ReadonlyArray<string | undefined>
}

export interface MatchedTimes {
  /** A time for each applied action. */
  times: Array<string | undefined>
  /** How many of the displaced actions were used or passed. */
  consumed: number
  /** The newest applied action lies beyond everything displaced. */
  past: boolean
}

/**
 * Gives the actions applied after a cut the times of the actions it
 * displaced, so a time follows its action rather than its place. The two runs
 * are matched by their longest common subsequence, with the equality `sync`
 * uses; of the matchings as long as that, the one that leaves the fewest
 * actions on either side without a partner is taken, so a changed action
 * pairs with the one it replaced. Then:
 *
 * - an applied action equal to a displaced one takes that one's time;
 * - one that takes a displaced action's place takes its time when that is
 *   more than a minute older than the moment it was applied, and keeps its
 *   own otherwise;
 * - one inserted where nothing was displaced takes the time of the action
 *   before it, `before` for the first;
 * - one beyond the end of what was displaced keeps its own.
 *
 * `applied` are the applied actions written out, and `stamped` the moment
 * each was applied.
 */
export function matchTimes(
  applied: readonly string[],
  stamped: readonly string[],
  displaced: DisplacedActions,
  before: string | undefined
): MatchedTimes {
  const shown = displaced.keys
  const m = applied.length
  const n = shown.length
  // A match outweighs every pairing of unequal actions there could be.
  const MATCH = Math.min(m, n) + 1
  // best[i * width + j]: the best score of applied[i..] against shown[j..],
  // MATCH per match and 1 per pair of unequal actions in the same place.
  const width = n + 1
  const best = new Int32Array((m + 1) * width)
  const score = (i: number, j: number): number => best[i * width + j]
  for (let i = m - 1; i >= 0; i--)
    for (let j = n - 1; j >= 0; j--)
      best[i * width + j] = Math.max(
        (applied[i] === shown[j] ? MATCH : 1) + score(i + 1, j + 1),
        score(i + 1, j),
        score(i, j + 1)
      )
  // Each applied action's partner: a displaced index, or -1 for none. On a
  // tie, a pair is taken before passing an action by, so an action takes the
  // place of the first one it can.
  const partner: number[] = []
  for (let i = 0, j = 0; i < m;) {
    const here = score(i, j)
    if (
      j < n &&
      here === (applied[i] === shown[j] ? MATCH : 1) + score(i + 1, j + 1)
    )
      partner[i++] = j++
    else if (j >= n || here === score(i + 1, j)) partner[i++] = -1
    else j++
  }
  // Past the last applied action with a partner, nothing displaced is left.
  let lastPaired = m - 1
  while (lastPaired >= 0 && partner[lastPaired] < 0) lastPaired--
  const times: Array<string | undefined> = []
  for (const [i, j] of partner.entries()) {
    const own = stamped[i]
    if (j >= 0) {
      const old = displaced.times[j]
      times.push(
        applied[i] === shown[j] ||
          (old != null &&
            Date.parse(own) - Date.parse(old) > REPLACED_KEEPS_TIME_MS)
          ? old
          : own
      )
    } else if (i < lastPaired)
      times.push((i > 0 ? times[i - 1] : before) ?? own)
    else times.push(own)
  }
  return {
    times,
    consumed: lastPaired < 0 ? 0 : partner[lastPaired] + 1,
    past: m > 0 && partner[m - 1] < 0 && lastPaired < m - 1
  }
}
