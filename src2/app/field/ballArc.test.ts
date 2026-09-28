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
  BALL_GROUND,
  type BallArcState,
  dragLaunchAngle,
  firstBounceFraction,
  MAX_LAUNCH_ANGLE,
  TAP_SLOP_PX
} from './ballArcModel'
import { createPlayers } from './fieldModel'
import { FieldScene } from './FieldScene'
import { TERRAIN } from './terrain'
import { trajectoryGrip } from './trajectoryGrip'
import { guideBearing } from './trajectoryGuide'

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
    expect(dragLaunchAngle(30, 200)).equals(MAX_LAUNCH_ANGLE)
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
      const grip = trajectoryGrip(
        { ...current, guideBearing: guideBearing(current.target) },
        camera,
        { width: 390, height: 556 }
      )
      const screen = grip.position.project(camera)
      event.pointer.set(screen.x + (90 * 2) / 390, screen.y)
      const edit = renderer.scene.findByProps({
        name: 'arc-interaction-surface'
      })
      await renderer.fireEvent(edit, 'pointerDown', event)
      expect(captured).equals(true)
      event.pointer.y -= 0.8
      await renderer.fireEvent(edit, 'pointerMove', event)
      expect(current.angle).lessThan(5)
      event.pointer.y += 2
      await renderer.fireEvent(edit, 'pointerMove', event)
      expect(current.angle).equals(85)
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

describe("the scorer's own launch angle", function () {
  /** A gesture's stops: pixels right and up from where it went down. */
  type Gesture = Array<[number, number]>
  const taps: Array<[string, Gesture]> = [
    ['still', []],
    ['2 px up', [[0, 2]]],
    ['2 px down', [[0, -2]]],
    [
      '2 px down by steps',
      [
        [1, -1],
        [2, -2]
      ]
    ],
    [
      '2 px out and back',
      [
        [0, 2],
        [0, 0]
      ]
    ],
    [
      'a 40 px sideways slip',
      [
        [20, 1],
        [40, 0]
      ]
    ]
  ]
  const drags: Array<[string, Gesture, number]> = [
    ['20 px up', [[0, 20]], 55],
    [
      '30 px down',
      [
        [5, -15],
        [5, -30]
      ],
      30
    ],
    ['4 px up', [[0, 4]], 47]
  ]
  const canvases = [
    { width: 390, height: 556, start: [0, 0] },
    { width: 390, height: 556, start: [0, -0.3] },
    { width: 1024, height: 700, start: [0.37, 0.21] },
    { width: 834, height: 1112, start: [-0.53, -0.61] },
    { width: 1180, height: 820, start: [0.123, -0.777] }
  ] as const

  for (const { width, height, start } of canvases)
    it(`takes only vertical travel past ${TAP_SLOP_PX} px as a drag, on ${width}×${height} from (${start.join(', ')})`, async function () {
      const accepted: Array<[number, number, boolean | undefined]> = []
      let current: BallArcState | null = null
      const arc: BallArcState = { target: { x: 0, z: -80 }, angle: 45 }
      const renderer = await create(
        React.createElement(FieldScene, {
          players: createPlayers(),
          selected: 'SS',
          onSelect: () => undefined,
          view: 'home',
          zoom: 1,
          arc,
          arcMode: 'edit',
          interaction: {
            generation: 0,
            selectableIds: [],
            gestures: ['trajectory']
          },
          onArcChange: value => {
            current = value
          },
          onTrajectoryAccepted: (angle, generation, dragged) => {
            accepted.push([angle, generation, dragged])
          }
        }),
        { width, height }
      )
      try {
        await renderer.advanceFrames(1, 1 / 60)
        const surface = renderer.scene.findByProps({
          name: 'arc-interaction-surface'
        })
        const event = {
          button: 0,
          pointerId: 5,
          pointer: new Vector2(),
          ray: new Ray(new Vector3(0, 100, -80), new Vector3(0, -1, 0)),
          target: {
            setPointerCapture: () => undefined,
            releasePointerCapture: () => undefined
          }
        }
        const gesture = async (stops: Gesture): Promise<void> => {
          event.pointer.set(start[0], start[1])
          await renderer.fireEvent(surface, 'pointerDown', event)
          for (const [right, up] of stops) {
            event.pointer.set(
              start[0] + (right * 2) / width,
              start[1] + (up * 2) / height
            )
            await renderer.fireEvent(surface, 'pointerMove', event)
          }
          await renderer.fireEvent(surface, 'pointerUp', event)
        }
        // Taps accept the angle the control started at, and put it back.
        for (const [name, stops] of taps) {
          accepted.length = 0
          current = null
          await gesture(stops)
          expect(accepted, name).deep.equals([[45, 0, false]])
          if (stops.length > 0)
            expect(current, name).deep.include({ angle: 45 })
        }
        // A drag up or down is the scorer's own, at the angle it turned to.
        for (const [name, stops, angle] of drags) {
          accepted.length = 0
          await gesture(stops)
          expect(accepted, name).length(1)
          expect(accepted[0][0], name).closeTo(angle, 1e-9)
          expect(accepted[0].slice(1), name).deep.equals([0, true])
        }
      } finally {
        await renderer.unmount()
      }
    })
})

describe('home runs and pop-ups', function () {
  it('reaches 85 degrees even when the landing point is close to home', function () {
    const angle = dragLaunchAngle(30, 200)
    expect(angle).equals(85)
    for (const distance of [3, 8, 15, 140]) {
      const arc = { target: { x: 0, z: -distance }, angle }
      const start = arcPoint(arc, 0)
      const tiny = arcPoint(arc, 0.00001)
      expect((tiny.y - start.y) / Math.hypot(tiny.x, tiny.z)).closeTo(
        Math.tan((85 * Math.PI) / 180),
        0.001
      )
      expect(arcHandle(arc).y).greaterThan(start.y)
    }
  })
  it('keeps steep short and zero-distance arcs finite with exact endpoints', function () {
    for (const distance of [0, 3, 8, 140]) {
      const arc = { target: { x: 0, z: -distance }, angle: 85 }
      expect(arcPoint(arc, 0)).deep.equals({ x: 0, y: BALL_CONTACT, z: 0 })
      expect(arcPoint(arc, 1)).deep.equals({
        x: 0,
        y: BALL_GROUND,
        z: -distance
      })
      for (let i = 0; i <= 100; i++)
        expect(
          Object.values(arcPoint(arc, i / 100)).every(Number.isFinite)
        ).equals(true)
      expect(Object.values(arcHandle(arc)).every(Number.isFinite)).equals(true)
      if (distance === 3) {
        expect(arcHandle(arc).y - BALL_GROUND).greaterThan(14)
        expect(arcHandle(arc).y).greaterThan(15)
        expect(arcHandle(arc).y).greaterThan(arcHandle({ ...arc, angle: 70 }).y)
      }
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
