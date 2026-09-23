import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { type Camera, Ray, Sprite, Vector2, Vector3 } from 'three'

import type { BallArcState } from './ballArcModel'
import { fieldingLocation } from './fieldingLocation'
import { createPlayers } from './fieldModel'
import { FieldScene } from './FieldScene'
import type { FieldPlacement } from './fieldTypes'
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
      expect(player.target.z).closeTo(-53.048, 0.001)
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
        expect(arc.target.z).closeTo(
          pointerType === 'touch' ? -53.048 : -50,
          0.001
        )
      }
    } finally {
      await renderer.unmount()
    }
  })
})

describe('scoring home-run landing surface', function () {
  it('previews both sides of the visible fence and commits an elevated stands landing while the defender stays in bounds', async function () {
    const players = createPlayers()
    let placement: FieldPlacement | undefined
    const previews: number[] = []
    const renderer = await create(
      React.createElement(FieldScene, {
        players,
        selected: '',
        onSelect: () => undefined,
        view: 'home',
        zoom: 1,
        homeRunPlacement: true,
        onLandingPreview: point => {
          if (point != null) previews.push(point.z)
        },
        onFieldPlacement: value => {
          placement = value
        }
      })
    )
    try {
      await renderer.advanceFrames(1, 1 / 60)
      renderer.scene.instance.updateMatrixWorld(true)
      const surface = renderer.scene.findByProps({
        name: 'interaction-surface'
      })
      const event = {
        button: 0,
        pointerId: 44,
        pointerType: 'mouse',
        pointer: new Vector2(0, 0),
        ray: new Ray(new Vector3(0, 100, -18.44), new Vector3(0, -1, 0)),
        target: {
          setPointerCapture: () => undefined,
          releasePointerCapture: () => undefined
        }
      }
      await renderer.fireEvent(surface, 'pointerDown', event)
      event.ray.origin.z = -116
      await renderer.fireEvent(surface, 'pointerMove', event)
      event.ray.origin.z = -127
      await renderer.fireEvent(surface, 'pointerMove', event)
      await renderer.fireEvent(surface, 'pointerUp', event)
      expect(previews).includes(-116)
      expect(previews).includes(-127)
      expect(placement!.point.z).equals(-127)
      expect(placement!.landingHeight).greaterThan(1)
      expect(Math.hypot(players[0].target.x, players[0].target.z)).at.most(
        110.00001
      )
    } finally {
      await renderer.unmount()
    }
  })
})

describe('direct home-run landing authoring', function () {
  for (const pointerType of ['mouse', 'touch'])
    it(`moves the target relatively from an arbitrary ${pointerType} origin and cancels safely`, async function () {
      const players = createPlayers()
      const before = players.map(p => ({ ...p.position }))
      const initial: BallArcState = { target: { x: 0, z: -60 }, angle: 45 }
      let preview = initial
      let camera: Camera | undefined
      const accepted: BallArcState[] = []
      const props = {
        players,
        selected: '',
        onSelect: () => undefined,
        view: 'home' as const,
        zoom: 1,
        homeRunPlacement: true,
        arc: initial,
        arcMode: 'aim' as const,
        interaction: {
          generation: 17,
          selectableIds: [],
          gestures: ['trajectory' as const]
        },
        onArcChange: (arc: BallArcState) => {
          preview = arc
        },
        onLandingAccepted: (arc: BallArcState, generation: number) => {
          expect(generation).equals(17)
          accepted.push(arc)
        }
      }
      const renderer = await create(React.createElement(FieldScene, props), {
        width: 900,
        height: 650,
        onCreated: state => {
          camera = state.camera
        }
      })
      try {
        await renderer.advanceFrames(1, 1 / 60)
        renderer.scene.instance.updateMatrixWorld(true)
        const surface = renderer.scene.findByProps({
          name: 'arc-interaction-surface'
        })
        const event = {
          button: 0,
          pointerId: 45,
          pointerType,
          // Finger starts above the horizon; its own ray has no ground hit.
          pointer: new Vector2(-0.7, 0.8),
          ray: new Ray(new Vector3(0, 100, 0), new Vector3(0, 1, 0)),
          target: {
            setPointerCapture: () => undefined,
            releasePointerCapture: () => undefined
          }
        }
        await renderer.fireEvent(surface, 'pointerDown', event)
        expect(preview).deep.equals(initial)
        await renderer.fireEvent(surface, 'pointerUp', event)
        expect(accepted).length(0)
        const start = event.pointer.clone()
        const projectedInitial = new Vector3(0, TERRAIN.players, -60).project(
          camera!
        )
        const desired = new Vector3(0, 8, -133).project(camera!)
        const move = async (): Promise<void> => {
          event.pointer.copy(start)
          await renderer.fireEvent(surface, 'pointerDown', event)
          event.pointer.set(
            start.x + desired.x - projectedInitial.x,
            start.y + desired.y - projectedInitial.y
          )
          await renderer.fireEvent(surface, 'pointerMove', event)
          expect(preview.target.z).lessThan(-120)
          expect(preview.landingHeight).greaterThan(1)
        }
        await move()
        await renderer.fireEvent(surface, 'pointerCancel', event)
        expect(preview).deep.equals(initial)
        expect(accepted).length(0)
        await move()
        const last = preview
        const finalPointer = event.pointer.clone()
        event.pointer.set(100, 100)
        await renderer.fireEvent(surface, 'pointerMove', event)
        expect(preview).deep.equals(last)
        event.pointer.copy(finalPointer)
        await renderer.fireEvent(surface, 'pointerUp', event)
        expect(accepted).length(1)
        expect(players.map(p => p.position)).deep.equals(before)
        await move()
        await renderer.update(
          React.createElement(FieldScene, {
            ...props,
            interaction: { ...props.interaction, generation: 18 }
          })
        )
        expect(preview).deep.equals(initial)
        await renderer.fireEvent(surface, 'pointerUp', event)
        expect(accepted).length(1)
      } finally {
        await renderer.unmount()
      }
    })
})

describe('outcome-constrained defender gestures', function () {
  it('accepts a direct defender tap, restores its position and clamps the visible drag and released location to fair territory', async function () {
    const players = createPlayers()
    const placements: FieldPlacement[] = []
    const renderer = await create(
      React.createElement(FieldScene, {
        players,
        selected: '',
        onSelect: () => undefined,
        view: 'home',
        zoom: 1,
        acceptDefenderTap: true,
        deferDefenderPlacement: true,
        constrainPlacement: point => fieldingLocation('Single', point),
        interaction: {
          generation: 4,
          selectableIds: [players[0].id],
          gestures: ['place']
        },
        onFieldPlacement: value => {
          placements.push(value)
        }
      })
    )
    try {
      await renderer.advanceFrames(1, 1 / 60)
      const surface = renderer.scene.findByProps({
        name: 'interaction-surface'
      })
      const event = {
        button: 0,
        pointerId: 46,
        pointerType: 'mouse',
        pointer: new Vector2(0, 0),
        ray: new Ray(new Vector3(0, 100, -18.44), new Vector3(0, -1, 0)),
        target: {
          setPointerCapture: () => undefined,
          releasePointerCapture: () => undefined
        }
      }
      await renderer.fireEvent(surface, 'pointerDown', event)
      await renderer.fireEvent(surface, 'pointerUp', event)
      expect(placements).length(1)
      expect(placements[0].point).deep.equals({ x: 0, z: -18.44 })
      await renderer.fireEvent(surface, 'pointerDown', event)
      event.ray.origin.set(80, 100, -20)
      await renderer.fireEvent(surface, 'pointerMove', event)
      const guide = renderer.scene.findByProps({ name: 'move-preview' })
      expect(guide).not.equals(undefined)
      await renderer.fireEvent(surface, 'pointerUp', event)
      expect(placements).length(2)
      expect(placements[1].point).deep.equals({ x: 20, z: -20 })
      expect(placements[1].generation).equals(4)
      expect(players[0].position).deep.equals({ x: 0, z: -18.44 })
      expect(players[0].target).deep.equals(players[0].position)
      await renderer.advanceFrames(20, 1 / 60)
      expect(players[0].position).deep.equals({ x: 0, z: -18.44 })
    } finally {
      await renderer.unmount()
    }
  })
})
