import { expect } from 'chai'
import { describe, it } from 'mocha'

import { jpegBytes, pngBytes } from '../../test/sponsorMedia'
import { imageHeader } from './imageHeader'

describe('U3 imageHeader', function () {
  it('reads a PNG’s size from its IHDR', function () {
    expect(imageHeader(pngBytes(480, 270))).deep.equals({
      type: 'image/png',
      width: 480,
      height: 270
    })
  })

  it('reads a baseline and a progressive JPEG’s size from its frame', function () {
    expect(imageHeader(jpegBytes(300, 200))).deep.equals({
      type: 'image/jpeg',
      width: 300,
      height: 200
    })
    expect(imageHeader(jpegBytes(128, 128, 0xc2))).deep.equals({
      type: 'image/jpeg',
      width: 128,
      height: 128
    })
  })

  it('refuses a GIF, a truncated PNG and a JPEG with no frame', function () {
    expect(imageHeader(Buffer.from('GIF89a\x01\x00\x01\x00', 'latin1'))).equals(
      null
    )
    expect(imageHeader(pngBytes(480, 270).subarray(0, 20))).equals(null)
    const noFrame = Buffer.from([
      0xff, 0xd8, 0xff, 0xe0, 0x00, 0x04, 0x00, 0x00, 0xff, 0xda, 0x00, 0x02,
      0xff, 0xd9
    ])
    expect(imageHeader(noFrame)).equals(null)
    expect(
      imageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xd9, 0x00, 0x00]))
    ).equals(null)
  })

  it('refuses a PNG without IHDR first, a zero size and broken JPEG segments', function () {
    const wrongChunk = pngBytes(10, 10)
    wrongChunk.write('IDAT', 12, 'latin1')
    expect(imageHeader(wrongChunk)).equals(null)
    expect(imageHeader(pngBytes(0, 10))).equals(null)
    expect(imageHeader(jpegBytes(0, 10))).equals(null)
    // A segment that does not start with a marker.
    expect(
      imageHeader(Buffer.from([0xff, 0xd8, 0x00, 0x00, 0x00, 0x00]))
    ).equals(null)
    // A segment length under 2.
    expect(
      imageHeader(Buffer.from([0xff, 0xd8, 0xff, 0xe1, 0x00, 0x01, 0x00]))
    ).equals(null)
    // A frame cut short.
    expect(imageHeader(jpegBytes(300, 200).subarray(0, 26))).equals(null)
    expect(
      imageHeader(Buffer.from([0xff, 0xd8, 0xff, 0x01, 0xff, 0xd9, 0, 0]))
    ).equals(null)
  })
})
