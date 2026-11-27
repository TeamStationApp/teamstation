import { expect } from 'chai'
import { after, describe, it } from 'mocha'

import {
  markerGeometry,
  readMarker,
  readMarkerSource,
  unwrapMarker
} from './readMarker'

/** A picture whose marker carries `value`, read through a fake 2D canvas. */
function fakePage(
  value: number | null,
  options: { strip?: number; sentinel?: number; context?: boolean } = {}
): { video: HTMLVideoElement; height: number } {
  const height = 720
  const geometry = markerGeometry(height)
  const brightnessAt = (x: number, y: number): number => {
    const { originX, originY, stride, cell, sentinelSlot } = geometry
    if (y >= originY + cell) return options.strip ?? 0
    const slot = Math.floor((x - originX) / stride)
    if (slot === sentinelSlot) return options.sentinel ?? 255
    if (value == null) return 0
    return Math.floor(value / 2 ** slot) % 2 === 1 ? 255 : 0
  }
  const context = {
    drawImage: () => undefined,
    getImageData: (x: number, y: number, w: number, h: number) => {
      const level = brightnessAt(x, y)
      return { data: new Uint8ClampedArray(w * h * 4).fill(level) }
    }
  }
  const make = (): unknown => ({
    getContext: () => (options.context === false ? null : context)
  })
  const page = globalThis as { document?: { createElement: unknown } }
  if (page.document == null) {
    Object.defineProperty(globalThis, 'document', {
      value: { createElement: make },
      configurable: true,
      writable: true
    })
  } else {
    page.document.createElement = make
  }
  const video: Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight'> = {
    videoWidth: 1280,
    videoHeight: height
  }
  return { video: video as HTMLVideoElement, height }
}

describe('the wall-clock marker', function () {
  const page = globalThis as { document?: { createElement: unknown } }
  const had = page.document
  const createElement = had?.createElement
  after(function () {
    if (had == null) {
      Reflect.deleteProperty(globalThis, 'document')
    } else {
      had.createElement = createElement
    }
  })

  it('reads the low 32 bits a frame carries', function () {
    const value = 0xdeadbeef
    const { video, height } = fakePage(value)
    expect(readMarker(video, markerGeometry(height))).equals(value)
  })

  it('reads nothing with no picture, a covered marker or no canvas', function () {
    const geometry = markerGeometry(720)
    const blank: Pick<HTMLVideoElement, 'videoWidth' | 'videoHeight'> = {
      videoWidth: 0,
      videoHeight: 0
    }
    expect(readMarker(blank as HTMLVideoElement, geometry)).equals(null)
    expect(readMarker(fakePage(5, { sentinel: 0 }).video, geometry)).equals(
      null
    )
    expect(readMarker(fakePage(5, { strip: 255 }).video, geometry)).equals(null)
    expect(readMarker(fakePage(5, { context: false }).video, geometry)).equals(
      null
    )
  })

  it('places the cells at the picture’s bottom-left', function () {
    expect(markerGeometry(720)).deep.equals({
      bits: 32,
      originX: 40,
      originY: 648,
      stride: 36,
      cell: 32,
      sentinelSlot: 32
    })
  })

  it('hands the page its reader as source, and unwraps the low bits', function () {
    expect(readMarkerSource()).contains('getImageData')
    const wall = Date.UTC(2026, 10, 27, 12)
    const low = wall % 2 ** 32
    expect(unwrapMarker(low, wall + 5000)).equals(wall)
    expect(unwrapMarker(low, wall - 5000)).equals(wall)
  })
})
