import { useEffect, useMemo } from 'react'
import {
  DataTexture,
  LinearFilter,
  LinearMipmapLinearFilter,
  RepeatWrapping,
  SRGBColorSpace
} from 'three'

/** Small, deterministic tiled albedo maps. No DOM/canvas or asset requests. */
export function makeSurfaceTexture(
  kind: 'grass' | 'dirt' | 'wall' | 'cloth'
): DataTexture {
  const size = 256
  const pixels = new Uint8Array(size * size * 4)
  let seed = 9143
  const random = (): number => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return seed / 4294967296
  }
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const noise = random()
      const broad = Math.sin((x * Math.PI) / 32) * Math.cos((y * Math.PI) / 64)
      let value = 205 + noise * 38
      if (kind === 'grass')
        value =
          167 +
          noise * 70 +
          broad * 15 +
          Math.sin((x + Math.floor(y / 7)) * 2) * 12 +
          ((Math.floor(x / 128) + Math.floor(y / 128)) % 2 === 0 ? 10 : -10)
      if (kind === 'dirt')
        value = 191 + noise * 46 + broad * 15 - (noise < 0.07 ? 65 : 0)
      if (kind === 'wall')
        value = 209 + noise * 21 - (x % 64 < 2 ? 48 : 0) - (y % 64 < 2 ? 26 : 0)
      if (kind === 'cloth')
        value = 212 + noise * 25 - (x % 3 === 0 || y % 3 === 0 ? 18 : 0)
      const index = (y * size + x) * 4
      pixels[index] =
        pixels[index + 1] =
        pixels[index + 2] =
          Math.max(0, Math.min(255, value))
      pixels[index + 3] = 255
    }
  const texture = new DataTexture(pixels, size, size)
  texture.colorSpace = SRGBColorSpace
  texture.wrapS = texture.wrapT = RepeatWrapping
  texture.minFilter = LinearMipmapLinearFilter
  texture.magFilter = LinearFilter
  texture.generateMipmaps = true
  texture.anisotropy = 2
  texture.repeat.setScalar(
    kind === 'wall' || kind === 'cloth' ? 1 : kind === 'grass' ? 1 / 16 : 1 / 8
  )
  texture.needsUpdate = true
  return texture
}
export function useSurfaceTextures(): Record<
  'grass' | 'dirt' | 'wall' | 'cloth',
  DataTexture
> {
  const textures = useMemo(
    () => ({
      grass: makeSurfaceTexture('grass'),
      dirt: makeSurfaceTexture('dirt'),
      wall: makeSurfaceTexture('wall'),
      cloth: makeSurfaceTexture('cloth')
    }),
    []
  )
  useEffect(
    () => () => {
      Object.values(textures).forEach(texture => {
        texture.dispose()
      })
    },
    [textures]
  )
  return textures
}
