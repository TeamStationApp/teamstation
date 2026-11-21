import {
  type Box,
  CLOCK_ORIGIN,
  clockLayout,
  COUNTER_ORIGIN,
  glyph,
  HEIGHT,
  LABEL_ORIGIN,
  segmentCentre,
  SEGMENTS,
  WIDTH
} from './syntheticFrames'

/**
 * Reads a synthetic camera's burned-in clock and label back from a picture of
 * it: a watcher's screenshot of one tile, or a frame Chrome drew from the
 * tile's video. The frame is 16:9 and the player fits it inside the tile, so
 * the reader fits WIDTH × HEIGHT into the tile's box and samples each digit's
 * seven segments where `syntheticFrames.ts` draws them.
 */

/** An RGBA picture, as `decodePng` gives it. */
export interface Picture {
  width: number
  height: number
  data: Uint8Array
}

export interface ClockReading {
  /** Milliseconds since midnight on the bench clock (its offset from UTC applied). */
  msOfDay: number
  /** The label the camera burns in, upper case, or null when it cannot be read. */
  label: string | null
  /** The share of the clock's nine digits that read as a whole digit, 0 to 1. */
  confidence: number
}

/** One tile's reading, or null when its picture shows no clock. */
export interface TileClock {
  angle: string
  reading: ClockReading | null
}

/** Readings below this are a covered or blurred picture, not a clock. */
export const MIN_CONFIDENCE = 1

/** The part of `box` the 16:9 frame fills when fitted inside it. */
export function frameIn(box: Box): Box {
  const scale = Math.min(box.w / WIDTH, box.h / HEIGHT)
  const w = WIDTH * scale
  const h = HEIGHT * scale
  return {
    x: box.x + (box.w - w) / 2,
    y: box.y + (box.h - h) / 2,
    w,
    h
  }
}

/** Is the picture's ink colour (yellow on dark grey) near this frame point? */
function lit(
  picture: Picture,
  frame: Box,
  [fx, fy]: [number, number],
  test: (r: number, g: number, b: number) => boolean
): boolean {
  const sx = frame.w / WIDTH
  const sy = frame.h / HEIGHT
  const cx = Math.round(frame.x + fx * sx)
  const cy = Math.round(frame.y + fy * sy)
  let hits = 0
  let seen = 0
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const x = cx + dx
      const y = cy + dy
      if (x < 0 || y < 0 || x >= picture.width || y >= picture.height) continue
      const at = (y * picture.width + x) * 4
      seen++
      if (test(picture.data[at], picture.data[at + 1], picture.data[at + 2]))
        hits++
    }
  }
  return seen > 0 && hits * 2 > seen
}

const isInk = (r: number, g: number, b: number): boolean =>
  r > 150 && g > 100 && b < 110 && r - b > 90
const isWhite = (r: number, g: number, b: number): boolean =>
  r > 130 && g > 130 && b > 130 && Math.max(r, g, b) - Math.min(r, g, b) < 60

const PATTERNS = new Map(
  Object.entries(SEGMENTS).map(([digit, on]) => [
    'abcdefg'
      .split('')
      .map(segment => (on.includes(segment) ? '1' : '0'))
      .join(''),
    digit
  ])
)

/** The clock's characters that are digits: HH:MM:SS.mmm. */
const DIGIT_AT = [0, 1, 3, 4, 6, 7, 9, 10, 11]

/** Reads the clock and label in `tile` (pixel box in `picture`), or null when the clock is not there. */
export function readClock(picture: Picture, tile: Box): ClockReading | null {
  const frame = frameIn(tile)
  const layout = clockLayout()
  const digits = DIGIT_AT.map(index => {
    const box = layout.boxes[index]
    const pattern = 'abcdefg'
      .split('')
      .map(segment =>
        lit(
          picture,
          frame,
          segmentCentre(box, CLOCK_ORIGIN.stroke, segment),
          isInk
        )
          ? '1'
          : '0'
      )
      .join('')
    return PATTERNS.get(pattern) ?? null
  })
  const read = digits.filter(digit => digit != null).length
  if (read === 0) return null
  const confidence = read / digits.length
  const n = (from: number, count: number): number =>
    Number(
      digits
        .slice(from, from + count)
        .map(d => d ?? '0')
        .join('')
    )
  const hours = n(0, 2)
  const minutes = n(2, 2)
  const seconds = n(4, 2)
  const millis = n(6, 3)
  const valid = hours < 24 && minutes < 60 && seconds < 60
  return {
    msOfDay: ((hours * 60 + minutes) * 60 + seconds) * 1000 + millis,
    label: readLabel(picture, frame),
    confidence: valid ? confidence : Math.min(confidence, 0.5)
  }
}

/**
 * The label, read cell by cell in the 5×7 font. Its cells are a tenth of the
 * clock's digits, so a scaled picture is read at small shifts and the shift
 * that reads the most characters wins.
 */
function readLabel(picture: Picture, frame: Box): string | null {
  let best = ''
  for (let dy = -4; dy <= 4; dy += 2) {
    for (let dx = -4; dx <= 4; dx += 2) {
      const label = labelAt(picture, frame, dx, dy)
      if (label.length > best.length) best = label
    }
  }
  return best === '' ? null : best
}

const LABEL_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'

/** The label at one shift, in frame pixels, up to the first unreadable or blank character. */
function labelAt(picture: Picture, frame: Box, dx: number, dy: number): string {
  const { x, y, scale } = LABEL_ORIGIN
  let label = ''
  for (let index = 0; index < 24; index++) {
    let bits = ''
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        const point: [number, number] = [
          x + dx + index * 6 * scale + col * scale + scale / 2,
          y + dy + row * scale + scale / 2
        ]
        bits += lit(picture, frame, point, isWhite) ? '1' : '0'
      }
    }
    const char = LABEL_CHARS.split('').find(c => glyph(c) === bits)
    if (char == null) break
    label += char
  }
  return label
}

/**
 * When a camera's burned clock read zero, and how long it runs before it
 * reads zero again: a fixture's clock counts from its start and starts over
 * each loop, as a day's clock does at midnight.
 */
export interface ClockBase {
  startedAtMs: number
  loopMs: number
}

export const DAY_MS = 86_400_000

/** How far the publisher's clock may run ahead of this machine's. */
export const CLOCK_SKEW_MS = 5000

/** A clock that shows the time of day on a bench `offsetMinutes` from UTC. */
export function benchClock(offsetMinutes = 0): ClockBase {
  return { startedAtMs: -offsetMinutes * 60_000, loopMs: DAY_MS }
}

/**
 * The epoch millisecond a reading shows: in the latest loop of `base` whose
 * frame is not after `nearMs`, the moment the picture was taken, since a
 * watcher never shows a frame before it was sent. A scrub back further than
 * a whole loop would read a loop too late.
 */
export function readingEpochMs(
  reading: Pick<ClockReading, 'msOfDay'>,
  nearMs: number,
  base: ClockBase
): number {
  const { startedAtMs, loopMs } = base
  const loop = Math.floor(
    (nearMs + CLOCK_SKEW_MS - startedAtMs - reading.msOfDay) / loopMs
  )
  return startedAtMs + Math.max(0, loop) * loopMs + reading.msOfDay
}

/**
 * Where a synthetic camera's frame is in a picture that shows one, found
 * from its ink alone: the clock's top, the counter's bottom and the counter's
 * leading zero's left edge are at known places in the frame, so the yellow
 * between them gives the frame's place and size. For a player whose bounds
 * the page does not give away (a web page's single video, in Safari). Null
 * when the picture shows too little ink to be a frame.
 */
export function findPicture(picture: Picture, minInk = 3): Box | null {
  const rows = new Array<number>(picture.height).fill(0)
  const columns = new Array<number>(picture.width).fill(0)
  for (let y = 0; y < picture.height; y++) {
    for (let x = 0; x < picture.width; x++) {
      const at = (y * picture.width + x) * 4
      if (isInk(picture.data[at], picture.data[at + 1], picture.data[at + 2])) {
        rows[y]++
        columns[x]++
      }
    }
  }
  // A row of the clock or the counter is a run of digits: a badge's or an
  // icon's few edge pixels that happen to blend to the ink's colour are not.
  const rowInk = Math.max(minInk, Math.round(picture.width * 0.02))
  const top = rows.findIndex(n => n >= rowInk)
  const bottom = rows.findLastIndex(n => n >= rowInk)
  const left = columns.findIndex(n => n >= minInk)
  if (top < 0 || bottom <= top || left < 0) return null
  const scale =
    (bottom + 1 - top) / (COUNTER_ORIGIN.y + COUNTER_ORIGIN.h - CLOCK_ORIGIN.y)
  // Smaller than a thumbnail is not a picture anyone is watching.
  if (WIDTH * scale < 160) return null
  return {
    x: left - COUNTER_ORIGIN.x * scale,
    y: top - CLOCK_ORIGIN.y * scale,
    w: WIDTH * scale,
    h: HEIGHT * scale
  }
}
