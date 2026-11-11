import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { type Camera, Ray, Vector2, Vector3 } from 'three'

import { createPlayers, type FieldPlayer } from './fieldModel'
import { FieldScene } from './FieldScene'
import type { FieldPlacement } from './fieldTypes'

describe('a defender drag while the screen redraws', () => {
  it('keeps the grab when the same players arrive as new objects, and drops it when they change', async () => {
    const first = createPlayers().slice(0, 9)
    const short = first.find(player => player.id === 'SS')!
    const placed: FieldPlacement[] = []
    let camera: Camera
    const scene = (players: FieldPlayer[]): React.ReactElement => (
      <FieldScene
        players={players}
        selected=""
        onSelect={() => undefined}
        view="home"
        zoom={1}
        acceptDefenderTap
        interaction={{
          generation: 0,
          selectableIds: players.map(player => player.id),
          gestures: ['place']
        }}
        onFieldPlacement={placement => {
          placed.push(placement)
        }}
      />
    )
    const renderer = await create(scene(first), {
      width: 900,
      height: 650,
      onCreated: state => {
        camera = state.camera
      }
    })
    const target = { setPointerCapture() {}, releasePointerCapture() {} }
    const world = (x: number, y: number, z: number): object => {
      const point = new Vector3(x, y, z).project(camera)
      const pointer = new Vector2(point.x, point.y)
      const far = new Vector3(pointer.x, pointer.y, 0.5).unproject(camera)
      return {
        pointerId: 1,
        button: 0,
        pointerType: 'mouse',
        pointer,
        target,
        ray: new Ray(
          camera.position.clone(),
          far.sub(camera.position).normalize()
        )
      }
    }
    const { x, z } = short.position
    try {
      await renderer.advanceFrames(1, 1 / 60)
      const surface = renderer.scene.findByProps({
        name: 'interaction-surface'
      })
      // A save answered mid-drag: the same nine players, drawn again.
      await renderer.fireEvent(surface, 'pointerDown', world(x, 1, z))
      await renderer.update(scene(first.map(player => ({ ...player }))))
      await renderer.fireEvent(surface, 'pointerMove', world(x, 1, z - 4))
      await renderer.fireEvent(surface, 'pointerUp', world(x, 1, z - 4))
      expect(placed.map(placement => placement.entityId)).deep.equals(['SS'])

      // A player leaving mid-drag ends it.
      const now = first.map(player => ({ ...player }))
      await renderer.update(scene(now))
      const shortNow = now.find(player => player.id === 'SS')!
      await renderer.fireEvent(
        surface,
        'pointerDown',
        world(shortNow.position.x, 1, shortNow.position.z)
      )
      await renderer.update(scene(now.filter(player => player.id !== 'LF')))
      await renderer.fireEvent(surface, 'pointerUp', world(x, 1, z - 4))
      expect(placed).has.length(1)
    } finally {
      await renderer.unmount()
    }
  })
})
