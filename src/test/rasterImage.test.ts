import { expect } from 'chai'
import jpeg from 'jpeg-js'
import { describe, it } from 'mocha'

import {
  decodeRaster,
  encodePng,
  pngFromJpeg,
  roundHalfEven
} from './rasterImage'

const pixels = Buffer.from([255, 0, 0, 255, 0, 255, 0, 128])

function sampleJpeg(): Buffer {
  const { data } = jpeg.encode(
    { width: 2, height: 2, data: Buffer.alloc(16, 200) },
    100
  )
  return Buffer.from(data)
}

describe('rasterImage', function () {
  it('reads a PNG back exactly as it was written', function () {
    const raster = decodeRaster(encodePng(2, 1, pixels))
    expect(raster).includes({ format: 'PNG', width: 2, height: 1 })
    expect(raster.mode).equals('RGBA')
    expect(raster.data.equals(pixels)).equals(true)
  })

  it('reads a JPEG as RGBA with its stored channels named', function () {
    const raster = decodeRaster(sampleJpeg())
    expect(raster).includes({ format: 'JPEG', mode: 'RGB', width: 2 })
    expect(raster.data.length).equals(16)
  })

  it('refuses a PNG with no end chunk', function () {
    const png = encodePng(2, 1, pixels)
    expect(() => decodeRaster(png.subarray(0, -12))).throws('Truncated PNG')
  })

  it('refuses a JPEG with no end marker', function () {
    expect(() => decodeRaster(sampleJpeg().subarray(0, -2))).throws(
      'Truncated JPEG'
    )
  })

  it('refuses anything else', function () {
    expect(() => decodeRaster(Buffer.from('No image'))).throws(
      'Unknown image codec'
    )
  })

  it('converts a JPEG to a PNG holding the same pixels', function () {
    const source = sampleJpeg()
    const { png, decodedPixelsEqual, decodedPixelSha256 } = pngFromJpeg(source)
    expect(decodedPixelsEqual).equals(true)
    expect(decodedPixelSha256).matches(/^[0-9a-f]{64}$/)
    expect(decodeRaster(png).data.equals(decodeRaster(source).data)).equals(
      true
    )
  })

  it('rounds a half to the even neighbour', function () {
    expect([0.5, 1.5, 2.5, 3.5].map(roundHalfEven)).deep.equals([0, 2, 2, 4])
    expect([1.4, 1.6, 3].map(roundHalfEven)).deep.equals([1, 2, 3])
  })
})
