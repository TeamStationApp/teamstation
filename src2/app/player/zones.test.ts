import { expect } from 'chai'
import { describe, it } from 'mocha'

import { controlRects, liveRects, subtract } from './controlGeometry'
import { zoneFor } from './zones'

const W = 900
const H = 506

describe('player zones', function () {
  it('gives each of the nine squares its own action', function () {
    const at = (col: number, row: number): string =>
      zoneFor(((col + 0.5) * W) / 3, ((row + 0.5) * H) / 3, W, H)
    expect([at(0, 0), at(1, 0), at(2, 0)]).deep.equals([
      'toggle',
      'slowForward',
      'toggle'
    ])
    expect([at(0, 1), at(1, 1), at(2, 1)]).deep.equals([
      'seekBack',
      'toggle',
      'seekForward'
    ])
    expect([at(0, 2), at(1, 2), at(2, 2)]).deep.equals([
      'toggle',
      'slowBack',
      'toggle'
    ])
  })

  it('splits into even thirds whatever shape the picture is', function () {
    // Two cameras side by side are 32:9, and a grid that assumed 16:9 would
    // put the middle column somewhere else entirely.
    expect(zoneFor(1, 1, 1600, 450)).equals('toggle')
    expect(zoneFor(800, 225, 1600, 450)).equals('toggle')
    expect(zoneFor(100, 225, 1600, 450)).equals('seekBack')
    expect(zoneFor(1500, 225, 1600, 450)).equals('seekForward')
  })

  it('keeps the boundaries where the thirds are', function () {
    expect(zoneFor(W / 3 - 1, H / 2, W, H)).equals('seekBack')
    expect(zoneFor(W / 3 + 1, H / 2, W, H)).equals('toggle')
  })
})

describe('control geometry', function () {
  it('cuts Chrome s bar out and leaves the spacer live', function () {
    const live = liveRects(W, H, 'chrome')
    const above = live.find(rect => rect.y === 0)
    expect(above?.h, 'everything above the bar').equals(H - 72)
    const spacer = live.find(rect => rect.y === H - 72)
    expect(spacer?.x).equals(114)
    expect(spacer?.w).equals(W - 258)
    expect(spacer?.h).equals(48)
  })

  it('leaves the bottom middle square something to press on a phone', function () {
    // 390 wide: the spacer between Chrome's button groups is 132px, and the
    // middle column is 130 to 260, so most of the square survives.
    const spacer = liveRects(390, 219, 'chrome').find(rect => rect.y === 147)
    expect(spacer?.w).is.at.least(100)
  })

  it('cuts WebKit s corners and centre cluster out', function () {
    const rects = controlRects(390, 219, 'webkit')
    expect(rects).deep.include({ x: 0, y: 0, w: 44, h: 44 })
    expect(rects).deep.include({ x: 346, y: 0, w: 44, h: 44 })
    expect(rects).deep.include({ x: 0, y: 179, w: 390, h: 40 })
    const live = liveRects(390, 219, 'webkit')
    const overlaps = live.some(
      piece => piece.x < 44 && piece.y < 44 && piece.x + piece.w > 0
    )
    expect(overlaps, 'nothing live over the fullscreen button').equals(false)
  })

  it('gives an unmeasured engine no holes at all', function () {
    const live = liveRects(W, H, 'unknown')
    expect(live).deep.equals([{ x: 0, y: 0, w: W, h: H - 72 }])
  })

  it('subtracts a rectangle into at most four pieces', function () {
    const pieces = subtract(
      { x: 0, y: 0, w: 100, h: 100 },
      { x: 40, y: 40, w: 20, h: 20 }
    )
    expect(pieces.length).equals(4)
    const area = pieces.reduce((sum, piece) => sum + piece.w * piece.h, 0)
    expect(area).equals(100 * 100 - 20 * 20)
  })
})
