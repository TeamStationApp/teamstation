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
  type ScoreboardState,
  shortName
} from './scoreboardModel'

export const BOARD_WIDTH = 1024
export const BOARD_HEIGHT = 256
/** Individual bulbs and their halos baked into one 2 MiB map, not point lights or bloom passes. */
export function makeScoreboardPixels(state: ScoreboardState): Uint8Array {
  const pixels = new Uint8Array(BOARD_WIDTH * BOARD_HEIGHT * 4)
  // Store rows bottom-up for DataTexture's UV convention, without browser flipY.
  const put = (x: number, y: number, rgb: number[], alpha = 1): void => {
    if (x < 0 || y < 0 || x >= BOARD_WIDTH || y >= BOARD_HEIGHT) return
    const i = ((BOARD_HEIGHT - 1 - y) * BOARD_WIDTH + x) * 4
    for (let c = 0; c < 3; c++)
      pixels[i + c] =
        pixels[i + c] * (1 - alpha) + Math.min(255, rgb[c]) * alpha
    pixels[i + 3] = 255
  }
  for (let y = 0; y < BOARD_HEIGHT; y++)
    for (let x = 0; x < BOARD_WIDTH; x++) {
      const noise = ((x * 73 + y * 37 + x * y) % 13) / 4
      const seam = x % 128 < 2 ? -5 : 0
      put(x, y, [12 + noise + seam, 27 + noise + seam, 23 + noise + seam])
    }
  const rect = (
    x: number,
    y: number,
    w: number,
    h: number,
    rgb: number[]
  ): void => {
    for (let yy = y; yy < y + h; yy++)
      for (let xx = x; xx < x + w; xx++) put(xx, yy, rgb)
  }
  const lamp = (
    x: number,
    y: number,
    radius: number,
    color: number[],
    lit = true,
    brightness = 1
  ): void => {
    color = color.map(channel => Math.min(255, channel * brightness))
    const halo = radius * 2.8
    for (let yy = Math.floor(y - halo); yy <= y + halo; yy++)
      for (let xx = Math.floor(x - halo); xx <= x + halo; xx++) {
        const distance = Math.hypot(xx - x, yy - y)
        if (distance > halo) continue
        if (lit)
          put(
            xx,
            yy,
            color,
            Math.exp((-distance * distance) / (radius * radius * 2)) * 0.3
          )
        if (distance < radius)
          put(
            xx,
            yy,
            lit ? color : color.map(value => value * 0.13),
            Math.min(1, radius - distance)
          )
        if (lit && distance < radius * 0.45)
          put(
            xx,
            yy,
            color.map(value => value * 0.6 + 102),
            0.85
          )
      }
  }
  const text = (
    value: string,
    x: number,
    y: number,
    pitch: number,
    maxChars = 32
  ): void => {
    Array.from(value.toUpperCase().slice(0, maxChars)).forEach((letter, i) => {
      bulbGlyph(letter).forEach((row, r) => {
        Array.from(row).forEach((bit, c) => {
          if (bit === '1')
            lamp(
              x + (i * 6 + c) * pitch,
              y + r * pitch,
              pitch * 0.3,
              [255, 190, 91],
              true,
              1.25
            )
        })
      })
    })
  }
  const brass = [86, 92, 65]
  rect(14, 10, 996, 2, brass)
  rect(14, 244, 996, 2, brass)
  rect(14, 10, 2, 236, brass)
  rect(1008, 10, 2, 236, brass)
  for (const y of [118, 182]) rect(30, y, 964, 2, brass)
  text('AWAY', 40, 23, 4)
  text(state.awayTeam, 200, 20, 5.5, 16)
  text(String(state.awayScore).padStart(2, '0'), 860, 20, 5.5)
  text('HOME', 40, 76, 4)
  text(state.homeTeam, 200, 73, 5.5, 16)
  text(String(state.homeScore).padStart(2, '0'), 860, 73, 5.5)
  // One compact line: batter, hits-at-bats, pitcher, pitch count.
  text(shortName(state.batter), 40, 140, 3.5, 12)
  text(battingLine(state), 315, 140, 3.5, 7)
  text(shortName(state.pitcher), 485, 140, 3.5, 12)
  text(`P:${Math.max(0, Math.min(999, state.pitchCount))}`, 790, 140, 3.5, 6)
  text('BALLS', 40, 204, 3.5)
  text('STRIKES', 355, 204, 3.5)
  text('OUTS', 745, 204, 3.5)
  countLights(state.balls, 3).forEach((lit, i) => {
    lamp(178 + i * 35, 216, 9, [70, 244, 105], lit)
  })
  countLights(state.strikes, 2).forEach((lit, i) => {
    lamp(540 + i * 35, 216, 9, [255, 211, 55], lit)
  })
  countLights(state.outs, 2).forEach((lit, i) => {
    lamp(860 + i * 35, 216, 9, [255, 73, 54], lit)
  })
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
