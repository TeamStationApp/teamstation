/**
 * The synthetic camera's pictures and sound, rendered in Node: 1280×720 RGB frames with
 * a seven-segment wall clock to the millisecond, a seven-segment frame counter, the
 * label in a 5×7 font, and the whole frame white for the first 100 ms of every 10 s,
 * when a 1 kHz tone sounds too. A watcher's screenshot can be read against the bench
 * clock, and the flash and tone line up picture and sound.
 */

export const WIDTH = 1280
export const HEIGHT = 720
export const FPS = 30
export const SAMPLE_RATE = 48000
export const FLASH_EVERY_SEC = 10
export const FLASH_MS = 100
export const TONE_HZ = 1000

export type Rgb = [number, number, number]
export const BACKGROUND: Rgb = [24, 24, 24]
export const INK: Rgb = [255, 200, 0]
export const WHITE: Rgb = [255, 255, 255]

/** Segments a–g, clockwise from the top, g in the middle. */
export const SEGMENTS: Record<string, string> = {
  '0': 'abcdef',
  '1': 'bc',
  '2': 'abged',
  '3': 'abgcd',
  '4': 'fgbc',
  '5': 'afgcd',
  '6': 'afgedc',
  '7': 'abc',
  '8': 'abcdefg',
  '9': 'abcdfg'
}

export interface Box {
  x: number
  y: number
  w: number
  h: number
}

/** Where each segment of a digit in `box` is drawn, with stroke `t`. */
export function segmentRects(box: Box, t: number): Record<string, Box> {
  const { x, y, w, h } = box
  const half = Math.floor(h / 2)
  return {
    a: { x, y, w, h: t },
    b: { x: x + w - t, y, w: t, h: half },
    c: { x: x + w - t, y: y + half, w: t, h: h - half },
    d: { x, y: y + h - t, w, h: t },
    e: { x, y: y + half, w: t, h: h - half },
    f: { x, y, w: t, h: half },
    g: { x, y: y + half - Math.floor(t / 2), w, h: t }
  }
}

/** The centre of a segment, where a test or a reader samples it. */
export function segmentCentre(
  box: Box,
  t: number,
  segment: string
): [number, number] {
  const rect = segmentRects(box, t)[segment]
  return [rect.x + Math.floor(rect.w / 2), rect.y + Math.floor(rect.h / 2)]
}

export interface Layout {
  /** One box per character of the text; separators get a box too. */
  boxes: Box[]
  stroke: number
}

/** Lays a row of seven-segment characters out from (x, y). */
export function sevenSegmentLayout(
  text: string,
  x: number,
  y: number,
  digitW: number,
  digitH: number,
  stroke: number
): Layout {
  const boxes: Box[] = []
  let cursor = x
  for (const char of text) {
    const w = SEGMENTS[char] == null ? stroke * 2 : digitW
    boxes.push({ x: cursor, y, w, h: digitH })
    cursor += w + stroke
  }
  return { boxes, stroke }
}

export const CLOCK_ORIGIN = { x: 80, y: 110, w: 84, h: 160, stroke: 16 }
export const COUNTER_ORIGIN = { x: 80, y: 360, w: 42, h: 80, stroke: 9 }
export const LABEL_ORIGIN = { x: 80, y: 520, scale: 10 }

/** HH:MM:SS.mmm of an epoch millisecond, shifted by the bench's offset from UTC. */
export function clockText(epochMs: number, offsetMinutes = 0): string {
  const shifted = new Date(epochMs + offsetMinutes * 60_000)
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0')
  return `${pad(shifted.getUTCHours())}:${pad(shifted.getUTCMinutes())}:${pad(
    shifted.getUTCSeconds()
  )}.${pad(shifted.getUTCMilliseconds(), 3)}`
}

export function counterText(index: number): string {
  return String(index % 1e8).padStart(8, '0')
}

export function isFlashFrame(index: number, fps = FPS): boolean {
  return index % (fps * FLASH_EVERY_SEC) < Math.round((FLASH_MS * fps) / 1000)
}

/** A 5×7 font for the label: uppercase, digits, space and a few marks. */
const FONT: Record<string, string> = {
  A: '01110100011000111111100011000110001',
  B: '11110100011000111110100011000111110',
  C: '01110100011000010000100001000101110',
  D: '11110100011000110001100011000111110',
  E: '11111100001000011110100001000011111',
  F: '11111100001000011110100001000010000',
  G: '01110100011000010111100011000101111',
  H: '10001100011000111111100011000110001',
  I: '01110001000010000100001000010001110',
  J: '00111000100001000010000101001001100',
  K: '10001100101010011000101001001010001',
  L: '10000100001000010000100001000011111',
  M: '10001110111010110101100011000110001',
  N: '10001100011100110101100111000110001',
  O: '01110100011000110001100011000101110',
  P: '11110100011000111110100001000010000',
  Q: '01110100011000110001101011001001101',
  R: '11110100011000111110101001001010001',
  S: '01111100001000001110000010000111110',
  T: '11111001000010000100001000010000100',
  U: '10001100011000110001100011000101110',
  V: '10001100011000110001100010101000100',
  W: '10001100011000110101101011010101010',
  X: '10001100010101000100010101000110001',
  Y: '10001100010101000100001000010000100',
  Z: '11111000010001000100010001000011111',
  '0': '01110100011001110101110011000101110',
  '1': '00100011000010000100001000010001110',
  '2': '01110100010000100010001000100011111',
  '3': '11111000100010000010000011000101110',
  '4': '00010001100101010010111110001000010',
  '5': '11111100001111000001000011000101110',
  '6': '00110010001000011110100011000101110',
  '7': '11111000010001000100010000100001000',
  '8': '01110100011000101110100011000101110',
  '9': '01110100011000101111000010001001100',
  ' ': '00000000000000000000000000000000000',
  '-': '00000000000000011111000000000000000',
  '.': '00000000000000000000000000110001100',
  ':': '00000011000110000000011000110000000'
}

export function glyph(char: string): string {
  return FONT[char.toUpperCase()] ?? FONT[' ']
}

function fillRect(frame: Buffer, box: Box, color: Rgb): void {
  const x0 = Math.max(0, box.x)
  const y0 = Math.max(0, box.y)
  const x1 = Math.min(WIDTH, box.x + box.w)
  const y1 = Math.min(HEIGHT, box.y + box.h)
  for (let y = y0; y < y1; y++) {
    let at = (y * WIDTH + x0) * 3
    for (let x = x0; x < x1; x++) {
      frame[at++] = color[0]
      frame[at++] = color[1]
      frame[at++] = color[2]
    }
  }
}

function drawSevenSegment(frame: Buffer, text: string, layout: Layout): void {
  Array.from(text).forEach((char, index) => {
    const box = layout.boxes[index]
    const lit = SEGMENTS[char]
    if (lit != null) {
      const rects = segmentRects(box, layout.stroke)
      for (const segment of lit) fillRect(frame, rects[segment], INK)
      return
    }
    // A separator: two dots for ':', one low dot for '.'.
    const t = layout.stroke
    const dot = (y: number): void => {
      fillRect(frame, { x: box.x, y, w: t, h: t }, INK)
    }
    if (char === ':') {
      dot(box.y + Math.floor(box.h / 3))
      dot(box.y + Math.floor((box.h * 2) / 3))
    } else dot(box.y + box.h - t)
  })
}

function drawLabel(frame: Buffer, label: string): void {
  const { x, y, scale } = LABEL_ORIGIN
  Array.from(label).forEach((char, index) => {
    const bits = glyph(char)
    for (let row = 0; row < 7; row++) {
      for (let col = 0; col < 5; col++) {
        if (bits[row * 5 + col] === '1') {
          fillRect(
            frame,
            {
              x: x + index * 6 * scale + col * scale,
              y: y + row * scale,
              w: scale,
              h: scale
            },
            WHITE
          )
        }
      }
    }
  })
}

export function clockLayout(): Layout {
  const { x, y, w, h, stroke } = CLOCK_ORIGIN
  return sevenSegmentLayout('00:00:00.000', x, y, w, h, stroke)
}

export function counterLayout(): Layout {
  const { x, y, w, h, stroke } = COUNTER_ORIGIN
  return sevenSegmentLayout('00000000', x, y, w, h, stroke)
}

export interface FrameInput {
  index: number
  startEpochMs: number
  label: string
  fps?: number
  offsetMinutes?: number
}

/** The epoch millisecond a frame shows. */
export function frameEpochMs(input: FrameInput): number {
  return (
    input.startEpochMs + Math.round((input.index * 1000) / (input.fps ?? FPS))
  )
}

/** One rgb24 frame, WIDTH × HEIGHT × 3 bytes. */
export function renderFrame(
  input: FrameInput,
  frame = Buffer.alloc(WIDTH * HEIGHT * 3)
): Buffer {
  const fps = input.fps ?? FPS
  if (isFlashFrame(input.index, fps)) {
    frame.fill(255)
    return frame
  }
  for (let at = 0; at < frame.length; at += 3) {
    frame[at] = BACKGROUND[0]
    frame[at + 1] = BACKGROUND[1]
    frame[at + 2] = BACKGROUND[2]
  }
  drawSevenSegment(
    frame,
    clockText(frameEpochMs(input), input.offsetMinutes),
    clockLayout()
  )
  drawSevenSegment(frame, counterText(input.index), counterLayout())
  drawLabel(frame, input.label)
  return frame
}

export function pixel(frame: Buffer, x: number, y: number): Rgb {
  const at = (y * WIDTH + x) * 3
  return [frame[at], frame[at + 1], frame[at + 2]]
}

/** Mono s16le samples [from, from + count): a 1 kHz burst under every flash. */
export function renderAudio(
  fromSample: number,
  count: number,
  sampleRate = SAMPLE_RATE
): Buffer {
  const out = Buffer.alloc(count * 2)
  const period = sampleRate * FLASH_EVERY_SEC
  const burst = (sampleRate * FLASH_MS) / 1000
  for (let i = 0; i < count; i++) {
    const n = fromSample + i
    const value =
      n % period < burst
        ? Math.round(Math.sin((2 * Math.PI * TONE_HZ * n) / sampleRate) * 16000)
        : 0
    out.writeInt16LE(value, i * 2)
  }
  return out
}

/** The audio samples that go with a frame. */
export function samplesForFrame(
  index: number,
  fps = FPS,
  sampleRate = SAMPLE_RATE
): [number, number] {
  const from = Math.round((index * sampleRate) / fps)
  const to = Math.round(((index + 1) * sampleRate) / fps)
  return [from, to - from]
}
