import { DataTexture, LinearFilter, SRGBColorSpace } from 'three'

import { bulbGlyph } from './bulbFont'

/** Small portable bitmap labels; no browser canvas, font downloads or DOM overlays. */
export function makePlayerLabel(text: string, badge: boolean): DataTexture {
  const width = badge ? 256 : 64
  const height = 64
  const pixels = new Uint8Array(width * height * 4)
  const put = (x: number, y: number, color: number[]): void => {
    if (x < 0 || y < 0 || x >= width || y >= height) return
    pixels.set(color, ((height - y - 1) * width + x) * 4)
  }
  if (badge) {
    for (let y = 0; y < height; y++)
      for (let x = 0; x < width; x++) {
        const dx = Math.max(12 - x, x - (width - 13), 0)
        const dy = Math.max(12 - y, y - (height - 13), 0)
        if (dx * dx + dy * dy < 144) put(x, y, [18, 39, 36, 242])
      }
  }
  const pitch = Math.min(badge ? 4 : 6, (width - 16) / (text.length * 6))
  const left = (width - (text.length * 6 - 1) * pitch) / 2
  const top = (height - 7 * pitch) / 2
  Array.from(text.toUpperCase()).forEach((letter, index) => {
    if (letter === '⚾') {
      const radius = 2.7 * pitch
      const cx = left + (index * 6 + 2) * pitch
      const cy = top + 3 * pitch
      for (let y = Math.floor(cy - radius); y <= cy + radius; y++)
        for (let x = Math.floor(cx - radius); x <= cx + radius; x++) {
          const dx = x - cx
          const dy = y - cy
          if (dx * dx + dy * dy > radius * radius) continue
          const seam =
            Math.abs(Math.abs(dx) - (radius * 0.5 - Math.abs(dy) * 0.15)) <
            pitch * 0.35
          put(x, y, seam ? [196, 48, 42, 255] : [255, 246, 221, 255])
        }
      return
    }
    bulbGlyph(letter).forEach((row, y) => {
      Array.from(row).forEach((bit, x) => {
        if (bit !== '1') return
        for (let yy = 0; yy < Math.ceil(pitch); yy++)
          for (let xx = 0; xx < Math.ceil(pitch); xx++)
            put(
              Math.floor(left + (index * 6 + x) * pitch + xx),
              Math.floor(top + y * pitch + yy),
              [255, 246, 221, 255]
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
