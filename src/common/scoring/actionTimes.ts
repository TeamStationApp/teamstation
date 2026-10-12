import type { ScoringAction } from './actions'

/**
 * How old a displaced action must have been when it was cut for the action
 * that takes its place, or repeats it after the call that cut it, to take its
 * time too. A pitch undone within a minute of being taken was a mistake, and
 * the pitch entered after it, however much later, is a new one; a correction
 * made later puts the pitch back where it happened. The session lets such a
 * pitch go once the call that cut it returns, so nothing entered later is
 * matched against it at all.
 */
export const REPLACED_KEEPS_TIME_MS = 60_000

/**
 * An action written out, once per action, with each object's keys in order:
 * two that say the same have the same key, as `sync` takes them to be the
 * same, though one read back from the server lists its keys in another order.
 */
const actionKeys = new WeakMap<ScoringAction, string>()
export function keyOf(action: ScoringAction): string {
  let key = actionKeys.get(action)
  if (key == null) {
    key = JSON.stringify(action, (_name, item: unknown) =>
      item != null && typeof item === 'object' && !Array.isArray(item)
        ? Object.fromEntries(
            Object.entries(item).sort(([x], [y]) =>
              x < y ? -1 : x > y ? 1 : 0
            )
          )
        : item
    )
    actionKeys.set(action, key)
  }
  return key
}

/** Actions a cut took off a log, written out by `keyOf`, with their times. */
export interface DisplacedActions {
  keys: readonly string[]
  times: ReadonlyArray<string | undefined>
  /**
   * When each displaced action was cut off: what was left over from an
   * earlier cut keeps the moment of that cut.
   */
  cutAt: readonly string[]
  /**
   * How many of the first displaced actions the last cut itself took off;
   * the rest are left over from an earlier cut.
   */
  cut?: number
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
 * Pairs two runs of actions written out by their longest common subsequence;
 * of the matchings as long as that, the one that leaves the fewest actions
 * on either side without a partner, so a changed action pairs with the one
 * it replaced. Gives each applied action's partner: an index into `shown`,
 * or -1 for none.
 */
function partnersOf(
  applied: readonly string[],
  shown: readonly string[]
): number[] {
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
  // On a tie, a pair is taken before passing an action by, so an action
  // takes the place of the first one it can.
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
  return partner
}

/**
 * Gives the actions applied after a cut the times of the actions it
 * displaced, so a time follows its action rather than its place. The runs
 * are paired by `partnersOf`, with the equality `sync` uses, in two parts:
 * the actions applied in the call that made the cut against only what that
 * cut took off, and the actions applied after them against what is left,
 * which is what that history did not reach of the cut, then what an earlier
 * cut left over. Then:
 *
 * - an action applied in the call that made the cut, paired with one that
 *   cut took off, takes that one's time whatever its age, whether it is the
 *   same action or the one that replaced it: that is a screen applying its
 *   history again with a change in it, and every pitch in it, the changed
 *   one too, happened when it happened;
 * - any other applied action equal to a displaced one, or one that takes a
 *   displaced action's place, takes that one's time when the displaced
 *   action was more than a minute old when it was cut, and keeps its own
 *   otherwise: a pitch undone within the minute was a mistake, and the pitch
 *   entered after it is a new one, however long after; a pitch undone later
 *   is being corrected, and its replacement goes back to its moment (the
 *   session lets the younger ones go when the cutting call returns, so a
 *   later action is not even judged inserted against one). An action put
 *   back unchanged that had no time stays without one;
 * - one inserted where nothing was displaced takes the time of the action
 *   before it, `before` for the first;
 * - one beyond the end of what was displaced keeps its own.
 *
 * `applied` are the applied actions written out, `stamped` the moment each
 * was applied, and `replayed` how many of the first were applied in the call
 * that made the cut.
 */
export function matchTimes(
  applied: readonly string[],
  stamped: readonly string[],
  displaced: DisplacedActions,
  before: string | undefined,
  replayed = 0
): MatchedTimes {
  const shown = displaced.keys
  const m = applied.length
  // History put back in the cutting call is matched only against what that
  // cut took off: matched with the leftovers of an earlier cut behind it,
  // the run would slide onto theirs wherever that pairs more actions.
  const history =
    replayed > 0
      ? partnersOf(
          applied.slice(0, replayed),
          shown.slice(0, displaced.cut ?? 0)
        )
      : []
  // What comes after that history is matched against what is left: what
  // the history did not reach of the cut, then the leftovers.
  let used = 0
  for (const j of history) if (j >= 0) used = j + 1
  const partner = [
    ...history,
    ...partnersOf(applied.slice(history.length), shown.slice(used)).map(j =>
      j < 0 ? j : j + used
    )
  ]
  // Past the last applied action with a partner, nothing displaced is left.
  let lastPaired = m - 1
  while (lastPaired >= 0 && partner[lastPaired] < 0) lastPaired--
  const times: Array<string | undefined> = []
  for (const [i, j] of partner.entries()) {
    const own = stamped[i]
    if (j >= 0) {
      const old = displaced.times[j]
      const same = applied[i] === shown[j]
      // An action put back unchanged that never had a time (scored before
      // actions carried them) stays without one, so its play keeps its own.
      if (old == null) times.push(same ? old : own)
      // History put back by the cutting call is paired only with its own cut.
      else if (i < replayed) times.push(old)
      else
        times.push(
          Date.parse(displaced.cutAt[j]) - Date.parse(old) >
            REPLACED_KEEPS_TIME_MS
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
