import {
  CLOCK_ORIGIN,
  clockLayout,
  HEIGHT,
  segmentCentre,
  SEGMENTS,
  WIDTH
} from './syntheticFrames'

/**
 * Every frame Chrome presents, from every tile. `FRAME_LOG_SCRIPT` hangs a
 * `requestVideoFrameCallback` on each tile's video; on each presented frame
 * it draws the frame at a quarter of the synthetic frame's size and reads the
 * burned-in clock there, as `clockReader` does, so each frame carries the
 * moment it shows. `FRAME_DRAIN_SCRIPT` hands over what has been logged since
 * the last drain. `analyseFrames` turns the log into stalls (no frame
 * presented), frozen pictures (frames whose clock does not move) and how far
 * apart the angles are.
 */

/** The size each frame is drawn at for its clock: a quarter of the synthetic frame. */
const SCALE = 0.25
const W = WIDTH * SCALE
const H = HEIGHT * SCALE

/** The clock's digit positions at that size: nine digits × seven segments, in a–g order. */
export function clockSamplePoints(): Array<Array<[number, number]>> {
  const layout = clockLayout()
  return [0, 1, 3, 4, 6, 7, 9, 10, 11].map(index =>
    'abcdefg'.split('').map(segment => {
      const [x, y] = segmentCentre(
        layout.boxes[index],
        CLOCK_ORIGIN.stroke,
        segment
      )
      return [Math.round(x * SCALE), Math.round(y * SCALE)]
    })
  )
}

/** Each digit's lit segments as a 7-bit string, a–g. */
export function digitPatterns(): Record<string, string> {
  return Object.fromEntries(
    Object.entries(SEGMENTS).map(([digit, on]) => [
      'abcdefg'
        .split('')
        .map(segment => (on.includes(segment) ? '1' : '0'))
        .join(''),
      digit
    ])
  )
}

/**
 * Runs in the page: logs each presented frame of each tile as
 * `[angle, presentedFrames, mediaTimeSec, displayEpochMs, clockMsOfDay | -1]`.
 * Installing again replaces nothing that is already logging, so it is run
 * before every drain: a page loaded afresh (a rejoin) logs again.
 */
export function frameLogScript(): string {
  return `(() => {
  if (window.__tsFrames != null) return 'already'
  const points = ${JSON.stringify(clockSamplePoints())}
  const patterns = ${JSON.stringify(digitPatterns())}
  const log = []
  window.__tsFrames = log
  const canvas = document.createElement('canvas')
  canvas.width = ${W}
  canvas.height = ${H}
  const context = canvas.getContext('2d', { willReadFrequently: true })
  const ink = (data, x, y) => {
    const at = (y * ${W} + x) * 4
    const r = data[at], g = data[at + 1], b = data[at + 2]
    return r > 150 && g > 100 && b < 110 && r - b > 90
  }
  const readClock = video => {
    context.drawImage(video, 0, 0, ${W}, ${H})
    const data = context.getImageData(0, 0, ${W}, ${H}).data
    let text = ''
    for (const digit of points) {
      const bits = digit.map(([x, y]) => (ink(data, x, y) ? '1' : '0')).join('')
      const d = patterns[bits]
      if (d == null) return -1
      text += d
    }
    const n = (from, count) => Number(text.slice(from, from + count))
    const h = n(0, 2), m = n(2, 2), s = n(4, 2), ms = n(6, 3)
    if (h > 23 || m > 59 || s > 59) return -1
    return ((h * 60 + m) * 60 + s) * 1000 + ms
  }
  const watched = new WeakSet()
  const attach = () => {
    const videos = [...document.querySelectorAll('video')]
    for (const tile of document.querySelectorAll('[aria-label$=" angle"]')) {
      const angle = tile.getAttribute('aria-label').replace(/ angle$/, '')
      const t = tile.getBoundingClientRect()
      const video = tile.querySelector('video') || videos.find(v => {
        const r = v.getBoundingClientRect()
        const x = r.left + r.width / 2, y = r.top + r.height / 2
        return x >= t.left && x <= t.right && y >= t.top && y <= t.bottom
      })
      if (video == null || watched.has(video) || video.requestVideoFrameCallback == null) continue
      watched.add(video)
      const onFrame = (now, meta) => {
        let clock = -1
        try { clock = readClock(video) } catch (error) { clock = -1 }
        log.push([angle, meta.presentedFrames, meta.mediaTime, performance.timeOrigin + meta.expectedDisplayTime, clock])
        video.requestVideoFrameCallback(onFrame)
      }
      video.requestVideoFrameCallback(onFrame)
    }
  }
  attach()
  // Tiles come and go as the viewer leaves and re-enters the player.
  window.__tsFramesAttach = setInterval(attach, 1000)
  return 'installed'
})()`
}

/** Runs in the page: what has been logged since the last drain. */
export const FRAME_DRAIN_SCRIPT = `(() => {
  const log = window.__tsFrames
  if (log == null) return '[]'
  return JSON.stringify(log.splice(0, log.length))
})()`

/** One presented frame. */
export interface PresentedFrame {
  angle: string
  presented: number
  mediaTime: number
  displayMs: number
  /** The burned-in clock's time of day, or null when the frame could not be read. */
  clockMsOfDay: number | null
}

export function parseFrames(raw: unknown): PresentedFrame[] {
  const rows = (typeof raw === 'string' ? JSON.parse(raw) : raw) as Array<
    [string, number, number, number, number]
  >
  return rows.map(([angle, presented, mediaTime, displayMs, clock]) => ({
    angle,
    presented,
    mediaTime,
    displayMs,
    clockMsOfDay: clock < 0 ? null : clock
  }))
}

/** A stretch in which an angle presented no frame, or presented frames whose clock did not move. */
export interface FrameGap {
  angle: string
  kind: 'stall' | 'frozen'
  fromMs: number
  toMs: number
}

export interface AngleFrames {
  angle: string
  frames: number
  /** The share of frames whose clock read. */
  readable: number
  stalls: number
  frozen: number
  longestMs: number
}

export interface FrameAnalysis {
  angles: AngleFrames[]
  gaps: FrameGap[]
  /** Per second of display time, how far apart the angles' clocks were (ms), where at least two read. */
  spreads: Array<{ atMs: number; spreadMs: number }>
}

/** Seconds after an action in which an interruption is expected, not a fault. */
export const SETTLE_MS = 10_000

function inAny(atMs: number, windows: Array<[number, number]>): boolean {
  return windows.some(([from, to]) => atMs >= from && atMs < to)
}

/**
 * Stalls longer than `gapMs` between presented frames, and from an angle's
 * last frame to `endMs`; frozen runs of frames whose clock stays within
 * `gapMs`; and the angles' spread, leaving out the `quiet` windows (just after
 * a scrub). An `expected` angle that presented no frame at all is one stall
 * over the whole run.
 */
export function analyseFrames(
  frames: PresentedFrame[],
  quiet: Array<[number, number]> = [],
  options: {
    gapMs?: number
    startMs?: number
    endMs?: number
    expected?: string[]
  } = {}
): FrameAnalysis {
  const gapMs = options.gapMs ?? 1000
  const byAngle = new Map<string, PresentedFrame[]>()
  for (const frame of frames) {
    byAngle.set(frame.angle, [...(byAngle.get(frame.angle) ?? []), frame])
  }
  for (const angle of options.expected ?? []) {
    if (!byAngle.has(angle)) byAngle.set(angle, [])
  }
  const gaps: FrameGap[] = []
  const angles: AngleFrames[] = []
  for (const [angle, list] of byAngle) {
    list.sort((a, b) => a.displayMs - b.displayMs)
    if (list.length === 0) {
      const fromMs = options.startMs ?? options.endMs ?? 0
      const toMs = options.endMs ?? fromMs
      gaps.push({ angle, kind: 'stall', fromMs, toMs })
      angles.push({
        angle,
        frames: 0,
        readable: 0,
        stalls: 1,
        frozen: 0,
        longestMs: toMs - fromMs
      })
      continue
    }
    let stalls = 0
    let frozen = 0
    let longest = 0
    // An angle that stops and never comes back stalls until the run's end.
    const last = list[list.length - 1]
    const tail =
      options.endMs != null &&
      options.endMs - last.displayMs > gapMs &&
      !inAny(last.displayMs, quiet)
    if (tail) {
      stalls++
      longest = options.endMs! - last.displayMs
      gaps.push({
        angle,
        kind: 'stall',
        fromMs: last.displayMs,
        toMs: options.endMs!
      })
    }
    for (let i = 1; i < list.length; i++) {
      const gap = list[i].displayMs - list[i - 1].displayMs
      if (gap > gapMs && !inAny(list[i - 1].displayMs, quiet)) {
        stalls++
        longest = Math.max(longest, gap)
        gaps.push({
          angle,
          kind: 'stall',
          fromMs: list[i - 1].displayMs,
          toMs: list[i].displayMs
        })
      }
    }
    // Frozen: a run of readable frames over more than gapMs of display whose clock moved under 10 % of that.
    let runStart = 0
    for (let i = 1; i <= list.length; i++) {
      const start = list[runStart]
      const here = list[i]
      const still =
        here?.clockMsOfDay != null &&
        start.clockMsOfDay != null &&
        Math.abs(here.clockMsOfDay - start.clockMsOfDay) <
          (here.displayMs - start.displayMs) * 0.1 + 50
      if (still) continue
      const last = list[i - 1]
      const span = last.displayMs - start.displayMs
      if (
        span > gapMs &&
        start.clockMsOfDay != null &&
        !inAny(start.displayMs, quiet)
      ) {
        frozen++
        longest = Math.max(longest, span)
        gaps.push({
          angle,
          kind: 'frozen',
          fromMs: start.displayMs,
          toMs: last.displayMs
        })
      }
      runStart = i
    }
    angles.push({
      angle,
      frames: list.length,
      readable: list.filter(f => f.clockMsOfDay != null).length / list.length,
      stalls,
      frozen,
      longestMs: longest
    })
  }
  const seconds = new Map<number, Map<string, number>>()
  for (const frame of frames) {
    if (frame.clockMsOfDay == null || inAny(frame.displayMs, quiet)) continue
    const second = Math.floor(frame.displayMs / 1000) * 1000
    const row = seconds.get(second) ?? new Map<string, number>()
    // The clock less how far into the second it was shown, so frames shown at different moments compare.
    row.set(frame.angle, frame.clockMsOfDay - (frame.displayMs - second))
    seconds.set(second, row)
  }
  const spreads = [...seconds.entries()]
    .filter(([, row]) => row.size >= 2)
    .map(([atMs, row]) => ({
      atMs,
      spreadMs: Math.round(
        Math.max(...row.values()) - Math.min(...row.values())
      )
    }))
    .sort((a, b) => a.atMs - b.atMs)
  return {
    angles: angles.sort((a, b) => a.angle.localeCompare(b.angle)),
    gaps,
    spreads
  }
}
