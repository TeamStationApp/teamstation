import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import {
  DoubleSide,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Raycaster,
  ShapeGeometry,
  Vector3
} from 'three'

import { BallArc } from './BallArc'
import { arcPoint } from './ballArcModel'
import { applyFieldCamera } from './cameraModel'
import { BACK_GRASS_METRES, FOUL_GRASS_METRES, grassApron } from './grassApron'
import { TERRAIN } from './terrain'
import { trajectoryGrip } from './trajectoryGrip'
import { guideBearing } from './trajectoryGuide'

describe('trajectory polish', () => {
  it('keeps the grip at the projected midpoint, outside either arc, at a fixed pixel scale', () => {
    for (const [width, height] of [
      [390, 844],
      [844, 390],
      [320, 700]
    ]) {
      const camera = new PerspectiveCamera()
      applyFieldCamera(camera, {
        width,
        height,
        view: 'home',
        zoom: 1,
        bottomExtension: 112
      })
      const cameraBefore = camera.matrixWorld.clone()
      for (const x of [-50, 0, 50])
        for (const angle of [-45, 0, 25, 70, 85]) {
          const arc = {
            target: { x, z: -85 },
            angle,
            guideBearing: guideBearing({ x, z: -85 })
          }
          const grip = trajectoryGrip(arc, camera, { width, height })
          const screen = grip.position.clone().project(camera)
          const home = new Vector3(0, TERRAIN.players, 0).project(camera)
          const target = new Vector3(x, TERRAIN.players, -85).project(camera)
          expect(screen.y).closeTo((home.y + target.y) / 2, 1e-8)
          // Independently sample the curve densely around that screen row.
          const points = Array.from({ length: 6001 }, (_, i) => {
            const p = arcPoint(arc, i / 6000)
            return new Vector3(p.x, p.y, p.z).project(camera)
          }).sort((a, b) => Math.abs(a.y - screen.y) - Math.abs(b.y - screen.y))
          const dx = ((screen.x - points[0].x) * width) / 2
          expect(dx * (x > 0 ? -1 : 1)).closeTo(15, 0.15)
          const up = new Vector3(0, grip.scale, 0)
            .applyQuaternion(camera.quaternion)
            .add(grip.position)
            .project(camera)
          expect(((up.y - screen.y) * height) / 2).closeTo(1, 1e-7)
          expect(camera.matrixWorld.equals(cameraBefore)).equals(true)
        }
      for (const target of [
        { x: 0, z: -3 },
        { x: -30, z: -135 }
      ]) {
        const grip = trajectoryGrip(
          { target, angle: 70, landingHeight: 18 },
          camera,
          { width, height }
        )
        expect(grip.position.toArray().every(Number.isFinite)).equals(true)
        expect(grip.scale).greaterThan(0)
      }
    }
  })
  it('shows smaller white landing rings only while editing and a three-ring grab point', async () => {
    const arc = { target: { x: 25, z: -60 }, angle: 40 }
    const renderer = await create(
      React.createElement(BallArc, { arc, editing: false })
    )
    try {
      const ring = (): Mesh =>
        renderer.scene.findAllByProps({ name: 'destination-ring' })[0]
          .instance as Mesh
      expect(
        (ring().material as MeshBasicMaterial).color.getHexString()
      ).equals('ffe000')
      expect(
        (ring().geometry as unknown as { parameters: { outerRadius: number } })
          .parameters.outerRadius
      ).equals(11)
      await renderer.update(
        React.createElement(BallArc, { arc, editing: true })
      )
      await renderer.advanceFrames(2, 1 / 60)
      expect(
        (ring().material as MeshBasicMaterial).color.getHexString()
      ).equals('ffffff')
      expect(
        (ring().geometry as unknown as { parameters: { outerRadius: number } })
          .parameters.outerRadius
      ).equals(5.5)
      expect(
        renderer.scene.findAllByProps({ name: 'arc-grab-ring' })
      ).has.length(3)
      expect(
        renderer.scene.findAllByProps({ name: 'arc-pulse-arrow' })
      ).has.length(6)
    } finally {
      await renderer.unmount()
    }
  })
  it('covers thirty feet beyond both baselines and fifty feet behind home in one surface', () => {
    const geometry = new ShapeGeometry(grassApron())
    const material = new MeshBasicMaterial({ side: DoubleSide })
    const mesh = new Mesh(geometry, material)
    const ray = new Raycaster()
    const contains = (x: number, z: number): boolean => {
      ray.set(new Vector3(x, -z, 20), new Vector3(0, 0, -1))
      return ray.intersectObject(mesh).length > 0
    }
    try {
      expect(FOUL_GRASS_METRES).equals(9.144)
      expect(BACK_GRASS_METRES).equals(15.24)
      for (const side of [-1, 1])
        for (const distance of [0, 13, 27.432, 60]) {
          const x = (side * (distance + FOUL_GRASS_METRES - 0.001)) / Math.SQRT2
          const z = (-distance + FOUL_GRASS_METRES - 0.001) / Math.SQRT2
          expect(contains(x, z), `${side} baseline ${distance}`).equals(true)
        }
      for (const x of [-10, 0, 10])
        expect(contains(x, BACK_GRASS_METRES - 0.001)).equals(true)
      expect(contains(0, BACK_GRASS_METRES + 0.01)).equals(false)
      expect(contains(0, -80)).equals(true)
    } finally {
      geometry.dispose()
      material.dispose()
    }
  })
})
