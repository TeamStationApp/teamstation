import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { type Camera, Ray, Vector2, Vector3 } from 'three'

import { createPlayers } from './fieldModel'
import { FieldScene } from './FieldScene'

describe('rendered field interaction', function () {
  it('mounts the stadium and all players, captures a drag, animates and releases it', async function () {
    const players = createPlayers()
    let selection = ''
    let captured = false
    let camera: Camera | undefined
    const renderer = await create(
      React.createElement(FieldScene, {
        players,
        selected: 'SS',
        view: 'home',
        zoom: 1,
        onSelect: (id: string) => {
          selection = id
        }
      }),
      {
        width: 900,
        height: 700,
        onCreated: state => {
          camera = state.camera
        }
      }
    )
    try {
      for (const player of players) {
        expect(
          renderer.scene.findByProps({ name: `player-${player.id}` })
        ).not.equals(undefined)
      }
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
      const pointer = new Vector2(2, 2) // Empty turf, move the roster selection.
      const ray = new Ray(new Vector3(-10, 100, -70), new Vector3(0, -1, 0))
      await renderer.fireEvent(surface, 'pointerDown', {
        button: 0,
        pointerId: 7,
        pointer,
        ray,
        target
      })
      expect(selection).equals('SS')
      expect(captured).equals(true)
      const player = players[4]
      expect(player.target).deep.equals({ x: -10, z: -70 })
      await renderer.advanceFrames(30, 1 / 60)
      const model = renderer.scene.findByProps({ name: 'player-SS' }).instance
      expect(model.position.z).lessThan(-41)
      expect(player.speed).greaterThan(0)
      ray.origin.set(20, 100, -60)
      await renderer.fireEvent(surface, 'pointerMove', { pointerId: 7, ray })
      expect(player.target).deep.equals({ x: 20, z: -60 })
      await renderer.fireEvent(surface, 'pointerUp', { pointerId: 7, target })
      expect(captured).equals(false)
      ray.origin.set(30, 100, -80)
      await renderer.fireEvent(surface, 'pointerMove', { pointerId: 7, ray })
      expect(player.target).deep.equals({ x: 20, z: -60 })
      await renderer.advanceFrames(600, 1 / 60)
      expect(player.position).deep.equals(player.target)
      expect(player.speed).equals(0)
      if (camera == null) throw new Error('Camera was not created')
      for (const item of players) {
        const screen = new Vector3(
          item.position.x,
          2.5,
          item.position.z
        ).project(camera)
        await renderer.fireEvent(surface, 'pointerDown', {
          button: 0,
          pointerId: 8,
          pointer: new Vector2(screen.x, screen.y),
          ray,
          target
        })
        expect(selection).equals(item.id)
        await renderer.fireEvent(surface, 'pointerCancel', {
          pointerId: 8,
          target
        })
        expect(captured).equals(false)
      }
    } finally {
      await renderer.unmount()
    }
  })
})

describe('scoreboard camera', function () {
  it('fits the enlarged board on a portrait phone and leaves player positions untouched', async function () {
    const players = createPlayers()
    let camera: Camera | undefined
    const renderer = await create(
      React.createElement(FieldScene, {
        players,
        selected: 'SS',
        view: 'scoreboard',
        zoom: 1,
        onSelect: () => undefined
      }),
      {
        width: 390,
        height: 450,
        onCreated: state => {
          camera = state.camera
        }
      }
    )
    try {
      if (camera == null) throw new Error('Camera was not created')
      camera.updateMatrixWorld()
      for (const x of [-63, 63])
        for (const y of [18, 83]) {
          const corner = new Vector3(x, y, -158).project(camera)
          expect(Math.abs(corner.x)).lessThan(1)
          expect(Math.abs(corner.y)).lessThan(1)
        }
      const surface = renderer.scene.findByProps({
        name: 'interaction-surface'
      })
      await renderer.fireEvent(surface, 'pointerDown', {
        button: 0,
        pointerId: 1
      })
      expect(players[4].target).deep.equals(createPlayers()[4].target)
    } finally {
      await renderer.unmount()
    }
  })
})
