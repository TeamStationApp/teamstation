import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { Rect } from './multiCam/layout'
import { videoBlock } from './multiCam/playerLayout'
import {
  cellCentre,
  type GridZone,
  gridZoneFor,
  placeIcons,
  scrubFraction,
  zoneAt,
  zoneGroup
} from './pressGrid'

const BOX: Rect = { x: 100, y: 50, w: 800, h: 400 }

/** The zone at the middle of each square, row by row. */
function grid(box: Rect): GridZone[][] {
  return [0, 1, 2, 3].map(row =>
    [0, 1, 2, 3].map(column => {
      const { x, y } = cellCentre(box, column, row)
      return gridZoneFor(x, y, box)
    })
  )
}

describe('the press grid', function () {
  it('gives each of the sixteen squares its action', function () {
    expect(grid(BOX)).deep.equals([
      ['audio', 'reveal', 'reveal', 'corner'],
      ['seekBack', 'toggle', 'toggle', 'seekForward'],
      ['seekBack', 'toggle', 'toggle', 'seekForward'],
      ['scrub', 'scrub', 'scrub', 'scrub']
    ])
  })

  it('puts the boundaries at the quarters', function () {
    // A quarter across and down is the second square, just short of it the
    // first.
    expect(gridZoneFor(299, 151, BOX)).equals('seekBack')
    expect(gridZoneFor(300, 151, BOX)).equals('toggle')
    expect(gridZoneFor(150, 149, BOX)).equals('audio')
    expect(gridZoneFor(600, 349, BOX)).equals('toggle')
    expect(gridZoneFor(600, 350, BOX)).equals('scrub')
    expect(gridZoneFor(699, 200, BOX)).equals('toggle')
    expect(gridZoneFor(700, 200, BOX)).equals('seekForward')
  })

  it('gives a point outside the box its nearest square', function () {
    expect(gridZoneFor(50, 0, BOX)).equals('audio')
    expect(gridZoneFor(500, 0, BOX)).equals('reveal')
    expect(gridZoneFor(2000, 0, BOX)).equals('corner')
    expect(gridZoneFor(500, 2000, BOX)).equals('scrub')
    expect(gridZoneFor(0, 200, BOX)).equals('seekBack')
    expect(gridZoneFor(2000, 200, BOX)).equals('seekForward')
    expect(gridZoneFor(10, 10, { x: 0, y: 0, w: 0, h: 0 })).equals('audio')
  })

  it('splits the scrub line from the controls above it', function () {
    expect(zoneGroup('scrub')).equals('scrub')
    const above: GridZone[] = [
      'audio',
      'reveal',
      'corner',
      'seekBack',
      'toggle',
      'seekForward'
    ]
    expect(above.map(zoneGroup)).deep.equals(above.map(() => 'controls'))
  })

  it('lands a scrub where the finger is on the drawn line, and at its ends beyond it', function () {
    const track: Rect = { x: 200, y: 0, w: 600, h: 24 }
    expect(scrubFraction(200, track)).equals(0)
    expect(scrubFraction(500, track)).equals(0.5)
    expect(scrubFraction(800, track)).equals(1)
    expect(scrubFraction(100, track)).equals(0)
    expect(scrubFraction(900, track)).equals(1)
    expect(scrubFraction(500, { ...track, w: 0 })).equals(0)
  })

  it('measures the squares on the block of videos, so below a short stack is the scrub', function () {
    const stack = videoBlock([
      { x: 0, y: 100, w: 400, h: 225 },
      { x: 0, y: 325, w: 400, h: 225 }
    ])!
    expect(gridZoneFor(390, 300, stack)).equals('seekForward')
    expect(gridZoneFor(200, 600, stack)).equals('scrub')
  })
})

describe("the controls group's icons", function () {
  const BOX: Rect = { x: 0, y: 0, w: 800, h: 400 }

  it('put the sound and the corner in the top corners, the rest in the middle of their squares', function () {
    const icons = placeIcons(BOX, 48, [], 4, true, { x: 40, y: 40 })
    const at = (zone: string): { x: number; y: number } =>
      icons.find(icon => icon.zone === zone)!
    expect(at('audio')).deep.include({ x: 40, y: 40 })
    expect(at('corner')).deep.include({ x: 760, y: 40 })
    expect(at('seekBack')).deep.include({ x: 100, y: 200 })
    expect(at('toggle')).deep.include({ x: 400, y: 200 })
    expect(at('seekForward')).deep.include({ x: 700, y: 200 })
    expect(
      placeIcons(BOX, 48, [], 4, false, { x: 40, y: 40 }).map(icon => icon.zone)
    ).not.includes('corner')
  })

  it('keep the sound in its corner over the board, and the rest clear of the board, its box and each other', function () {
    const board = { x: 0, y: 0, w: 300, h: 90 }
    const box = { x: 0, y: 95, w: 300, h: 140 }
    const icons = placeIcons(BOX, 48, [board, null, box], 4, false, {
      x: 40,
      y: 40
    })
    const sound = icons.find(icon => icon.zone === 'audio')!
    const back = icons.find(icon => icon.zone === 'seekBack')!
    // In its corner, over the board: the controls show only for a moment.
    expect(sound).deep.include({ x: 40, y: 40 })
    expect(back.y - back.r).equals(box.y + box.h + 4)
    // Not under a cover: where it was.
    expect(icons.find(icon => icon.zone === 'toggle')!.y).equals(200)
  })

  it('answers a press on a moved icon with the icon, and anywhere else with the square', function () {
    // A cover down the right side moves ten seconds on into the scrub row.
    const cover = { x: 600, y: 150, w: 200, h: 170 }
    const icons = placeIcons(BOX, 48, [cover], 4, false, { x: 40, y: 40 })
    const on = icons.find(icon => icon.zone === 'seekForward')!
    expect(gridZoneFor(on.x, on.y, BOX)).equals('scrub')
    expect(zoneAt(on.x, on.y, BOX, icons)).equals('seekForward')
    // Hidden, the square is the square's.
    expect(zoneAt(on.x, on.y, BOX, null)).equals('scrub')
    // Off every icon, the square.
    expect(zoneAt(400, 380, BOX, icons)).equals('scrub')
    expect(zoneAt(5, 5, BOX, icons)).equals('audio')
  })

  it('takes the way out only from its own icon once that has been moved', function () {
    const exit = { zone: 'corner' as const, x: 860, y: 180, r: 20 }
    const icons = [...placeIcons(BOX, 48, [], 4, false, { x: 40, y: 40 }), exit]
    // On the ✕, wherever it is: the way out.
    expect(zoneAt(860, 180, BOX, icons)).equals('corner')
    // Its square, with the ✕ drawn below it: only the controls.
    expect(zoneAt(880, 60, BOX, icons)).equals('reveal')
    // Hidden, the square is the way out's, as ever.
    expect(zoneAt(880, 60, BOX, null)).equals('corner')
  })
})
