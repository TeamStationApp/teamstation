import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { type Camera, Ray, Sprite, Vector2, Vector3 } from 'three'

import type { BallArcState } from './ballArcModel'
import { createPlayers } from './fieldModel'
import { FieldScene } from './FieldScene'
import { TERRAIN } from './terrain'

describe('rendered field interaction', function () {
  it('previews movement without running, commits on release, and cancels cleanly', async function () {
    const players = createPlayers()
    let captured = false
    const renderer = await create(
      React.createElement(FieldScene, {
        players,
        selected: 'SS',
        onSelect: () => undefined,
        view: 'home',
        zoom: 1
      })
    )
    try {
      await renderer.advanceFrames(1, 1 / 60)
      const surface = renderer.scene.findByProps({
        name: 'interaction-surface'
      })
      const target = {
        setPointerCapture: () => {
          captured = true
        },
        releasePointerCapture: () => {
          captured = false
        }
      }
      const ray = new Ray(new Vector3(-15, 100, -41), new Vector3(0, -1, 0))
      const event = {
        button: 0,
        pointerId: 7,
        pointer: new Vector2(2, 2),
        ray,
        target
      }
      const start = { ...players[4].position }
      await renderer.fireEvent(surface, 'pointerDown', event)
      expect(captured).equals(true)
      expect(players[4].target).deep.equals(start)
      await renderer.advanceFrames(30, 1 / 60)
      expect(players[4].position).deep.equals(start)
      expect(renderer.scene.findByProps({ name: 'move-preview' })).not.equals(
        undefined
      )
      ray.origin.set(20, 100, -60)
      await renderer.fireEvent(surface, 'pointerMove', event)
      expect(players[4].position).deep.equals(start)
      await renderer.fireEvent(surface, 'pointerUp', event)
      expect(players[4].target).deep.equals({ x: 20, z: -60 })
      expect(captured).equals(false)
      await renderer.advanceFrames(600, 1 / 60)
      expect(players[4].position).deep.equals(players[4].target)
      ray.origin.set(players[4].position.x, 100, players[4].position.z)
      const before = { ...players[4].target }
      await renderer.fireEvent(surface, 'pointerDown', event)
      await renderer.fireEvent(surface, 'pointerCancel', event)
      expect(players[4].target).deep.equals(before)
      expect(players[4].dragging).equals(false)
    } finally {
      await renderer.unmount()
    }
  })
  it('selects a player by an actual body or nameplate ray hit', async function () {
    const players = createPlayers()
    let selection = ''
    let camera: Camera | undefined
    const renderer = await create(
      React.createElement(FieldScene, {
        players,
        selected: 'P',
        onSelect: id => {
          selection = id
        },
        view: 'home',
        zoom: 1
      }),
      {
        width: 900,
        height: 650,
        onCreated: state => {
          camera = state.camera
        }
      }
    )
    try {
      await renderer.advanceFrames(1, 1 / 60)
      renderer.scene.instance.updateMatrixWorld(true)
      if (camera == null) throw new Error('Missing camera')
      const surface = renderer.scene.findByProps({
        name: 'interaction-surface'
      })
      const target = {
        setPointerCapture: () => undefined,
        releasePointerCapture: () => undefined
      }
      for (const id of ['1B', '3B', 'C', 'SS']) {
        const sprite = renderer.scene.findByProps({
          name: `player-label-${id}`
        }).instance
        if (!(sprite instanceof Sprite)) throw new Error('Missing label')
        const center = sprite.getWorldPosition(new Vector3())
        center.add(
          new Vector3(
            (0.5 - sprite.center.x) * sprite.scale.x,
            (0.5 - sprite.center.y) * sprite.scale.y,
            0
          ).applyQuaternion(camera.quaternion)
        )
        const ndc = center.clone().project(camera)
        const event = {
          button: 0,
          pointerId: 8,
          pointer: new Vector2(ndc.x, ndc.y),
          ray: new Ray(
            camera.position.clone(),
            center.sub(camera.position).normalize()
          ),
          target
        }
        await renderer.fireEvent(surface, 'pointerDown', event)
        expect(selection).equals(id)
        await renderer.fireEvent(surface, 'pointerCancel', event)
      }
      const body = new Vector3(players[6].position.x, 6, players[6].position.z)
      const screen = body.clone().project(camera)
      const event = {
        button: 0,
        pointerId: 9,
        pointer: new Vector2(screen.x, screen.y),
        ray: new Ray(
          camera.position.clone(),
          body.sub(camera.position).normalize()
        ),
        target
      }
      await renderer.fireEvent(surface, 'pointerDown', event)
      expect(selection).equals('LF')
      await renderer.fireEvent(surface, 'pointerCancel', event)
    } finally {
      await renderer.unmount()
    }
  })
})

describe('mobile finger clearance', function () {
  it('picks the body under the finger but previews and commits player and arc destinations above it', async function () {
    const players = createPlayers()
    let selection = ''
    let camera: Camera | undefined
    let arc: BallArcState = { target: { x: 0, z: 0 }, angle: 30 }
    const props = {
      players,
      selected: 'P',
      view: 'home' as const,
      zoom: 1,
      onSelect: (id: string) => {
        selection = id
      },
      onArcChange: (value: BallArcState) => {
        arc = value
      }
    }
    const renderer = await create(React.createElement(FieldScene, props), {
      width: 390,
      height: 488,
      onCreated: state => {
        camera = state.camera
      }
    })
    try {
      await renderer.advanceFrames(1, 1 / 60)
      renderer.scene.instance.updateMatrixWorld(true)
      if (camera == null) throw new Error('Missing camera')
      const player = players[6]
      const start = { ...player.position }
      const body = new Vector3(start.x, 6, start.z)
      const screen = body.clone().project(camera)
      const event = {
        button: 0,
        pointerId: 19,
        pointerType: 'touch',
        pointer: new Vector2(screen.x, screen.y),
        ray: new Ray(
          camera.position.clone(),
          body.sub(camera.position).normalize()
        ),
        target: {
          setPointerCapture: () => undefined,
          releasePointerCapture: () => undefined
        }
      }
      const surface = renderer.scene.findByProps({
        name: 'interaction-surface'
      })
      await renderer.fireEvent(surface, 'pointerDown', event)
      expect(selection).equals('LF')
      const landing = new Vector3(0, TERRAIN.players, -50)
      const finger = landing.clone().project(camera)
      event.pointer.set(finger.x, finger.y)
      event.ray.direction.copy(landing).sub(camera.position).normalize()
      await renderer.fireEvent(surface, 'pointerMove', event)
      expect(player.position).deep.equals(start)
      await renderer.fireEvent(surface, 'pointerUp', event)
      const projected = new Vector3(
        player.target.x,
        TERRAIN.players,
        player.target.z
      ).project(camera)
      expect(((projected.y - finger.y) * 488) / 2).closeTo(32, 0.001)
      expect(projected.x).closeTo(finger.x, 0.001)
      await renderer.update(
        React.createElement(FieldScene, { ...props, arcMode: 'aim' })
      )
      const arcSurface = renderer.scene.findByProps({
        name: 'arc-interaction-surface'
      })
      for (const pointerType of ['touch', 'mouse']) {
        event.pointerType = pointerType
        await renderer.fireEvent(arcSurface, 'pointerDown', event)
        await renderer.fireEvent(arcSurface, 'pointerUp', event)
        projected
          .set(arc.target.x, TERRAIN.players, arc.target.z)
          .project(camera)
        expect(((projected.y - finger.y) * 488) / 2).closeTo(
          pointerType === 'touch' ? 32 : 0,
          0.001
        )
      }
    } finally {
      await renderer.unmount()
    }
  })
})
