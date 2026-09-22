import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { type Camera, Ray, Vector2, Vector3 } from 'three'

import {
  arcHandle,
  arcPoint,
  arcTarget,
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
      y: TERRAIN.players + 0.16,
      z: 0
    })
    const end = arcPoint(arc, 1)
    expect(end.x).equals(30)
    expect(end.z).equals(-60)
    expect(end.y).closeTo(TERRAIN.players + 0.16, 0.000001)
    const first = arcPoint(arc, 0.0001)
    expect((first.y - end.y) / Math.hypot(first.x, first.z)).closeTo(
      Math.tan(Math.PI / 6),
      0.001
    )
    expect(dragLaunchAngle(30, 100)).equals(65)
    expect(dragLaunchAngle(30, -300)).equals(-45)
    expect(
      Math.hypot(...Object.values(arcTarget({ x: 200, z: -200 })))
    ).at.most(110)
  })
  it('moves the first chop toward home and retains nonnegative diminishing bounces', function () {
    let previous = 1
    for (const angle of [4, -10, -25, -45]) {
      const arc = { target: { x: 0, z: -90 }, angle }
      const first = firstBounceFraction(angle)
      expect(first).lessThan(previous)
      previous = first
      expect(arcPoint(arc, first).y).closeTo(TERRAIN.players + 0.16, 0.000001)
      for (let i = 0; i <= 100; i++)
        expect(arcPoint(arc, i / 100).y).at.least(TERRAIN.players + 0.15999)
      const nextPeak = arcPoint(arc, first + (1 - first) * 0.3).y
      expect(nextPeak).lessThan(arcPoint(arc, first / 2).y)
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
      event.pointer.set(screen.x + 0.05, screen.y)
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
