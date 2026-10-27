import type { CounterReading, CounterVerdict } from './counter'
import type { MotionVerdict } from './motion'
import type { ReadoutVerdict } from './readout'

/** Which content a run plays: the test pattern, it with the real game's structure, or the real game. */
export type Content = 'tp' | 'tp+' | 'real'

export interface StepRules {
  /** Pictures must move within this long of the action's release. */
  startBudgetMs: number
  /**
   * The share of its frames a player may drop over a step before the picture
   * is a stutter: it lags the clock, then jumps to catch up.
   */
  maxDroppedShare: number
}

export const STEP_RULES: StepRules = {
  startBudgetMs: 4000,
  maxDroppedShare: 0.05
}

/** What one tile's detectors said about a step. */
export interface TileEvidence {
  tile: string
  /** Screenshot comparison; always present. */
  motion: MotionVerdict
  /** The burned-in counter; test pattern only. */
  counter?: CounterVerdict
  /** What the counter read in each picture, for whoever checks a verdict. */
  readings?: CounterReading[]
  /**
   * The angle the tile should show, and which angles the pictures' burned-in
   * names showed (test pattern only): a picture that moves is no proof the
   * chosen angle arrived, as the last angle plays on until it does.
   */
  angle?: { want: string; seen: Array<string | null> }
}

export interface StepEvidence {
  step: string
  content: Content
  tiles: TileEvidence[]
  /** The player's readout over the play window, when `?debug=1` is on. */
  readout?: ReadoutVerdict
  /** The webcam's crop of this phone over the same window (MEASURED). */
  webcam?: MotionVerdict
  /**
   * When the player itself first said it was playing and not held, in ms
   * after the release; null when it never did. A picture that changes while
   * the grid holds is a picture arriving, not playback, so the start is the
   * later of this and the screenshots' start.
   */
  readoutStartMs?: number | null
  /** Where a scrub should have landed and where the player says it did. */
  landing?: { wantSec: number; gotSec: number | null; toleranceSec: number }
  /** The browser's own count of each tile's frames over the step, dropped and all. */
  frames?: Array<{ tile: string; dropped: number; total: number }>
}

export interface StepVerdict {
  step: string
  pass: boolean
  /** The slowest tile's start, in ms after the release; null when one never started. */
  startMs: number | null
  reasons: string[]
  /** Findings from detectors that did not decide the verdict on their own. */
  notes: string[]
}

/**
 * One step's verdict from every detector that watched it.
 *
 * A late or missing start fails the step outright: every tile must move within
 * the budget on the screenshots. A freeze fails it on the test pattern, where
 * every frame differs, from the screenshots or the counter alone. On real
 * footage a still scene is possible, so a screenshot freeze fails the step only
 * when the readout or the webcam saw a freeze too; otherwise it is noted. The
 * readout's own freezes, holds and slow rates always fail it, and so does a
 * webcam freeze, which is measured on the glass.
 */
export function judgeStep(
  evidence: StepEvidence,
  rules: StepRules = STEP_RULES
): StepVerdict {
  const reasons: string[] = []
  const notes: string[] = []
  let startMs: number | null = 0
  for (const tile of evidence.tiles) {
    const start = tile.motion.startMs
    if (start == null) {
      reasons.push(`${tile.tile} never started moving`)
      startMs = null
    } else {
      if (startMs != null) startMs = Math.max(startMs, start)
      if (start > rules.startBudgetMs) {
        reasons.push(`${tile.tile} started after ${start} ms`)
      }
    }
  }
  if (evidence.readoutStartMs !== undefined) {
    const said = evidence.readoutStartMs
    if (said == null) {
      reasons.push('the player never said it was playing')
      startMs = null
    } else if (startMs != null && said > startMs) {
      startMs = said
      if (said > rules.startBudgetMs) {
        reasons.push(`the player said it was playing only after ${said} ms`)
      }
    }
  }
  if (evidence.landing != null) {
    const { wantSec, gotSec, toleranceSec } = evidence.landing
    if (gotSec == null) {
      reasons.push('no readout to say where the scrub landed')
    } else if (Math.abs(gotSec - wantSec) > toleranceSec) {
      reasons.push(
        `landed at ${Math.round(gotSec)} s, not near ${Math.round(wantSec)} s`
      )
    }
  }
  const pattern = evidence.content !== 'real'
  const corroborated =
    (evidence.readout?.freezes.length ?? 0) > 0 ||
    (evidence.webcam?.freezes.length ?? 0) > 0
  for (const tile of evidence.tiles) {
    if (tile.motion.freezes.length > 0) {
      const text = `${tile.tile} picture stood still for ${tile.motion.longestFreezeMs} ms`
      if (pattern || corroborated) reasons.push(text)
      else notes.push(`${text} (uncorroborated on real footage)`)
    }
    if (tile.angle != null) {
      const { want, seen } = tile.angle
      const named = seen.filter((one): one is string => one != null)
      if (named.length === 0) {
        notes.push(`${tile.tile}: the picture's name could not be read`)
      } else if (!named.includes(want)) {
        reasons.push(`${tile.tile} showed ${named.at(-1)}, not ${want}`)
      }
    }
    if (tile.counter != null && !tile.counter.pass) {
      reasons.push(
        ...tile.counter.reasons.map(reason => `${tile.tile} ${reason}`)
      )
    }
  }
  for (const { tile, dropped, total } of evidence.frames ?? []) {
    if (total > 0 && dropped / total > rules.maxDroppedShare) {
      reasons.push(
        `${tile} dropped ${Math.round((dropped / total) * 100)} % of its frames (${dropped} of ${total})`
      )
    }
  }
  if (evidence.readout != null && !evidence.readout.pass) {
    reasons.push(
      ...evidence.readout.reasons.map(reason => `readout: ${reason}`)
    )
  }
  if (evidence.webcam != null) {
    if (evidence.webcam.freezes.length > 0) {
      reasons.push(
        `webcam: screen stood still for ${evidence.webcam.longestFreezeMs} ms`
      )
    }
    const screen = evidence.tiles.some(tile => tile.motion.freezes.length > 0)
    if (screen !== evidence.webcam.freezes.length > 0) {
      notes.push('webcam and screenshots disagree about a freeze')
    }
  }
  return {
    step: evidence.step,
    pass: reasons.length === 0,
    startMs,
    reasons,
    notes
  }
}
