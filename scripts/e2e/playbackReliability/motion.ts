import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** A rectangle in source pixels: size first, then top-left corner. */
export interface Rect {
  x: number
  y: number
  w: number
  h: number
}

/** How much one picture differs from the one before it, and when it was taken. */
export interface MotionSample {
  atMs: number
  /** Mean luma difference from the previous sample, 0–255; null for the first. */
  diff: number | null
}

export interface MotionRules {
  /** At or below this, two pictures are the same picture. */
  stillAtOrBelow: number
  /** A run of the same picture longer than this is a freeze. */
  freezeMs: number
  /** Changes in a row that count as playing, rather than a picture arriving. */
  sustain: number
}

export const MOTION_RULES: MotionRules = {
  stillAtOrBelow: 0.6,
  freezeMs: 500,
  sustain: 3
}

/**
 * The bench camera's frames: its stream can deliver the same frame twice
 * when the network hiccups, so only a still run over a second is the glass
 * standing still.
 */
export const CAMERA_MOTION_RULES: MotionRules = {
  ...MOTION_RULES,
  freezeMs: 1000
}

export interface Freeze {
  fromMs: number
  toMs: number
}

export interface MotionVerdict {
  /** From the release to the first new picture that kept changing; null if none came. */
  startMs: number | null
  freezes: Freeze[]
  longestFreezeMs: number
}

/**
 * Mean luma difference between each picture and the one before it, inside
 * `rect`, for a numbered PNG sequence (`%06d.png`) or a video. The first
 * picture has nothing to compare with, so the series starts at the second:
 * entry `i` compares picture `i + 1` with picture `i`.
 *
 * One ffmpeg pass: crop, `tblend` difference against the previous frame, and
 * `signalstats` reports the mean of that difference as `YAVG`.
 */
export async function diffSeries(
  input: { pattern: string } | { video: string },
  rect: Rect,
  ffmpeg = process.env.FFMPEG_PATH ?? 'ffmpeg'
): Promise<number[]> {
  const source =
    'pattern' in input
      ? ['-framerate', '1', '-i', input.pattern]
      : ['-i', input.video]
  const filter =
    `crop=${even(rect.w)}:${even(rect.h)}:${Math.round(rect.x)}:${Math.round(rect.y)},` +
    'format=gray,tblend=all_mode=difference,signalstats,' +
    'metadata=print:key=lavfi.signalstats.YAVG:file=-'
  const { stdout } = await run(
    ffmpeg,
    [
      '-nostdin',
      '-loglevel',
      'error',
      ...source,
      '-vf',
      filter,
      '-f',
      'null',
      '-'
    ],
    { maxBuffer: 1 << 26 }
  )
  return parseYavg(stdout)
}

/** One value per frame `tblend` emits, which starts at the second picture. */
export function parseYavg(text: string): number[] {
  const values: number[] = []
  for (const match of text.matchAll(/lavfi\.signalstats\.YAVG=([0-9.]+)/g)) {
    values.push(Number(match[1]))
  }
  return values
}

/** ffmpeg's crop wants even sizes for chroma-subsampled input. */
function even(value: number): number {
  const whole = Math.max(2, Math.floor(value))
  return whole - (whole % 2)
}

/** Pairs the pictures' capture times with the difference series. */
export function samplesOf(timesMs: number[], diffs: number[]): MotionSample[] {
  if (diffs.length !== Math.max(0, timesMs.length - 1)) {
    throw new Error(
      `${timesMs.length} pictures need ${timesMs.length - 1} differences, got ${diffs.length}`
    )
  }
  return timesMs.map((atMs, index) => ({
    atMs,
    diff: index === 0 ? null : diffs[index - 1]
  }))
}

/**
 * Judges a series of pictures taken after an action released at
 * `releaseAtMs`.
 *
 * The start is the first picture after the release that begins a run of
 * `sustain` changes in a row. A picture arriving is not playback: a player
 * that loads a source and then sits paused changes twice — black to its
 * loading state, that to its first frame — and stops. A freeze is a run of unchanged
 * pictures, measured from the last picture that changed to the last one that
 * had not — what was actually seen standing still, never the gap to the next
 * sample — longer than `freezeMs`. Only the stretch after the start is judged.
 */
export function analyzeMotion(
  samples: MotionSample[],
  releaseAtMs: number,
  rules: MotionRules = MOTION_RULES
): MotionVerdict {
  const moved = (sample: MotionSample | undefined): boolean =>
    sample?.diff != null && sample.diff > rules.stillAtOrBelow
  let startIndex = -1
  for (let i = 0; i < samples.length; i++) {
    if (samples[i].atMs < releaseAtMs) continue
    let run = 0
    while (run < rules.sustain && moved(samples[i + run])) run++
    if (run === rules.sustain) {
      startIndex = i
      break
    }
  }
  if (startIndex < 0) return { startMs: null, freezes: [], longestFreezeMs: 0 }

  const freezes: Freeze[] = []
  let lastChangeMs = samples[startIndex].atMs
  for (let i = startIndex + 1; i < samples.length; i++) {
    if (moved(samples[i])) {
      if (!moved(samples[i - 1])) {
        pushFreeze(freezes, lastChangeMs, samples[i - 1].atMs, rules)
      }
      lastChangeMs = samples[i].atMs
    }
  }
  const last = samples[samples.length - 1]
  if (!moved(last)) pushFreeze(freezes, lastChangeMs, last.atMs, rules)
  return {
    startMs: samples[startIndex].atMs - releaseAtMs,
    freezes,
    longestFreezeMs: freezes.reduce(
      (most, freeze) => Math.max(most, freeze.toMs - freeze.fromMs),
      0
    )
  }
}

function pushFreeze(
  freezes: Freeze[],
  fromMs: number,
  toMs: number,
  rules: MotionRules
): void {
  if (toMs - fromMs > rules.freezeMs) freezes.push({ fromMs, toMs })
}
