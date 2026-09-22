import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { Mesh, PerspectiveCamera, Raycaster, Vector3 } from 'three'

import { applyFieldCamera } from './cameraModel'
import { createPlayers } from './fieldModel'
import { FieldScene } from './FieldScene'
import { TERRAIN } from './terrain'

describe('stadium depth and camera regression', function () {
  it('keeps field layers distinctly ordered while changing orientation, tilt, height and zoom', async function () {
    const renderer = await create(
      React.createElement(FieldScene, {
        players: createPlayers(),
        selected: 'SS',
        onSelect: () => undefined,
        view: 'home',
        zoom: 1
      })
    )
    try {
      const surfaces: Mesh[] = []
      renderer.scene.instance.updateMatrixWorld(true)
      renderer.scene.instance.traverse(object => {
        if (
          object instanceof Mesh &&
          ['ShapeGeometry', 'CircleGeometry'].includes(object.geometry.type)
        )
          surfaces.push(object)
      })
      const camera = new PerspectiveCamera()
      const ray = new Raycaster()
      let comparisons = 0
      for (const view of ['home', 'overhead', 'infield'] as const)
        for (const tilt of [-0.35, 0, 0.35])
          for (const heightOffset of [-40, 0, 40])
            for (const zoom of [0.7, 1, 1.8]) {
              applyFieldCamera(camera, {
                width: 390,
                height: 556,
                view,
                zoom,
                tilt,
                heightOffset
              })
              expect(camera.position.y).at.least(3)
              for (const [x, z, height] of [
                [-10, -22, TERRAIN.diamond],
                [25, -28, TERRAIN.dirt],
                [0, -112, TERRAIN.track]
              ]) {
                const target = new Vector3(x, height, z)
                ray.set(
                  camera.position,
                  target.clone().sub(camera.position).normalize()
                )
                const hits = ray.intersectObjects(surfaces, false)
                expect(hits.length).greaterThan(1)
                expect(hits[0].point.y).closeTo(height, 0.00001)
                const behind = hits.find(
                  hit => Math.abs(hit.point.y - height) > 0.01
                )
                if (behind == null) throw new Error('No underlying field layer')
                const frontDepth = hits[0].point.clone().project(camera).z
                const backDepth = behind.point.clone().project(camera).z
                if (frontDepth > -1 && backDepth < 1) {
                  // At least four 24-bit depth steps before polygon offset,
                  // even at the most distant camera and narrowest view.
                  expect(
                    (backDepth - frontDepth) * 0.5 * (2 ** 24 - 1)
                  ).greaterThan(4)
                  comparisons++
                }
              }
            }
      expect(comparisons).greaterThan(100)
    } finally {
      await renderer.unmount()
    }
  })
  it('keeps each lamp face ahead of its housing, with consistent local rotation', async function () {
    const renderer = await create(
      React.createElement(FieldScene, {
        players: createPlayers(),
        selected: 'SS',
        onSelect: () => undefined,
        view: 'home',
        zoom: 1
      })
    )
    try {
      const lamps = renderer.scene.findAllByProps({ name: 'lamp-face' })
      expect(lamps.length).equals(28)
      for (const lamp of lamps) {
        expect(lamp.instance.position.z - 0.08).greaterThan(0.8)
        expect(lamp.instance.rotation.y).equals(0)
        expect(Math.abs(lamp.instance.position.x) + 0.675).lessThan(7.5)
      }
      const numbers = renderer.scene.findAllByProps({ name: 'jersey-number' })
      expect(numbers.length).equals(24)
      for (const player of createPlayers())
        expect(
          renderer.scene.findByProps({ name: `player-label-${player.id}` })
        ).not.equals(undefined)
    } finally {
      await renderer.unmount()
    }
  })
})
