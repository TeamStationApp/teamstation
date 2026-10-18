import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { useState } from 'react'
import { type Camera, Ray, Vector2, Vector3 } from 'three'

import type { RunnerDragView } from '../scoring/runnerDrag'
import { BASES, createPlayers } from './fieldModel'
import { FieldScene } from './FieldScene'

describe('runner drag while defender editing locks', () => {
  it('keeps the grabbed runner active when tap-only defenders disappear', async () => {
    const runner = createPlayers()[9]
    runner.position = { ...BASES[1] }
    runner.target = { ...BASES[1] }
    runner.runnerBase = 1
    const defender = createPlayers()[0]
    const players = [runner, defender]
    let camera: Camera
    let view: RunnerDragView | null = null
    const drops: unknown[] = []
    function Screen({
      blocked = false
    }: {
      blocked?: boolean
    }): React.ReactElement {
      const [active, setActive] = useState(false)
      const tapIds = active ? [] : [defender.id]
      return (
        <FieldScene
          players={players}
          selected=""
          onSelect={() => undefined}
          view="home"
          zoom={1}
          tapIds={tapIds}
          onGestureActive={setActive}
          interaction={{
            generation: 0,
            selectableIds: blocked ? [] : [...tapIds, runner.id],
            runnerIds: [runner.id],
            gestures: ['place']
          }}
          onRunnerDrag={value => {
            view = value
          }}
          onRunnerDrop={(...args) => {
            drops.push(args)
          }}
        />
      )
    }
    const renderer = await create(<Screen />, {
      width: 900,
      height: 650,
      onCreated: state => {
        camera = state.camera
      }
    })
    const target = { setPointerCapture() {}, releasePointerCapture() {} }
    const at = (x: number, y: number): object => {
      const pointer = new Vector2(x / 450 - 1, 1 - y / 325)
      const point = new Vector3(pointer.x, pointer.y, 0.5).unproject(camera)
      return {
        pointerId: 1,
        button: 0,
        pointerType: 'touch',
        pointer,
        target,
        ray: new Ray(
          camera.position.clone(),
          point.sub(camera.position).normalize()
        )
      }
    }
    const world = (x: number, y: number, z: number): object => {
      const point = new Vector3(x, y, z).project(camera)
      return at((point.x + 1) * 450, (1 - point.y) * 325)
    }
    try {
      await renderer.advanceFrames(1, 1 / 60)
      const surface = renderer.scene.findByProps({
        name: 'interaction-surface'
      })
      await renderer.fireEvent(
        surface,
        'pointerDown',
        world(BASES[1].x, 5, BASES[1].z)
      )
      await renderer.fireEvent(
        surface,
        'pointerMove',
        world(BASES[2].x, 0.7, BASES[2].z)
      )
      const active = view as RunnerDragView | null
      expect(active?.to).equals(2)
      await renderer.fireEvent(
        surface,
        'pointerUp',
        at(active!.safe.x + 20, active!.safe.y + 20)
      )
      expect(drops).deep.equals([[runner.id, 2, 'safe', 0]])
      expect(view).equals(null)

      await renderer.fireEvent(
        surface,
        'pointerDown',
        world(BASES[1].x, 5, BASES[1].z)
      )
      await renderer.update(<Screen blocked />)
      await renderer.fireEvent(
        surface,
        'pointerMove',
        world(BASES[2].x, 0.7, BASES[2].z)
      )
      await renderer.fireEvent(
        surface,
        'pointerUp',
        at(active!.safe.x + 20, active!.safe.y + 20)
      )
      expect(view).equals(null)
      expect(drops).has.length(1)
      expect(runner.position).deep.equals(BASES[1])
    } finally {
      await renderer.unmount()
    }
  })
})
