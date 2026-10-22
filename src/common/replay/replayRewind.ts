import { ordinal } from '../scoring/lineup'
import type { GameState } from '../scoring/state'
import { stepsWithStates } from './narration'
import type { ReplayTimeline } from './replayTimeline'

/**
 * Where the replay's rewind goes. A step belongs to the half inning it was
 * delivered in; a rewind goes back to the start of the half the last shown
 * step belongs to when two or more of its steps have been shown, and to the
 * start of the half before it otherwise, never before the first step.
 */

export interface Half {
  inning: number
  isTop: boolean
}

/** A rewind's destination: the step to start from, and its half. */
export interface RewindTarget {
  index: number
  half: Half
}

/** The steps of a half that must have been shown to rewind to its start. */
export const EVENTS_TO_STAY = 2

/** One walk of a timeline: each step's half, and the game where each half starts. */
interface Walk {
  halves: Half[]
  starts: Map<number, GameState>
}

const walks = new WeakMap<ReplayTimeline, Walk>()

function halfOf(state: GameState): Half {
  const line = state.liveData.linescore
  return { inning: line.currentInning, isTop: line.isTopInning }
}

/**
 * The game before each step, as the narration walks it (`stepsWithStates`),
 * so the rewind and the announcer agree on where every half starts. Each
 * state it yields stands on its own, and the one at each half's start is
 * kept, so a rewind stands the field up without walking the game again.
 */
function walk(timeline: ReplayTimeline): Walk {
  const known = walks.get(timeline)
  if (known != null) return known
  const halves: Half[] = []
  const starts = new Map<number, GameState>()
  for (const { before } of stepsWithStates(timeline)) {
    const half = halfOf(before)
    const index = halves.length
    if (index === 0 || !sameHalf(halves[index - 1], half))
      starts.set(index, before)
    halves.push(half)
  }
  const made = { halves, starts }
  walks.set(timeline, made)
  return made
}

/** Each step's half: the game's half just before the step's first action. */
export function halvesOf(timeline: ReplayTimeline): Half[] {
  return walk(timeline).halves
}

/**
 * The game before the step at `index`: kept for the start of each half, the
 * one a rewind goes to, and walked to otherwise. The state is shared with the
 * walk; a caller that changes it copies it first, as `initialScoringState`
 * does.
 */
export function stateBefore(
  timeline: ReplayTimeline,
  index: number
): GameState {
  const { starts } = walk(timeline)
  const kept = starts.get(index)
  if (kept != null) return kept
  // From the start of the half it is in, so the walk is at most one half.
  let from = 0
  for (const start of starts.keys())
    if (start <= index && start > from) from = start
  let state = starts.get(from) ?? timeline.start
  let at = from
  for (const { before, after } of stepsWithStates(timeline, from, state)) {
    if (at++ === index) return before
    state = after
  }
  return state
}

function sameHalf(a: Half, b: Half): boolean {
  return a.inning === b.inning && a.isTop === b.isTop
}

/** The first step of the half the step at `index` belongs to. */
function firstOfHalf(halves: Half[], index: number): number {
  let first = index
  while (first > 0 && sameHalf(halves[first - 1], halves[index])) first--
  return first
}

/**
 * Where a rewind goes from the step last shown (`shownIndex`, −1 for none):
 * the start of that step's half when it is at least its second step, the
 * start of the half before otherwise, and never before the first step.
 */
export function rewindTarget(
  timeline: ReplayTimeline,
  shownIndex: number
): RewindTarget | null {
  if (timeline.steps.length === 0) return null
  const halves = halvesOf(timeline)
  const at = (index: number): RewindTarget => ({ index, half: halves[index] })
  if (shownIndex < 0) return at(0)
  const shown = Math.min(shownIndex, timeline.steps.length - 1)
  const first = firstOfHalf(halves, shown)
  if (shown - first + 1 >= EVENTS_TO_STAY) return at(first)
  if (first === 0) return at(0)
  return at(firstOfHalf(halves, first - 1))
}

const INNING_WORDS = [
  'first',
  'second',
  'third',
  'fourth',
  'fifth',
  'sixth',
  'seventh',
  'eighth',
  'ninth',
  'tenth',
  'eleventh',
  'twelfth',
  'thirteenth',
  'fourteenth',
  'fifteenth',
  'sixteenth',
  'seventeenth',
  'eighteenth',
  'nineteenth',
  'twentieth'
]

/** An inning as a word, "first" to "twentieth", then "21st" and on. */
export function inningWord(inning: number): string {
  return INNING_WORDS[inning - 1] ?? ordinal(inning)
}

/**
 * "Rewind to top of first": the app's `%s` templates for each side of the
 * inning, filled here since common code cannot reach the app's `sprintf`.
 */
export function rewindLabel(
  half: Half,
  words: { top: string; bottom: string }
): string {
  return (half.isTop ? words.top : words.bottom).replace(
    '%s',
    inningWord(half.inning)
  )
}
