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

  it('submits a retreat drop without requiring Safe/Out targets', async function () {
    const runner = createPlayers()[9]
    runner.position = { ...BASES[3] }
    runner.target = { ...runner.position }
    runner.runnerBase = 3
    let camera: Camera | undefined
    let view: RunnerDragView | null = null
    const decisions: unknown[] = []
    const renderer = await create(
      React.createElement(FieldScene, {
        players: [runner],
        selected: runner.id,
        onSelect: () => {},
        view: 'home',
        zoom: 1,
        interaction: {
          generation: 4,
          selectableIds: [runner.id],
          runnerIds: [runner.id],
          retreatIds: [runner.id],
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
      await renderer.fireEvent(
        surface,
        'pointerDown',
        world(BASES[3].x, 5, BASES[3].z)
      )
      await new Promise(resolve => setTimeout(resolve, 400))
      await renderer.fireEvent(
        surface,
        'pointerMove',
        world(BASES[2].x, 0.7, BASES[2].z)
      )
      const active = view as RunnerDragView | null
      expect(active?.to).equals(2)
      expect(active?.hovered).equals('safe')
      await renderer.fireEvent(
        surface,
        'pointerUp',
        world(BASES[2].x, 0.7, BASES[2].z)
      )
      expect(decisions).deep.equals([[runner.id, 2, 'safe', 4]])
    } finally {
      await renderer.unmount()
    }
  })

  it('does not submit a retreat drop when runnerSafeError disables it', async function () {
    const runner = createPlayers()[9]
    runner.position = { ...BASES[3] }
    runner.target = { ...runner.position }
    runner.runnerBase = 3
    let camera: Camera | undefined
    let view: RunnerDragView | null = null
    const decisions: unknown[] = []
    const renderer = await create(
      React.createElement(FieldScene, {
        players: [runner],
        selected: runner.id,
        onSelect: () => {},
        view: 'home',
        zoom: 1,
        interaction: {
          generation: 4,
          selectableIds: [runner.id],
          runnerIds: [runner.id],
          retreatIds: [runner.id],
          gestures: ['place']
        },
        runnerSafeError: (_id, to) =>
          to === 2
            ? 'That base is occupied. Move the lead runner first.'
            : undefined,
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
      await renderer.fireEvent(
        surface,
        'pointerDown',
        world(BASES[3].x, 5, BASES[3].z)
      )
      await new Promise(resolve => setTimeout(resolve, 400))
      await renderer.fireEvent(
        surface,
        'pointerMove',
        world(BASES[2].x, 0.7, BASES[2].z)
      )
      const active = view as RunnerDragView | null
      expect(active?.to).equals(2)
      expect(active?.safeDisabled).equals(
        'That base is occupied. Move the lead runner first.'
      )
      expect(active?.hovered).equals(undefined)
      await renderer.fireEvent(
        surface,
        'pointerUp',
        world(BASES[2].x, 0.7, BASES[2].z)
      )
      expect(decisions).deep.equals([])
    } finally {
      await renderer.unmount()
    }
  })

  it('tells the screen when the offer changes, not on every move', async function () {
    const runner = createPlayers()[9]
    runner.position = { ...BASES[1] }
    runner.target = { ...runner.position }
    runner.runnerBase = 1
    let camera: Camera | undefined
    const views: Array<RunnerDragView | null> = []
    const renderer = await create(
      React.createElement(FieldScene, {
        players: [runner],
        selected: runner.id,
        onSelect: () => {},
        view: 'home',
        zoom: 1,
        interaction: {
          generation: 1,
          selectableIds: [runner.id],
          runnerIds: [runner.id],
          gestures: ['place']
        },
        onRunnerDrag: value => {
          views.push(value)
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
    const between = (t: number): object => {
      const ground = new Vector3(
        BASES[1].x + (BASES[2].x - BASES[1].x) * t,
        0.7,
        BASES[1].z + (BASES[2].z - BASES[1].z) * t
      )
      const projected = ground.project(camera!)
      const pointer = new Vector2(projected.x, projected.y)
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
    try {
      await renderer.advanceFrames(1, 1 / 60)
      const surface = renderer.scene.findByProps({
        name: 'interaction-surface'
      })
      await renderer.fireEvent(surface, 'pointerDown', between(0))
      const guide = renderer.scene.findByProps({ name: 'move-preview' })
      const marker = (): { x: number; z: number } =>
        guide.instance.getObjectByName('destination-marker')!.position
      for (const t of [0.1, 0.2, 0.3, 0.4]) {
        await renderer.fireEvent(surface, 'pointerMove', between(t))
        await renderer.advanceFrames(1, 1 / 60)
        // The runner and the guide follow the finger in the scene…
        expect(runner.position.x).closeTo(
          BASES[1].x + (BASES[2].x - BASES[1].x) * t,
          0.5
        )
        expect(marker().x).closeTo(runner.position.x, 1e-6)
      }
      // …and the screen heard once: still bound for first.
      expect(views.map(view => view?.to)).deep.equals([1])
      for (const t of [0.7, 0.8, 0.9])
        await renderer.fireEvent(surface, 'pointerMove', between(t))
      // Past halfway, second is the offer.
      expect(views.map(view => view?.to)).deep.equals([1, 2])
      await renderer.fireEvent(surface, 'pointerUp', between(0.9))
      expect(views.at(-1)).equals(null)
    } finally {
      await renderer.unmount()
    }
  })
})
