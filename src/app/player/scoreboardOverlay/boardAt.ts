import type { BoardStep } from '../../../common/api'

/**
 * The step of a game's board in effect at `wallMs` (or of any timeline of
 * steps, such as its line score): the last whose `at` is at or before it. Null before the first step, and for no instant at all, which
 * is when nothing is drawn.
 *
 * By halving: a game's timeline is a step per action, and this runs on every
 * frame.
 */
export function boardAt<Step extends { at: number } = BoardStep>(
  steps: readonly Step[],
  wallMs: number | null
): Step | null {
  if (wallMs == null || steps.length === 0 || steps[0].at > wallMs) return null
  let low = 0
  let high = steps.length - 1
  while (low < high) {
    const middle = Math.ceil((low + high) / 2)
    if (steps[middle].at <= wallMs) low = middle
    else high = middle - 1
  }
  return steps[low]
}

/**
 * The steps after a refetch from `fromMs`: those held from before it, then
 * everything the server now says from there on. The server's answer starts
 * with the step already in effect at `fromMs`, so anything held from that
 * step's own time on is replaced too.
 */
export function mergeSteps(
  held: readonly BoardStep[],
  fromMs: number,
  fetched: readonly BoardStep[]
): BoardStep[] {
  const cut = Math.min(fromMs, fetched[0]?.at ?? fromMs)
  return [...held.filter(step => step.at < cut), ...fetched]
}

/**
 * Whether any of a game's board steps falls inside a video's time frame, from
 * `fromMs` to `toMs` on the wall: a video with one shows the board from its
 * first frame. `toMs` is open (left out) only while the video is live.
 */
export function stepsInFrame(
  steps: readonly BoardStep[],
  fromMs: number | null,
  toMs: number = Number.POSITIVE_INFINITY
): boolean {
  if (fromMs == null) return false
  return steps.some(step => step.at >= fromMs && step.at <= toMs)
}

/**
 * The board before the game's first event in the frame: the team names, and
 * every other figure zero or empty — no inning, no count, no outs, nobody on
 * and nobody named.
 */
export function zeroedStep(
  steps: readonly BoardStep[],
  at: number
): BoardStep | null {
  const first = steps[0]
  if (first == null) return null
  return {
    at,
    state: {
      ...first.state,
      inGame: false,
      inning: 0,
      // Between halves: neither arrow is lit.
      half: 'mid',
      awayScore: 0,
      homeScore: 0,
      balls: 0,
      strikes: 0,
      outs: 0,
      base1: false,
      base2: false,
      base3: false,
      batterName: '',
      pitcherName: '',
      batterNumber: 0,
      batterNumHits: 0,
      batterAtBats: 0,
      numPitches: 0,
      pitchSpeed: 0,
      exitVelocity: 0
    }
  }
}
