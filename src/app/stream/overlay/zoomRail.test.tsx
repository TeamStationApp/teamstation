import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { PhoneZoomScale } from '../phoneStreamClient'
import {
  clampZoom,
  isDigitalSegment,
  isDigitalZoom,
  scaleHighlight,
  scaleProgress,
  segmentCount,
  sliderLabel,
  zoomAtProgress,
  zoomDraggedFrom,
  zoomLabel
} from './zoomRail'

/** An iPhone 13 Pro's back camera: 0.5x, 1x and 3x lenses, 9x digital, 18x the engine's. */
const PRO: PhoneZoomScale = {
  presets: [0.5, 1, 3, 9, 18],
  switchOvers: [1, 3],
  digitalFrom: 9,
  minimum: 0.5,
  maximum: 18,
  current: 1
}

/** A camera with one fixed zoom. */
const SINGLE: PhoneZoomScale = {
  presets: [1],
  switchOvers: [],
  digitalFrom: null,
  minimum: 1,
  maximum: 1,
  current: 1
}

describe('the zoom rail', function () {
  it('writes zooms the way the Camera app does', function () {
    expect(zoomLabel(0.5)).equals('0.5x')
    expect(zoomLabel(1)).equals('1x')
    expect(zoomLabel(1.04)).equals('1x')
    expect(zoomLabel(2.5)).equals('2.5x')
    expect(zoomLabel(10)).equals('10x')
    expect(sliderLabel(0.5)).equals('0.5x')
    expect(sliderLabel(2.6)).equals('3x')
    expect(sliderLabel(17.6)).equals('18x')
  })

  it('draws zoom past the longest lens in yellow, pills and segments alike', function () {
    expect(isDigitalZoom(PRO, 3)).equals(false)
    expect(isDigitalZoom(PRO, 3.02)).equals(false)
    expect(isDigitalZoom(PRO, 9)).equals(true)
    expect(isDigitalZoom(PRO, 18)).equals(true)
    expect(isDigitalZoom(SINGLE, 1)).equals(false)
    expect(isDigitalSegment(PRO, 1)).equals(false)
    expect(isDigitalSegment(PRO, 2)).equals(true)
    expect(isDigitalSegment(PRO, 3)).equals(true)
    expect(isDigitalSegment(PRO, 4)).equals(false)
    expect(isDigitalSegment(PRO, -1)).equals(false)
  })

  it('lights the pill a zoom rounds to, or the tick of its segment', function () {
    expect(segmentCount(PRO)).equals(4)
    expect(segmentCount(SINGLE)).equals(0)
    expect(scaleHighlight(PRO, 1.02)).deep.equals({ kind: 'preset', value: 1 })
    expect(scaleHighlight(PRO, 0.7)).deep.equals({
      kind: 'tick',
      segment: 0,
      index: 2
    })
    expect(scaleHighlight(PRO, 2)).deep.equals({
      kind: 'tick',
      segment: 1,
      index: 2
    })
    expect(scaleHighlight(PRO, 40)).deep.equals({ kind: 'preset', value: 18 })
    expect(scaleHighlight(SINGLE, 1)).deep.equals({ kind: 'preset', value: 1 })
    expect(scaleHighlight({ ...SINGLE, presets: [] }, 1)).deep.equals({
      kind: 'preset',
      value: 1
    })
    // Past the last pill's label but short of the maximum: the last tick.
    expect(
      scaleHighlight({ ...PRO, presets: [0.5, 1, 3], maximum: 18 }, 6)
    ).deep.equals({ kind: 'tick', segment: 1, index: 4 })
    // A single pill whose label the zoom does not round to.
    expect(scaleHighlight({ ...SINGLE, maximum: 2 }, 2)).deep.equals({
      kind: 'preset',
      value: 1
    })
    // Presets out of order leave no segment to sit in.
    expect(
      scaleHighlight({ ...PRO, presets: [3, 1], minimum: 0.5 }, 0.7)
    ).deep.equals({ kind: 'preset', value: 1 })
  })

  it('places a zoom along the rail, equal segments on the screen', function () {
    expect(scaleProgress(PRO, 0.5)).equals(0)
    expect(scaleProgress(PRO, 18)).equals(1)
    expect(scaleProgress(PRO, 2)).equals(1.5 / 4)
    expect(scaleProgress(SINGLE, 1)).equals(0)
    expect(scaleProgress({ ...PRO, presets: [0.5, 1, 1, 18] }, 1)).equals(1 / 3)
    expect(zoomAtProgress(PRO, 0)).equals(0.5)
    expect(zoomAtProgress(PRO, 1)).equals(18)
    expect(zoomAtProgress(PRO, 0.375)).equals(2)
    expect(zoomAtProgress(SINGLE, 0.5)).equals(1)
    expect(zoomAtProgress({ ...SINGLE, presets: [] }, 0.5)).equals(1)
    expect(clampZoom(PRO, 100)).equals(18)
    expect(clampZoom(PRO, Number.NaN)).equals(0.5)
  })

  it('walks one segment for each pill-to-pill gap dragged', function () {
    expect(zoomDraggedFrom(PRO, 1, 72, 72)).equals(3)
    expect(zoomDraggedFrom(PRO, 1, -72, 72)).equals(0.5)
    expect(zoomDraggedFrom(PRO, 1, 36, 72)).equals(2)
    expect(zoomDraggedFrom(PRO, 1, 10_000, 72)).equals(18)
    expect(zoomDraggedFrom(PRO, 1, Number.NaN, 72)).equals(1)
    expect(zoomDraggedFrom(PRO, 30, 10, 0)).equals(18)
  })
})
