import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PerspectiveCamera } from 'three'

import { projectBases } from '../field/baseProjection'
import { applyFieldCamera } from '../field/cameraModel'
import type { BaseProjection } from '../field/fieldTypes'
import { choiceDecisionFrame, homeDecisionFrame } from './runnerControlLayout'

const projection: BaseProjection = {
  width: 1200,
  height: 900,
  bases: [
    { x: 600, y: 700 },
    { x: 900, y: 500 },
    { x: 600, y: 300 },
    { x: 300, y: 500 }
  ],
  heads: [
    { x: 600, y: 650 },
    { x: 900, y: 450 },
    { x: 600, y: 250 },
    { x: 300, y: 450 }
  ],
  feet: [
    { x: 600, y: 750 },
    { x: 900, y: 550 },
    { x: 600, y: 350 },
    { x: 300, y: 550 }
  ]
}
describe('runner-relative decision placement', function () {
  it('puts second above the head, third left, first right', function () {
    const second = choiceDecisionFrame(projection, 2)
    expect(second.left + second.width / 2).equals(600)
    expect(second.top + 44).lessThan(250)
    const third = choiceDecisionFrame(projection, 3)
    expect(third.left + third.width).lessThan(300)
    expect(third.top + 48).equals(500)
    const first = choiceDecisionFrame(projection, 1)
    expect(first.left).greaterThan(900)
    expect(first.top + 48).equals(500)
  })
  it('reuses the home-on-a-hit frame, including Back and anchor-only calls', function () {
    expect(choiceDecisionFrame(projection, 4)).deep.equals(
      homeDecisionFrame(projection, null, false)
    )
    expect(homeDecisionFrame(projection, null, true)!.top).lessThan(
      homeDecisionFrame(projection, null, false)!.top
    )
    expect(homeDecisionFrame(undefined, null, false)).equals(undefined)
    expect(
      homeDecisionFrame(undefined, { x: 200, y: 400 }, false)
    ).deep.includes({ left: 232, top: 352, width: 68 })
    expect(homeDecisionFrame(undefined, { x: 200, y: 400 }, true)!.top).equals(
      326
    )
  })
  it('keeps repeated home decisions separate near home', function () {
    const first = choiceDecisionFrame(projection, 4, 0, 2)
    const second = choiceDecisionFrame(projection, 4, 1, 2)
    expect(Math.abs(second.top - first.top)).equals(52)
  })
  for (const [width, height] of [
    [874, 292],
    [568, 320],
    [402, 579]
  ])
    it(`separates complete rectangles and three home arrivals at ${width}x${height}`, function () {
      const camera = new PerspectiveCamera()
      applyFieldCamera(camera, {
        width,
        height,
        view: 'home',
        zoom: 1,
        tilt: 0,
        heightOffset: 33,
        bottomExtension: 112
      })
      const view = projectBases(camera, width, height)
      const distinct = [2, 3, 4].map(to => ({
        ...choiceDecisionFrame(view, to),
        height: to === 2 ? 44 : 96
      }))
      const homes = [0, 1, 2].map(slot => ({
        ...choiceDecisionFrame(view, 4, slot, 3),
        height: 44
      }))
      for (const frames of [distinct, homes])
        for (const [index, frame] of frames.entries()) {
          expect(frame.left).at.least(8)
          expect(frame.left + frame.width).at.most(width - 8)
          expect(frame.top).at.least(8)
          expect(frame.top + frame.height).at.most(height - 128)
          for (const other of frames.slice(index + 1))
            expect(
              frame.left + frame.width <= other.left ||
                other.left + other.width <= frame.left ||
                frame.top + frame.height <= other.top ||
                other.top + other.height <= frame.top
            ).equals(true)
        }
    })
  it('keeps the home and above-second hit targets apart in short landscape fields', function () {
    const view: BaseProjection = {
      ...projection,
      width: 874,
      height: 292,
      bases: [{ x: 437, y: 120 }, ...projection.bases.slice(1)],
      heads: [
        { x: 437, y: 105 },
        { x: 510, y: 90 },
        { x: 437, y: 110 },
        { x: 365, y: 90 }
      ]
    }
    const home = choiceDecisionFrame(view, 4)
    const second = choiceDecisionFrame(view, 2)
    expect(home.left).at.least(second.left + second.width + 8)
    expect(home).deep.equals(homeDecisionFrame(view, null, false))
  })
  it('bounds pairs to narrow viewports and accepts older projection callers', function () {
    for (const width of [320, 402, 844])
      for (const height of [292, 579]) {
        const view: BaseProjection = {
          width,
          height,
          bases: [
            { x: 1, y: 9999 },
            { x: 9999, y: -1 },
            { x: 2, y: 0 },
            { x: -1, y: 9999 }
          ]
        }
        for (const to of [1, 2, 3, 4]) {
          const frame = choiceDecisionFrame(view, to, 2)
          expect(frame.left).at.least(8)
          expect(frame.left + frame.width).at.most(width - 8)
          expect(frame.top).at.least(8)
          expect(frame.top + (to === 2 ? 44 : 96)).at.most(height - 8)
        }
      }
  })
})
