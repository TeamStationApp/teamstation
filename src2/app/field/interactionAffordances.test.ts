import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { Mesh, MeshBasicMaterial } from 'three'

import { BallArc } from './BallArc'
import {
  arrowPulse,
  inArcGrabArea,
  offsetTouchTarget,
  usesTouchPlacement
} from './interactionAffordances'

describe('touch placement and animated arc affordances', function () {
  it('moves a solid yellow crest outward through three stops', function () {
    for (const stop of [0, 1, 2]) {
      expect(arrowPulse(stop, stop * 0.6)).closeTo(1, 0.000001)
      for (const other of [0, 1, 2].filter(i => i !== stop)) {
        expect(arrowPulse(other, stop * 0.6)).lessThan(0.5)
      }
    }
    expect(arrowPulse(1, 0)).greaterThan(arrowPulse(2, 0))
    expect(arrowPulse(0, 1.2)).lessThan(arrowPulse(1, 1.2))
    expect(arrowPulse(1, 1.2)).lessThan(arrowPulse(2, 1.2))
    expect(inArcGrabArea(96, 80)).equals(true)
    expect(inArcGrabArea(-96, -80)).equals(true)
    expect(inArcGrabArea(97, 0)).equals(false)
  })
  it('offsets touch destinations ten feet radially without changing precise inputs', function () {
    for (const point of [
      { x: 0, z: 0 },
      { x: 10, z: -30 },
      { x: -80, z: -120 }
    ]) {
      const offset = offsetTouchTarget(point, true)
      expect(Math.hypot(offset.x - point.x, offset.z - point.z)).closeTo(
        3.048,
        0.000001
      )
      expect(offsetTouchTarget(point, false)).deep.equals(point)
      expect(offset.z).lessThan(point.z)
    }
    expect(usesTouchPlacement('touch', false)).equals(true)
    expect(usesTouchPlacement(undefined, true)).equals(true)
    expect(usesTouchPlacement('mouse', true)).equals(false)
    expect(usesTouchPlacement('pen', true)).equals(false)
  })
  it('renders six animated arrows in the overlay pass above transparent nameplates', async function () {
    const arc = { target: { x: 0, z: -60 }, angle: 30 }
    const renderer = await create(
      React.createElement(BallArc, { arc, editing: true })
    )
    try {
      const arrows = renderer.scene.findAllByProps({ name: 'arc-pulse-arrow' })
      expect(arrows.length).equals(6)
      expect(
        renderer.scene.findByProps({ name: 'arc-angle-handle' }).instance
          .renderOrder
      ).greaterThan(5)
      for (const arrow of arrows) {
        const mesh = arrow.instance
        if (
          !(mesh instanceof Mesh) ||
          !(mesh.material instanceof MeshBasicMaterial)
        )
          throw new Error('Wrong arrow material')
        expect(mesh.renderOrder).greaterThan(5)
        expect(mesh.material.transparent).equals(true)
        expect(mesh.material.opacity).equals(1)
        expect(mesh.material.depthTest).equals(false)
        expect(mesh.material.depthWrite).equals(false)
      }
      const mesh = arrows[0].instance as Mesh<never, MeshBasicMaterial>
      await renderer.advanceFrames(1, 1 / 60)
      const before = mesh.material.color.clone()
      const position = mesh.position.clone()
      await renderer.advanceFrames(36, 1 / 60)
      expect(mesh.material.color.equals(before)).equals(false)
      expect(mesh.position.equals(position)).equals(true)
      await renderer.update(
        React.createElement(BallArc, { arc, editing: false })
      )
      expect(
        renderer.scene.findAllByProps({ name: 'arc-angle-handle' }).length
      ).equals(0)
    } finally {
      await renderer.unmount()
    }
  })
})
