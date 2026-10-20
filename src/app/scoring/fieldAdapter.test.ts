import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import {
  type BufferGeometry,
  type Mesh,
  type MeshStandardMaterial,
  Ray,
  Vector2,
  Vector3
} from 'three'

import { asRosterEntry } from '../../common/api'
import { userIdOfGumbo } from '../../common/userId'
import { scoringRoster } from '../../test/scoringSession'
import { pitchingPose } from '../field/athletePose'
import { FieldScene } from '../field/FieldScene'
import type { FieldCanvasProps } from '../field/fieldTypes'
import { Player } from '../field/Player'
import { hasPlayerLabel, PLAYER_SCALE } from '../field/playerPresentation'
import { createDevelopmentSession } from './developmentSession'
import { fieldPlayersFor } from './fieldAdapter'
import { gameFixture } from './isUnscoredGame.test'

const roster = [
  asRosterEntry({
    userId: userIdOfGumbo(103),
    gumboId: 103,
    shortName: 'Casey M.',
    jersey: '00',
    positions: [],
    isPlayer: true,
    role: 'member',
    section: 'player',
    staffRoles: [],
    inheritedFrom: null,
    bats: 'left'
  })
]
describe('scoring renderer identities', function () {
  it('renders a mirrored left-handed batter with a string jersey and no field name', async function () {
    const session = createDevelopmentSession(
      gameFixture,
      roster,
      scoringRoster(10)
    )
    const player = fieldPlayersFor(session).find(
      player => player.batting === true
    )
    if (player == null) throw new Error('Missing batter')
    expect(hasPlayerLabel(player)).equals(false)
    expect(player.position.x).equals(4)
    const rendered = await create(
      React.createElement(Player, { player, selected: true })
    )
    try {
      expect(
        rendered.scene.findAllByProps({ name: 'jersey-number' })
      ).has.length(2)
      expect(
        rendered.scene.findAllByProps({ name: `player-label-${player.id}` })
      ).has.length(0)
      player.jersey = ''
      await rendered.update(
        React.createElement(Player, { player, selected: false })
      )
      expect(
        rendered.scene.findAllByProps({ name: 'jersey-number' })
      ).has.length(0)
      await rendered.advanceFrames(2, 1 / 60)
    } finally {
      await rendered.unmount()
    }
  })
  it('reports accepted switch-box placement, never accepts a cancellation, and rejects locked fallback selection', async function () {
    const session = createDevelopmentSession(
      gameFixture,
      roster,
      scoringRoster(10)
    )
    const original = JSON.stringify(session)
    const players = fieldPlayersFor(session)
    const batter = players.find(player => player.batting === true)
    if (batter == null) throw new Error('Missing batter')
    const placements: string[] = []
    const props = {
      players,
      selected: batter.id,
      selectableIds: [batter.id],
      onSelect: () => undefined,
      onPlayerPlacement: (id: string) => {
        placements.push(id)
      },
      view: 'home' as const,
      zoom: 1
    }
    const renderer = await create(React.createElement(FieldScene, props))
    try {
      await renderer.advanceFrames(1, 1 / 60)
      const surface = renderer.scene.findByProps({
        name: 'interaction-surface'
      })
      const event = {
        button: 0,
        pointerId: 1,
        pointer: new Vector2(2, 2),
        ray: new Ray(new Vector3(4, 100, 0), new Vector3(0, -1, 0)),
        target: { setPointerCapture() {}, releasePointerCapture() {} }
      }
      await renderer.fireEvent(surface, 'pointerDown', event)
      await renderer.fireEvent(surface, 'pointerCancel', event)
      expect(placements).has.length(0)
      await renderer.fireEvent(surface, 'pointerDown', event)
      event.ray.origin.x = -4
      await renderer.fireEvent(surface, 'pointerMove', event)
      await renderer.fireEvent(surface, 'pointerUp', event)
      expect(placements).deep.equals([batter.id])
      await renderer.update(
        React.createElement(FieldScene, { ...props, selectableIds: [] })
      )
      await renderer.fireEvent(surface, 'pointerDown', event)
      await renderer.fireEvent(surface, 'pointerUp', event)
      expect(placements).has.length(1)
      expect(JSON.stringify(session)).equals(original)
    } finally {
      await renderer.unmount()
    }
  })
})

describe('a player on the field', function () {
  it('moves without drawing his body again, and draws it again when it changes', async function () {
    const player = fieldPlayersFor(
      createDevelopmentSession(gameFixture, roster, scoringRoster(10))
    ).find(item => item.team === 'defense')!
    const renderer = await create(
      React.createElement(Player, { player, selected: false })
    )
    try {
      const root = (): { props: Record<string, unknown>; instance: unknown } =>
        renderer.scene.findByProps({ name: `player-${player.id}` })
      const start = root().props.position
      // A new player, as the screen hands over on every change, somewhere
      // else: he stands there, but his body is not drawn again.
      const moved = {
        ...player,
        position: { x: player.position.x + 7, z: player.position.z - 3 },
        target: { x: player.position.x + 7, z: player.position.z - 3 }
      }
      await renderer.update(
        React.createElement(Player, { player: moved, selected: false })
      )
      expect(root().props.position).equals(start)
      const at = (root().instance as { position: Vector3 }).position
      expect([at.x, at.z]).deep.equals([moved.position.x, moved.position.z])
      // The same place again moves nothing.
      await renderer.update(
        React.createElement(Player, {
          player: { ...moved, position: { ...moved.position } },
          selected: false
        })
      )
      expect(root().props.position).equals(start)
      // His pose is read from the newest player each frame.
      const posed = {
        ...moved,
        pose: {
          athlete: pitchingPose(0.3, 0.6, 'R'),
          windup: 0,
          swing: 0,
          catch: 0,
          throwSide: 'R' as const
        }
      }
      await renderer.update(
        React.createElement(Player, { player: posed, selected: false })
      )
      await renderer.advanceFrames(1, 1 / 60)
      expect(
        (
          renderer.scene.findByProps({ name: 'athlete-rig' }).instance as {
            visible: boolean
          }
        ).visible
      ).equals(true)
      // What he is made of changes: the ball in his glove is drawn.
      expect(
        renderer.scene.findAllByProps({ name: 'possession-ball' })
      ).has.length(0)
      await renderer.update(
        React.createElement(Player, {
          player: { ...posed, hasBall: true },
          selected: false
        })
      )
      expect(
        renderer.scene.findAllByProps({ name: 'possession-ball' })
      ).has.length(1)
      // Drawn again, from where he stands now.
      expect(root().props.position).deep.equals([
        moved.position.x,
        at.y,
        moved.position.z
      ])
    } finally {
      await renderer.unmount()
    }
  })
})

describe('scoring field policy', function () {
  it('removes offensive labels and keeps full height at half opacity during defensive selection', async function () {
    const player = fieldPlayersFor(
      createDevelopmentSession(gameFixture, roster, scoringRoster(10))
    ).find(item => item.batting === true)!
    const renderer = await create(
      React.createElement(Player, {
        player: { ...player, suppressed: true },
        selected: false
      })
    )
    try {
      expect(
        renderer.scene.findAllByProps({ name: `player-label-${player.id}` })
      ).has.length(0)
      expect(
        renderer.scene.findAllByProps({ name: 'jersey-number' })
      ).has.length(0)
      const torso = renderer.scene.findByProps({ name: 'jersey-torso' })
      expect(torso.parent!.props.scale).deep.equals([
        PLAYER_SCALE,
        PLAYER_SCALE,
        PLAYER_SCALE
      ])
      expect(
        (torso.instance as Mesh<BufferGeometry, MeshStandardMaterial>).material
          .opacity
      ).equals(0.5)
      await renderer.update(
        React.createElement(Player, { player, selected: false })
      )
      expect(
        renderer.scene.findAllByProps({ name: `player-label-${player.id}` })
      ).has.length(0)
    } finally {
      await renderer.unmount()
    }
  })
  it('cancels an arc without acceptance and ignores a stale pointer after policy replacement', async function () {
    const players = fieldPlayersFor(
      createDevelopmentSession(gameFixture, roster, scoringRoster(10))
    )
    let accepted = 0
    let previews = 0
    let lastPreview = 45
    let lastAccepted = 45
    const host = { cancel: null as (() => void) | null }
    const props: FieldCanvasProps = {
      players,
      registerInterruption: cancel => {
        host.cancel = cancel
      },
      selected: players[0].id,
      onSelect: () => undefined,
      view: 'home',
      zoom: 1,
      interaction: {
        generation: 2,
        selectableIds: [players[0].id],
        gestures: ['trajectory']
      },
      arcMode: 'edit',
      arc: { target: { x: 10, z: -30 }, angle: 45 },
      onArcChange: arc => {
        lastPreview = arc.angle
        previews++
      },
      onTrajectoryAccepted: angle => {
        lastAccepted = angle
        accepted++
      }
    }
    const renderer = await create(React.createElement(FieldScene, props))
    try {
      const surface = renderer.scene.findByProps({
        name: 'arc-interaction-surface'
      })
      const event = {
        button: 0,
        pointerId: 1,
        pointer: new Vector2(0, 0),
        ray: new Ray(new Vector3(0, 100, 0), new Vector3(0, -1, 0)),
        target: { setPointerCapture() {}, releasePointerCapture() {} }
      }
      await renderer.fireEvent(surface, 'pointerDown', event)
      await renderer.fireEvent(surface, 'pointerMove', {
        ...event,
        pointer: new Vector2(0, 0.3)
      })
      await renderer.fireEvent(surface, 'pointerCancel', event)
      expect(accepted).equals(0)
      expect(previews).equals(2)
      await renderer.fireEvent(surface, 'pointerDown', event)
      await renderer.fireEvent(surface, 'lostPointerCapture', event)
      expect(accepted).equals(0)
      await renderer.fireEvent(surface, 'pointerDown', event)
      await renderer.update(
        React.createElement(FieldScene, {
          ...props,
          interaction: { ...props.interaction!, generation: 3 }
        })
      )
      await renderer.fireEvent(surface, 'pointerUp', event)
      expect(accepted).equals(0)
      await renderer.fireEvent(surface, 'pointerDown', event)
      await renderer.fireEvent(surface, 'pointerMove', {
        ...event,
        pointer: new Vector2(0, -0.3)
      })
      await renderer.fireEvent(surface, 'pointerUp', event)
      expect(accepted).equals(1)
      expect(lastAccepted).equals(lastPreview)
      expect(lastAccepted).not.equals(45)
      await renderer.fireEvent(surface, 'pointerDown', event)
      host.cancel?.()
      await renderer.fireEvent(surface, 'pointerUp', event)
      expect(accepted).equals(1)
    } finally {
      await renderer.unmount()
    }
  })
})
