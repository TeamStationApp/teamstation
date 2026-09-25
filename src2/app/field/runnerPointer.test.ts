import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { type Camera, Ray, Vector2, Vector3 } from 'three'

import type { RunnerDragView } from '../scoring/runnerDrag'
import { BASES, createPlayers } from './fieldModel'
import { FieldScene } from './FieldScene'
describe('runner captured pointer decisions', function () {
  it('requires a direct grab, constrains the runner, submits on release and cancels without lingering controls', async function () {
    const runner = createPlayers()[9]
    runner.position = { ...BASES[1] }
    runner.target = { ...runner.position }
    runner.runnerBase = 1
    let camera: Camera | undefined
    let view: RunnerDragView | null = null
    const decisions: unknown[] = []
    let selection = ''
    const renderer = await create(
      React.createElement(FieldScene, {
        players: [runner],
        selected: runner.id,
        onSelect: id => {
          selection = id
        },
        view: 'home',
        zoom: 1,
        interaction: {
          generation: 2,
          selectableIds: [runner.id],
          runnerIds: [runner.id],
          gestures: ['place']
        },
        onRunnerDrag: value => {
          view = value
        },
        onRunnerDrop: (...args) => {
          decisions.push(args)
        }
      }),
      {
        width: 900,
        height: 650,
        onCreated: state => {
          camera = state.camera
        }
      }
    )
    const target = { setPointerCapture() {}, releasePointerCapture() {} }
    const eventAt = (x: number, y: number): object => {
      const pointer = new Vector2((x / 900) * 2 - 1, 1 - (y / 650) * 2)
      const point = new Vector3(pointer.x, pointer.y, 0.5).unproject(camera!)
      return {
        pointerId: 1,
        button: 0,
        pointer,
        target,
        ray: new Ray(
          camera!.position.clone(),
          point.sub(camera!.position).normalize()
        )
      }
    }
    const world = (x: number, y: number, z: number): object => {
      const point = new Vector3(x, y, z).project(camera!)
      return eventAt((point.x + 1) * 450, (1 - point.y) * 325)
    }
    try {
      await renderer.advanceFrames(1, 1 / 60)
      const surface = renderer.scene.findByProps({
        name: 'interaction-surface'
      })
      await renderer.fireEvent(surface, 'pointerDown', world(-60, 0, -60))
      expect(selection).equals('')
      await renderer.fireEvent(
        surface,
        'pointerDown',
        world(BASES[1].x, 5, BASES[1].z)
      )
      expect(selection).equals(runner.id)
      await renderer.fireEvent(
        surface,
        'pointerMove',
        world(BASES[2].x, 0.7, BASES[2].z)
      )
      const active = view as RunnerDragView | null
      expect(active?.to).equals(2)
      expect(runner.position.x).closeTo(0, 0.01)
      await renderer.fireEvent(
        surface,
        'pointerMove',
        eventAt(active!.safe.x + 20, active!.safe.y + 20)
      )
      expect((view as RunnerDragView | null)?.hovered).equals('safe')
      await renderer.fireEvent(
        surface,
        'pointerUp',
        eventAt(active!.safe.x + 20, active!.safe.y + 20)
      )
      expect(decisions).deep.equals([[runner.id, 2, 'safe', 2]])
      expect(view).equals(null)
      expect(selection).equals('')
      expect(runner.position).deep.equals(BASES[1])
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
      await renderer.fireEvent(
        surface,
        'pointerCancel',
        world(BASES[2].x, 0.7, BASES[2].z)
      )
      expect(decisions).has.length(1)
      expect(view).equals(null)
      expect(runner.position).deep.equals(BASES[1])
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
      await renderer.fireEvent(surface, 'lostPointerCapture', {})
      expect(view).equals(null)
      expect(decisions).has.length(1)
    } finally {
      await renderer.unmount()
    }
  })
})
