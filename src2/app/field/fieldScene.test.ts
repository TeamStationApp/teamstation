import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { type Camera, Ray, Sprite, Vector2, Vector3 } from 'three'

import { createPlayers } from './fieldModel'
import { FieldScene } from './FieldScene'

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
      const ray = new Ray(new Vector3(-10, 100, -70), new Vector3(0, -1, 0))
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
      ray.origin.set(-30, 100, -80)
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
