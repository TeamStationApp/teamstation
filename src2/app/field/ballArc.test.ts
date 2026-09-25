import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { type Camera, Ray, Vector2, Vector3 } from 'three'

import {
  arcHandle,
  arcPoint,
  arcTarget,
  BALL_CONTACT,
  type BallArcState,
  dragLaunchAngle,
  firstBounceFraction
} from './ballArcModel'
import { createPlayers } from './fieldModel'
import { FieldScene } from './FieldScene'
import { TERRAIN } from './terrain'

describe('ball flight authoring', function () {
  it('starts at home, lands on target, and uses a 30 degree launch slope', function () {
    const arc = { target: { x: 30, z: -60 }, angle: 30 }
    expect(arcPoint(arc, 0)).deep.equals({
      x: 0,
      y: BALL_CONTACT,
      z: 0
    })
    const end = arcPoint(arc, 1)
    expect(end.x).equals(30)
    expect(end.z).equals(-60)
    expect(end.y).closeTo(TERRAIN.players + 0.16, 0.000001)
    const first = arcPoint(arc, 0.0001)
    expect((first.y - BALL_CONTACT) / Math.hypot(first.x, first.z)).closeTo(
      Math.tan(Math.PI / 6),
      0.001
    )
    expect(dragLaunchAngle(30, 100)).equals(70)
    expect(dragLaunchAngle(30, -300)).equals(-45)
    expect(
      Math.hypot(...Object.values(arcTarget({ x: 200, z: -200 })))
    ).at.most(160.00001)
  })
  it('moves ground contact toward home with a direct hit and a rising chopping arc', function () {
    let previous = 1
    for (const angle of [-1, -10, -25, -45]) {
      const arc = { target: { x: 0, z: -90 }, angle }
      const first = firstBounceFraction(angle)
      expect(first).lessThan(previous)
      previous = first
      expect(arcPoint(arc, first).y).closeTo(TERRAIN.players + 0.16, 0.000001)
      for (let i = 0; i <= 100; i++)
        expect(arcPoint(arc, i / 100).y).at.least(TERRAIN.players + 0.15999)
      const nextPeak = arcPoint(arc, first + (1 - first) * 0.3).y
      expect(nextPeak).greaterThan(arcPoint(arc, first).y)
      expect(arcPoint(arc, first / 2).y).closeTo(
        (BALL_CONTACT + TERRAIN.players + 0.16) / 2,
        0.00001
      )
      expect(arcHandle(arc)).deep.equals(arcPoint(arc, first))
    }
  })
  it('supports tap, live drag, release, arrow adjustment and pointer cancellation without moving players', async function () {
    const players = createPlayers()
    let current: BallArcState = { target: { x: 0, z: -60 }, angle: 30 }
    let finished = 0
    let captured = false
    let camera: Camera | undefined
    const props = {
      players,
      selected: 'SS',
      onSelect: () => undefined,
      view: 'home' as const,
      zoom: 1,
      onArcChange: (value: BallArcState) => {
        current = value
      },
      onArcFinish: () => {
        finished++
      }
    }
    const renderer = await create(
      React.createElement(FieldScene, { ...props, arcMode: 'aim' }),
      {
        width: 390,
        height: 556,
        onCreated: state => {
          camera = state.camera
        }
      }
    )
    try {
      const surface = renderer.scene.findByProps({
        name: 'arc-interaction-surface'
      })
      const target = {
        setPointerCapture: () => {
          captured = true
        },
        releasePointerCapture: () => {
          captured = false
        }
      }
      const ray = new Ray(new Vector3(10, 100, -50), new Vector3(0, -1, 0))
      const event = {
        button: 0,
        pointerId: 3,
        pointer: new Vector2(),
        ray,
        target
      }
      await renderer.fireEvent(surface, 'pointerDown', event)
      expect(current.target).deep.equals({ x: 10, z: -50 })
      expect(captured).equals(true)
      await renderer.fireEvent(surface, 'pointerUp', event)
      expect(finished).equals(1)
      await renderer.fireEvent(surface, 'pointerDown', event)
      ray.origin.set(25, 100, -75)
      await renderer.fireEvent(surface, 'pointerMove', event)
      expect(current.target).deep.equals({ x: 25, z: -75 })
      await renderer.fireEvent(surface, 'pointerUp', event)
      expect(captured).equals(false)
      await renderer.update(
        React.createElement(FieldScene, {
          ...props,
          arc: current,
          arcMode: 'edit'
        })
      )
      await renderer.advanceFrames(1, 1 / 60)
      if (camera == null) throw new Error('No camera')
      const tip = arcHandle(current)
      const screen = new Vector3(tip.x, tip.y, tip.z).project(camera)
      event.pointer.set(screen.x + (90 * 2) / 390, screen.y)
      const edit = renderer.scene.findByProps({
        name: 'arc-interaction-surface'
      })
      await renderer.fireEvent(edit, 'pointerDown', event)
      expect(captured).equals(true)
      event.pointer.y -= 0.8
      await renderer.fireEvent(edit, 'pointerMove', event)
      expect(current.angle).lessThan(5)
      await renderer.fireEvent(edit, 'pointerCancel', event)
      expect(captured).equals(false)
      expect(players.map(player => player.target)).deep.equals(
        createPlayers().map(player => player.target)
      )
    } finally {
      await renderer.unmount()
    }
  })
})

describe('home runs and pop-ups', function () {
  it('reaches 70 degrees even when the landing point is close to home', function () {
    const angle = dragLaunchAngle(30, 80)
    expect(angle).equals(70)
    for (const distance of [3, 8, 15, 140]) {
      const arc = { target: { x: 0, z: -distance }, angle }
      const start = arcPoint(arc, 0)
      const tiny = arcPoint(arc, 0.00001)
      expect((tiny.y - start.y) / Math.hypot(tiny.x, tiny.z)).closeTo(
        Math.tan((70 * Math.PI) / 180),
        0.001
      )
      expect(arcHandle(arc).y).greaterThan(start.y)
    }
  })
  it('places a home-run landing on the spectator tiers instead of clamping to the outfield', async function () {
    let current: BallArcState | null = null
    const renderer = await create(
      React.createElement(FieldScene, {
        players: createPlayers(),
        selected: 'SS',
        onSelect: () => undefined,
        view: 'home',
        zoom: 1,
        arcMode: 'aim',
        onArcChange: value => {
          current = value
        }
      })
    )
    try {
      await renderer.advanceFrames(1, 1 / 60)
      renderer.scene.instance.updateMatrixWorld(true)
      const surface = renderer.scene.findByProps({
        name: 'arc-interaction-surface'
      })
      const event = {
        button: 0,
        pointerId: 12,
        pointer: new Vector2(),
        ray: new Ray(new Vector3(0, 100, -133), new Vector3(0, -1, 0)),
        target: {
          setPointerCapture: () => undefined,
          releasePointerCapture: () => undefined
        }
      }
      await renderer.fireEvent(surface, 'pointerDown', event)
      await renderer.fireEvent(surface, 'pointerUp', event)
      const result: BallArcState | null = current
      expect(result).not.equals(null)
      if (result == null) throw new Error('No landing')
      // Callback mutates current during the renderer event.
      expect((result as BallArcState).target.z).closeTo(-133, 0.01)
      expect((result as BallArcState).landingHeight).greaterThan(8)
      expect(arcPoint(result, 1).y).greaterThan(8)
    } finally {
      await renderer.unmount()
    }
  })
})
