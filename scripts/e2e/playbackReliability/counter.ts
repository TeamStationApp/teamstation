import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { Rect } from './motion'
import { PATTERN_FPS } from './testPattern'

const run = promisify(execFile)

/** One read of the burned-in frame counter. */
export interface CounterReading {
  atMs: number
  /** The frame number, or null when the digits could not be read. */
  frame: number | null
}

export interface CounterRules {
  /** Playback slower than this fraction of real time is a stutter. */
  minRate: number
  /** Readable samples needed before a verdict means anything. */
  minReadable: number
}

export const COUNTER_RULES: CounterRules = { minRate: 0.9, minReadable: 4 }

export interface CounterVerdict {
  /** Frames advanced per real second, over the window, as a fraction of the pattern's rate. */
  rate: number | null
  /** Consecutive readable samples that showed the same frame: a picture standing still. */
  repeats: Array<{ fromMs: number; toMs: number; frame: number }>
  /** Samples whose frame went backwards without the viewer moving it. */
  backwards: number
  readable: number
  unreadable: number
  pass: boolean
  reasons: string[]
}

/**
 * Reads the seven-digit counter inside `box` of a screenshot. ffmpeg cuts the
 * box out, scales it up, turns it dark-on-light and gives it a white margin —
 * tesseract drops a digit that touches the edge — for tesseract, which is
 * told to expect one line of digits.
 */
export async function readCounter(
  png: string,
  box: Rect,
  scratch: string,
  tools = {
    ffmpeg: process.env.FFMPEG_PATH ?? 'ffmpeg',
    tesseract: process.env.TESSERACT_PATH ?? 'tesseract'
  }
): Promise<number | null> {
  await run(tools.ffmpeg, [
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    png,
    '-vf',
    `crop=${Math.round(box.w)}:${Math.round(box.h)}:${Math.round(box.x)}:${Math.round(box.y)},` +
      'scale=-2:160,format=gray,negate,pad=iw+120:ih+40:60:20:white',
    '-frames:v',
    '1',
    '-y',
    scratch
  ])
  const { stdout } = await run(tools.tesseract, [
    scratch,
    'stdout',
    '--psm',
    '7',
    '-c',
    'tessedit_char_whitelist=0123456789'
  ])
  return parseCounter(stdout)
}

/**
 * Reads the angle's name inside `box` of a screenshot. The name is pure white
 * and nothing else there is, so only the brightest pixels are kept, black on
 * white, for tesseract. The raw text; whether it names the angle is
 * `namesAngle`'s call.
 */
export async function readLabel(
  png: string,
  box: Rect,
  scratch: string,
  tools = {
    ffmpeg: process.env.FFMPEG_PATH ?? 'ffmpeg',
    tesseract: process.env.TESSERACT_PATH ?? 'tesseract'
  }
): Promise<string> {
  await run(tools.ffmpeg, [
    '-nostdin',
    '-loglevel',
    'error',
    '-i',
    png,
    '-vf',
    `crop=${Math.round(box.w)}:${Math.round(box.h)}:${Math.round(box.x)}:${Math.round(box.y)},` +
      "scale=-2:160,format=gray,lut=c0='if(gt(val,235),0,255)',pad=iw+120:ih+40:60:20:white",
    '-frames:v',
    '1',
    '-y',
    scratch
  ])
  const { stdout } = await run(tools.tesseract, [
    scratch,
    'stdout',
    '--psm',
    '7'
  ])
  return stdout.trim()
}

/**
 * Which of `angles` a read of the picture's name shows: the one whose name
 * appears in it, letters and digits only, any case. Null when none does, or
 * more than one.
 */
export function namesAngle(
  text: string,
  angles: readonly string[]
): string | null {
  const plain = (value: string): string =>
    value.toLowerCase().replace(/[^a-z0-9]/g, '')
  const read = plain(text)
  const found = angles.filter(angle => read.includes(plain(angle)))
  return found.length === 1 ? found[0] : null
}

/**
 * Seven digits, or nothing: a partial read is not a frame number. The
 * pattern never reaches a million frames (4.6 hours at 60 fps), so its first
 * digit is always 0, and the frame is the other six. The font's slashed zero
 * is often read as a 9 there (0134988 as 9134988), so that digit is not read.
 */
export function parseCounter(text: string): number | null {
  const digits = text.replace(/\s+/g, '')
  return /^\d{7}$/.test(digits) ? Number(digits.slice(1)) : null
}

/**
 * Judges a play window from its counter readings: the frame number must keep
 * moving, and move at real speed.
 *
 * A repeat — two readable samples in a row showing the same frame — is a
 * picture that stood still for at least the time between them. The rate is
 * measured from the first readable sample to the last, so the screenshot's
 * own jitter of a frame or two averages out over the window.
 */
/**
 * Readings that are plainly misread: where the readings either side agree
 * with each other — the frame number between them moving at about real speed
 * — one more than `toleranceFrames` off the line between them is a digit the
 * OCR got wrong (0003872 read as 0003372), not the picture jumping back. The
 * first and last readings, with a neighbour on one side only, are held to the
 * line through the two next to them.
 */
export function withoutMisreads(
  readings: Array<{ atMs: number; frame: number }>,
  fps: number = PATTERN_FPS,
  toleranceFrames = 90
): Array<{ atMs: number; frame: number }> {
  return readings.filter((reading, index) => {
    const before =
      readings[index - 1] ?? (index === 0 ? readings[2] : undefined)
    const after =
      readings[index + 1] ??
      (index === readings.length - 1 ? readings[index - 2] : undefined)
    if (before == null || after == null || after.atMs === before.atMs)
      return true
    const rate =
      (after.frame - before.frame) / (((after.atMs - before.atMs) / 1000) * fps)
    if (rate < 0.5 || rate > 1.5) return true
    const expected =
      before.frame +
      ((after.frame - before.frame) * (reading.atMs - before.atMs)) /
        (after.atMs - before.atMs)
    return Math.abs(reading.frame - expected) <= toleranceFrames
  })
}

/**
 * Where steady playback begins: the first reading from which the frame
 * number rises, at half real speed or better, at every one of the next `run`
 * readings. Before it, a picture that has just landed can still show the last
 * place a drag passed through, hold its first frame while the rest arrives,
 * or creep a few frames as the grid lets it go; that is the start, which the
 * start budget judges, not the play.
 */
export function steadyFrom(
  readings: Array<{ atMs: number; frame: number }>,
  run = 3,
  fps: number = PATTERN_FPS
): number {
  for (let i = 0; i + run < readings.length; i++) {
    let rising = true
    for (let step = 1; step <= run && rising; step++) {
      const before = readings[i + step - 1]
      const now = readings[i + step]
      rising =
        now.frame - before.frame >=
        (0.5 * fps * Math.max(0, now.atMs - before.atMs)) / 1000
    }
    if (rising) return i
  }
  return 0
}

export function judgeCounter(
  readings: CounterReading[],
  rules: CounterRules = COUNTER_RULES,
  fps: number = PATTERN_FPS
): CounterVerdict {
  const read = withoutMisreads(
    readings.filter(
      (reading): reading is { atMs: number; frame: number } =>
        reading.frame != null
    )
  )
  const readable = read.slice(steadyFrom(read))
  const repeats: CounterVerdict['repeats'] = []
  let backwards = 0
  for (let i = 1; i < readable.length; i++) {
    const before = readable[i - 1]
    const now = readable[i]
    if (now.frame === before.frame) {
      const last = repeats[repeats.length - 1]
      if (last?.toMs === before.atMs && last.frame === now.frame) {
        last.toMs = now.atMs
      } else {
        repeats.push({ fromMs: before.atMs, toMs: now.atMs, frame: now.frame })
      }
    } else if (now.frame < before.frame) {
      backwards++
    }
  }
  const first = readable[0]
  const last = readable[readable.length - 1]
  const rate =
    readable.length >= 2 && last.atMs > first.atMs
      ? (last.frame - first.frame) / (((last.atMs - first.atMs) / 1000) * fps)
      : null
  const reasons: string[] = []
  if (readable.length < rules.minReadable) {
    reasons.push(`only ${readable.length} readable counter samples`)
  }
  if (repeats.length > 0) {
    reasons.push(
      `counter stood still ${repeats
        .map(
          repeat =>
            `at frame ${repeat.frame} for ≥${repeat.toMs - repeat.fromMs} ms`
        )
        .join(', ')}`
    )
  }
  if (backwards > 0) reasons.push(`counter went backwards ${backwards} times`)
  if (rate != null && rate < rules.minRate) {
    reasons.push(`played at ${rate.toFixed(2)}× real time`)
  }
  return {
    rate,
    repeats,
    backwards,
    readable: readable.length,
    unreadable: readings.length - readable.length,
    pass: reasons.length === 0,
    reasons
  }
}
