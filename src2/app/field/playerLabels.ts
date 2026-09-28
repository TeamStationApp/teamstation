import { DataTexture, LinearFilter, SRGBColorSpace } from 'three'

import { bulbGlyph } from './bulbFont'

/** Jersey digits on the uniform. Field names are screen-space text, not this bitmap. */
export function makePlayerLabel(text: string): DataTexture {
  const width = 64
  const height = 64
  const pixels = new Uint8Array(width * height * 4)
  const put = (x: number, y: number, color: number[]): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    pixels.set(color, ((height - y - 1) * width + x) * 4)
  }
  const pitch = Math.min(6, (width - 16) / Math.max(1, text.length) / 6)
  const left = (width - (text.length * 6 - 1) * pitch) / 2
  const top = (height - 7 * pitch) / 2
  Array.from(text.toUpperCase()).forEach((letter, index) => {
    bulbGlyph(letter).forEach((row, y) => {
      Array.from(row).forEach((bit, x) => {
        if (bit !== '1') return
        for (let yy = 0; yy < Math.ceil(pitch); yy++)
          for (let xx = 0; xx < Math.ceil(pitch); xx++)
            put(
              Math.floor(left + (index * 6 + x) * pitch + xx),
              Math.floor(top + y * pitch + yy),
              [255, 255, 255, 255]
            )
      })
    })
  })
  const texture = new DataTexture(pixels, width, height)
  texture.colorSpace = SRGBColorSpace
  texture.minFilter = texture.magFilter = LinearFilter
  texture.needsUpdate = true
  return texture
}
