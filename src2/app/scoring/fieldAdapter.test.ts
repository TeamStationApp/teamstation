import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { Ray, Vector2, Vector3 } from 'three'

import { asRosterEntry } from '../../common/api'
import { FieldScene } from '../field/FieldScene'
import { Player } from '../field/Player'
import { hasPlayerLabel } from '../field/playerPresentation'
import { createDevelopmentSession } from './developmentSession'
import { fieldPlayersFor } from './fieldAdapter'
import { gameFixture } from './isUnscoredGame.test'

const roster = [
  asRosterEntry({
    userId: 'player',
    shortName: 'Casey M.',
    jersey: '00',
    positions: [],
    isPlayer: true,
    role: 'member',
    bats: 'left'
  })
]
describe('scoring renderer identities', function () {
  it('renders a mirrored left-handed batter with a name and string jersey and omits missing jersey meshes', async function () {
    const session = createDevelopmentSession(gameFixture, roster, [])
    const player = fieldPlayersFor(session).find(
      player => player.batting === true
    )
    if (player == null) throw new Error('Missing batter')
    expect(hasPlayerLabel(player)).equals(true)
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
      ).has.length(1)
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
    const session = createDevelopmentSession(gameFixture, roster, [])
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
        ray: new Ray(new Vector3(-4, 100, 0), new Vector3(0, -1, 0)),
        target: { setPointerCapture() {}, releasePointerCapture() {} }
      }
      await renderer.fireEvent(surface, 'pointerDown', event)
      await renderer.fireEvent(surface, 'pointerCancel', event)
      expect(placements).has.length(0)
      await renderer.fireEvent(surface, 'pointerDown', event)
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
