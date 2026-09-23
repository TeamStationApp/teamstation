import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  SRGBColorSpace
} from 'three'

import { bulbGlyph } from './bulbFont'
import {
  battingLine,
  countLights,
  pitchLabel,
  type ScoreboardState,
  scoreDigits,
  shortName
} from './scoreboardModel'
import { BALL_LAMP, STRIKE_LAMP } from './scoreboardPalette'

export const BOARD_WIDTH = 1024
export const BOARD_HEIGHT = 256
/** Inset shared by the frame, the count lamps, and the right edge of a line. */
export const SCOREBOARD_MARGIN = 16
/** Horizontal rule, centered so the two bands are the same height. */
export const SCOREBOARD_RULE_Y = 127
const INNER_LEFT = 16
const INNER_TOP = 12
const INNER_RIGHT = 1007
const BAND_TOP = SCOREBOARD_RULE_Y + 2
const BAND_BOTTOM = 243
const LAMP_R = 8
const LAMP_STEP = 34
const LETTER_BRIGHTNESS = 2.8125 * 1.5
const TEAM_PITCH = 5.5
/** Same bulb pitch and radius as the team names. */
const BULB_RADIUS = 0.3
/** One scoreboard light shorter than the previous name height. */
const NAME_PITCH = (3.5 * 1.5 * 6) / 7
const INNING_PITCH = TEAM_PITCH
/** Four team-letter lights tall, widening 1, 3, 5, 7 from the tip. */
const ARROW_ROWS = 4
const ARROW_PITCH = TEAM_PITCH
const ARROW_H = (ARROW_ROWS - 1) * ARROW_PITCH
const ARROW_W = (ARROW_ROWS * 2 - 2) * ARROW_PITCH
const MARK_PITCH = 4
const inningInk = (chars: number): number =>
  chars <= 0 ? 0 : (chars * 6 - 1) * INNING_PITCH
const countInk = (1 * 6 - 1) * MARK_PITCH + 10 + LAMP_R * 2 + LAMP_STEP * 2
const columnInk = Math.max(ARROW_W + SCOREBOARD_MARGIN + inningInk(2), countInk)
/** The left column uses the same inset the team names use inside their panel. */
export const SCOREBOARD_RULE_X = Math.round(
  INNER_LEFT + SCOREBOARD_MARGIN + columnInk + SCOREBOARD_MARGIN
)
const CONTENT_LEFT = INNER_LEFT + SCOREBOARD_MARGIN
export const SCOREBOARD_TEXT_LEFT = SCOREBOARD_RULE_X + 2 + SCOREBOARD_MARGIN
export const SCOREBOARD_TEXT_RIGHT = INNER_RIGHT - SCOREBOARD_MARGIN
export const COUNT_LAMP_RADIUS = LAMP_R
export const COUNT_LAMP_X = [
  CONTENT_LEFT + (1 * 6 - 1) * MARK_PITCH + 10 + LAMP_R,
  CONTENT_LEFT + (1 * 6 - 1) * MARK_PITCH + 10 + LAMP_R + LAMP_STEP,
  CONTENT_LEFT + (1 * 6 - 1) * MARK_PITCH + 10 + LAMP_R + LAMP_STEP * 2
]
const COUNT_Y0 = BAND_TOP + SCOREBOARD_MARGIN + LAMP_R
const COUNT_Y2 = BAND_BOTTOM - SCOREBOARD_MARGIN - LAMP_R
export const COUNT_LAMP_Y = [COUNT_Y0, (COUNT_Y0 + COUNT_Y2) / 2, COUNT_Y2]
const BOARD_BYTES = BOARD_WIDTH * BOARD_HEIGHT * 4
/** Mixes one colour into a pixel, rows stored bottom-up (see `makeScoreboardPixels`). */
function put(
  pixels: Uint8Array,
  x: number,
  y: number,
  rgb: readonly number[],
  alpha = 1
): void {
  if (x < 0 || y < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return
  const i = ((BOARD_HEIGHT - 1 - y) * BOARD_WIDTH + x) * 4
  for (let c = 0; c < 3; c++) {
    const mixed = pixels[i + c] * (1 - alpha) + Math.min(255, rgb[c]) * alpha
    pixels[i + c] = Math.max(0, Math.min(255, mixed))
  }
  pixels[i + 3] = 255
}
const rect = (
  pixels: Uint8Array,
  x: number,
  y: number,
  w: number,
  h: number,
  rgb: number[]
): void => {
  for (let yy = y; yy < y + h; yy++)
    for (let xx = x; xx < x + w; xx++) put(pixels, xx, yy, rgb)
}
/**
 * The painted board with nothing lit on it, and the same with its brass
 * frame: the same on every board, so painted once and copied.
 */
let blankBoard: Uint8Array | undefined
let framedBoard: Uint8Array | undefined
function blank(): Uint8Array {
  if (blankBoard == null) {
    blankBoard = new Uint8Array(BOARD_BYTES)
    for (let y = 0; y < BOARD_HEIGHT; y++)
      for (let x = 0; x < BOARD_WIDTH; x++) {
        const noise = ((x * 73 + y * 37 + x * y) % 13) / 4
        const seam = x % 128 < 2 ? -5 : 0
        put(blankBoard, x, y, [
          12 + noise + seam,
          27 + noise + seam,
          23 + noise + seam
        ])
      }
  }
  return blankBoard
}
function framed(): Uint8Array {
  if (framedBoard == null) {
    framedBoard = blank().slice()
    const brass = [86, 92, 65]
    rect(framedBoard, 14, 10, 996, 2, brass)
    rect(framedBoard, 14, 244, 996, 2, brass)
    rect(framedBoard, 14, 10, 2, 236, brass)
    rect(framedBoard, 1008, 10, 2, 236, brass)
    // Two equal bands. Inning and the count on the left, teams and batters on the right.
    rect(framedBoard, 16, SCOREBOARD_RULE_Y, 992, 2, brass)
    rect(framedBoard, SCOREBOARD_RULE_X, INNER_TOP, 2, 232, brass)
  }
  return framedBoard
}
/**
 * One bulb and its halo, as the mixes it makes, pixel by pixel in order, for
 * a bulb whose centre sits `fx`, `fy` past a whole pixel. A board lights
 * about 1500 bulbs, and working each one's falloff out again cost a phone
 * most of the 150 ms a board took; a bulb in the same place within its pixel
 * mixes exactly the same.
 */
type BulbStamp = Float64Array
/** A stamp's mixes, each as its pixel's offset, its colour and its alpha. */
const MIX = 6
const stamps = new Map<string, BulbStamp>()
function bulbStamp(
  fx: number,
  fy: number,
  radius: number,
  color: number[],
  lit: boolean,
  brightness: number
): BulbStamp {
  const key = `${fx}|${fy}|${radius}|${color.join(',')}|${lit}|${brightness}`
  const known = stamps.get(key)
  if (known != null) return known
  const mixes: number[] = []
  const mix = (dx: number, dy: number, rgb: number[], alpha: number): void => {
    mixes.push(
      dx,
      dy,
      Math.min(255, rgb[0]),
      Math.min(255, rgb[1]),
      Math.min(255, rgb[2]),
      alpha
    )
  }
  const halo = radius * 2.8
  for (let yy = Math.floor(fy - halo); yy <= fy + halo; yy++)
    for (let xx = Math.floor(fx - halo); xx <= fx + halo; xx++) {
      const distance = Math.hypot(xx - fx, yy - fy)
      if (distance > halo) continue
      if (lit)
        mix(
          xx,
          yy,
          color,
          Math.exp((-distance * distance) / (radius * radius * 2)) *
            0.3 *
            (brightness > 1 ? brightness / 1.25 : 1)
        )
      if (distance < radius)
        mix(
          xx,
          yy,
          lit ? color : color.map(value => value * 0.13),
          Math.min(1, radius - distance)
        )
      if (lit && distance < radius * 0.45)
        mix(
          xx,
          yy,
          color.map(value => value * 0.6 + 102),
          0.85
        )
    }
  const stamp = Float64Array.from(mixes)
  stamps.set(key, stamp)
  return stamp
}
/** Individual bulbs and their halos baked into one 2 MiB map, not point lights or bloom passes. */
export function makeScoreboardPixels(state: ScoreboardState): Uint8Array {
  // Store rows bottom-up for DataTexture's UV convention, without browser flipY.
  const plain = state.celebration != null || state.instruction != null
  const pixels = (plain ? blank() : framed()).slice()
  const lamp = (
    x: number,
    y: number,
    radius: number,
    color: number[],
    lit = true,
    brightness = 1
  ): void => {
    color = color.map(channel => Math.min(255, channel * brightness))
    const left = Math.floor(x)
    const top = Math.floor(y)
    const stamp = bulbStamp(x - left, y - top, radius, color, lit, brightness)
    // `put`, inlined: this runs about 150 000 times a board.
    for (let m = 0; m < stamp.length; m += MIX) {
      const px = left + stamp[m]
      const py = top + stamp[m + 1]
      if (px < 0 || py < 0 || px >= BOARD_WIDTH || py >= BOARD_HEIGHT) continue
      const i = ((BOARD_HEIGHT - 1 - py) * BOARD_WIDTH + px) * 4
      const alpha = stamp[m + 5]
      for (let c = 0; c < 3; c++) {
        const mixed = pixels[i + c] * (1 - alpha) + stamp[m + 2 + c] * alpha
        pixels[i + c] = Math.max(0, Math.min(255, mixed))
      }
      pixels[i + 3] = 255
    }
  }
  const text = (
    value: string,
    x: number,
    y: number,
    pitch: number,
    maxChars = 32,
    radiusScale = 0.3
  ): void => {
    Array.from(value.toUpperCase().slice(0, maxChars)).forEach((letter, i) => {
      bulbGlyph(letter).forEach((row, r) => {
        Array.from(row).forEach((bit, c) => {
          if (bit === '1')
            lamp(
              x + (i * 6 + c) * pitch,
              y + r * pitch,
              pitch * radiusScale,
              [255, 190, 91],
              true,
              LETTER_BRIGHTNESS
            )
        })
      })
    })
  }
  if (state.celebration != null) {
    const inPark = state.celebration.kind === 'in-park'
    text('HOME RUN', (BOARD_WIDTH - 47 * 10) / 2, inPark ? 126 : 98, 10)
    if (inPark) text('IN THE PARK', (BOARD_WIDTH - 65 * 3.8) / 2, 64, 3.8)
    return pixels
  }
  if (state.instruction != null) {
    const words = state.instruction.split(' ')
    const lines: string[] = ['']
    for (const word of words) {
      const index = lines.length - 1
      if (`${lines[index]} ${word}`.trim().length > 35) lines.push(word)
      else lines[index] = `${lines[index]} ${word}`.trim()
    }
    lines.forEach((line, index) => {
      text(line, 45, 35 + index * 52, 4, 38)
    })
    if (state.detail != null) text(state.detail, 180, 200, 4, 30)
    return pixels
  }
  const ink = (chars: number, pitch: number): number =>
    chars <= 0 ? 0 : (chars * 6 - 1) * pitch
  // Names stay left. The stat stays right. Two character cells remain between them.
  const lineText = (
    name: string,
    stat: string,
    y: number,
    pitch: number
  ): void => {
    const statX = SCOREBOARD_TEXT_RIGHT - ink(stat.length, pitch)
    const room = statX - 12 * pitch - SCOREBOARD_TEXT_LEFT
    const max = Math.max(1, Math.floor((room / pitch + 1) / 6))
    text(name, SCOREBOARD_TEXT_LEFT, y, pitch, max)
    text(stat, statX, y, pitch)
  }
  const teamH = 7 * TEAM_PITCH
  const teamGap = 12
  const teamBlock = teamH * 2 + teamGap
  const teamY = INNER_TOP + (SCOREBOARD_RULE_Y - INNER_TOP - teamBlock) / 2
  lineText(state.awayTeam, scoreDigits(state.awayScore), teamY, TEAM_PITCH)
  lineText(
    state.homeTeam,
    scoreDigits(state.homeScore),
    teamY + teamH + teamGap,
    TEAM_PITCH
  )
  const markX = CONTENT_LEFT
  ;(['B', 'S', 'O'] as const).forEach((mark, index) => {
    text(mark, markX, COUNT_LAMP_Y[index] - (7 * MARK_PITCH) / 2, MARK_PITCH)
  })
  countLights(state.balls, 3).forEach((lit, i) => {
    lamp(COUNT_LAMP_X[i], COUNT_LAMP_Y[0], LAMP_R, BALL_LAMP, lit)
  })
  countLights(state.strikes, 2).forEach((lit, i) => {
    lamp(COUNT_LAMP_X[i], COUNT_LAMP_Y[1], LAMP_R, STRIKE_LAMP, lit)
  })
  countLights(state.outs, 2).forEach((lit, i) => {
    lamp(COUNT_LAMP_X[i], COUNT_LAMP_Y[2], LAMP_R, [255, 73, 54], lit)
  })
  const nameH = 7 * NAME_PITCH
  const nameGap = 14
  const nameBlock = nameH * 2 + nameGap
  const bandTop = SCOREBOARD_RULE_Y + 2
  const bandHeight = 244 - bandTop
  const nameY = bandTop + (bandHeight - nameBlock) / 2
  lineText(shortName(state.batter), battingLine(state), nameY, NAME_PITCH)
  lineText(
    shortName(state.pitcher),
    pitchLabel(state.pitchCount),
    nameY + nameH + nameGap,
    NAME_PITCH
  )
  const inning = scoreDigits(state.inning)
  const inningW = ink(inning.length, INNING_PITCH)
  const numberH = 7 * INNING_PITCH
  const bandCenter = INNER_TOP + (SCOREBOARD_RULE_Y - INNER_TOP) / 2
  const boxWidth = SCOREBOARD_RULE_X - INNER_LEFT
  const groupW = ARROW_W + SCOREBOARD_MARGIN + inningW
  const arrowX = INNER_LEFT + (boxWidth - groupW) / 2
  const numberX = arrowX + ARROW_W + SCOREBOARD_MARGIN
  const numberY = bandCenter - numberH / 2
  const arrowY = bandCenter - ARROW_H / 2
  const pointUp = state.half !== 'bottom'
  const centerX = arrowX + ARROW_W / 2
  for (let r = 0; r < ARROW_ROWS; r++) {
    const fromTip = pointUp ? r : ARROW_ROWS - 1 - r
    const y = Math.round(arrowY + r * ARROW_PITCH)
    const bulbs = 1 + fromTip * 2
    for (let i = 0; i < bulbs; i++) {
      const x = Math.round(centerX + (i - (bulbs - 1) / 2) * ARROW_PITCH)
      lamp(
        x,
        y,
        ARROW_PITCH * BULB_RADIUS,
        [255, 190, 91],
        true,
        LETTER_BRIGHTNESS
      )
    }
  }
  text(inning, Math.round(numberX), Math.round(numberY), INNING_PITCH)
  return pixels
}
export function makeScoreboardTexture(state: ScoreboardState): DataTexture {
  const texture = new DataTexture(
    makeScoreboardPixels(state),
    BOARD_WIDTH,
    BOARD_HEIGHT
  )
  texture.colorSpace = SRGBColorSpace
  texture.minFilter = LinearMipmapLinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 2
  texture.needsUpdate = true
  return texture
}
