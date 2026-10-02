import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import type { Mesh } from 'three'

import { BallArc } from './BallArc'
import { arcPoint } from './ballArcModel'
import {
  guideBearing,
  GuideBearingEase,
  initialHitTarget
} from './trajectoryGuide'

describe('visible trajectory guide', function () {
  it('defaults by the current handedness and keeps a five-degree resting gap', () => {
    expect(guideBearing(initialHitTarget('R'))).closeTo(-15, 1e-8)
    expect(guideBearing(initialHitTarget('L'))).closeTo(15, 1e-8)
    expect(initialHitTarget('S')).deep.equals(initialHitTarget('R'))
    expect(Math.hypot(...Object.values(initialHitTarget('R')))).closeTo(
      113.5,
      1e-8
    )
    for (const angle of [-15, -5, -1, 0, 1, 5, 15]) {
      const target = { x: 60 * Math.tan((angle * Math.PI) / 180), z: -60 }
      expect(guideBearing(target)).closeTo(
        angle === 0 ? -5 : Math.sign(angle) * Math.max(5, Math.abs(angle)),
        1e-8
      )
    }
    expect(guideBearing({ x: 0, z: -60 }, 15)).equals(5)
    expect(guideBearing({ x: 0, z: -60 }, 0)).equals(-5)
    expect(guideBearing({ x: 0, z: 60 })).equals(-5)
    const foul = { target: { x: 0, z: 60 }, angle: 45, guideBearing: -5 }
    expect(arcPoint(foul, 0.5).x).lessThan(0)
    expect(arcPoint(foul, 1).x).equals(0)
  })
  it('eases both directions in 180ms and retargets from the displayed bearing', () => {
    for (const sign of [-1, 1]) {
      const ease = new GuideBearingEase(sign * 5)
      ease.target(-sign * 5)
      expect(ease.step(0.045) * sign).within(0, 5)
      const current = ease.value
      ease.target(sign * 15)
      expect(ease.step(0)).equals(current)
      expect(ease.step(-2)).equals(current)
      expect(ease.step(0.09) * sign).within(current * sign, 15)
      expect(ease.step(0.09)).equals(sign * 15)
      expect(ease.settling).equals(false)
      ease.target(sign * 15)
      expect(ease.settling).equals(false)
    }
  })
  it('bows only the yellow guide while preserving contact, elevation, target and actual flight', () => {
    for (const angle of [-45, -5, 10, 45, 70, 85])
      for (const bearing of [-5, 5]) {
        const arc = { target: { x: 0, z: -90 }, angle, landingHeight: 8 }
        const guide = { ...arc, guideBearing: bearing }
        expect(arcPoint(guide, 0)).deep.equals(arcPoint(arc, 0))
        expect(arcPoint(guide, 1)).deep.equals(arcPoint(arc, 1))
        expect(arcPoint(guide, 0.5).y).equals(arcPoint(arc, 0.5).y)
        expect(arcPoint(guide, 0.5).x * bearing).greaterThan(0)
        expect(arcPoint(arc, 0.5).x).equals(0)
      }
  })
  it('animates displayed geometry and handle while leaving the target marker fixed', async () => {
    const arc = { target: { x: -0.1, z: -60 }, angle: 45 }
    const renderer = await create(
      React.createElement(BallArc, { arc, editing: true })
    )
    const bearing = (): number =>
      renderer.scene.findByProps({ name: 'ball-arc' }).instance.userData.bearing
    expect(bearing()).equals(-5)
    const original = renderer.scene.findByProps({ name: 'ball-trajectory' })
      .instance as Mesh
    const geometry = original.geometry
    let disposed = false
    geometry.addEventListener('dispose', () => {
      disposed = true
    })
    await renderer.update(
      React.createElement(BallArc, {
        arc: { ...arc, target: { x: 0.1, z: -60 } },
        editing: true
      })
    )
    expect(bearing()).equals(-5)
    await act(async () => {
      await renderer.advanceFrames(1, 4)
      await renderer.advanceFrames(1, 0.045)
    })
    expect(bearing()).within(-5, 0)
    await act(async () => {
      await renderer.advanceFrames(3, 0.045)
    })
    expect(bearing()).equals(5)
    expect(disposed).equals(true)
    await renderer.update(
      React.createElement(BallArc, {
        arc: { ...arc, target: { x: -0.1, z: -60 } },
        editing: false
      })
    )
    await act(async () => {
      await renderer.advanceFrames(1, 4)
      await renderer.advanceFrames(4, 0.05)
    })
    expect(bearing()).equals(-5)
    await renderer.unmount()
  })
})
