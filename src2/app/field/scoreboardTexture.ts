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
export const BOARD_HEIGHT = 512
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
  rect(14, 14, 996, 2, brass)
  rect(14, 496, 996, 2, brass)
  rect(14, 14, 2, 484, brass)
  rect(1008, 14, 2, 484, brass)
  for (const y of [76, 214, 366]) rect(30, y, 964, 2, brass)
  rect(810, 88, 2, 114, brass)
  for (let x = 26; x < 1000; x += 48) {
    lamp(x, 24, 2, [130, 122, 94], false)
    lamp(x, 487, 2, [130, 122, 94], false)
  }
  text('GAMESTATION BALLPARK', 290, 32, 4)
  text('AWAY', 55, 103, 4.5)
  text(state.awayTeam, 220, 101, 6, 16)
  text(
    String(Math.max(0, Math.min(99, state.awayScore))).padStart(2, '0'),
    860,
    96,
    6
  )
  text('HOME', 55, 163, 4.5)
  text(state.homeTeam, 220, 161, 6, 16)
  text(
    String(Math.max(0, Math.min(99, state.homeScore))).padStart(2, '0'),
    860,
    156,
    6
  )
  if (state.showPlayerNames === true) {
    text(shortName(state.batter), 55, 243, 5.5, 14)
    text(shortName(state.pitcher), 540, 243, 5.5, 14)
  }
  const statsY = state.showPlayerNames === true ? 310 : 268
  text(battingLine(state), 55, statsY, 6)
  text('PITCHES', 540, statsY + 2, 3.5)
  text(String(Math.max(0, Math.min(999, state.pitchCount))), 725, statsY - 4, 6)
  text('BALLS', 108, 386, 4)
  text('STRIKES', 409, 386, 4)
  text('OUTS', 787, 386, 4)
  countLights(state.balls, 3).forEach((lit, i) => {
    lamp(118 + i * 42, 449, 11, [70, 244, 105], lit)
  })
  countLights(state.strikes, 2).forEach((lit, i) => {
    lamp(459 + i * 42, 449, 11, [255, 211, 55], lit)
  })
  countLights(state.outs, 2).forEach((lit, i) => {
    lamp(809 + i * 42, 449, 11, [255, 73, 54], lit)
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
