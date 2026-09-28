import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { PerspectiveCamera, Scene, Vector3 } from 'three'

import { applyFieldCamera } from './cameraModel'
import { createPlayers } from './fieldModel'
import { nameplateColor } from './fieldNameplates'
import { FieldScene } from './FieldScene'
import {
  hasPlayerLabel,
  HEAD_RADIUS,
  LABEL_GAP,
  labelAnchor,
  NAMEPLATE_FONT,
  NAMEPLATE_LINE_GAP,
  NAMEPLATE_NUMBER_FONT,
  NAMEPLATE_PAD,
  nameplateLabel,
  PLAYER_SCALE,
  projectPlayerLabel
} from './playerPresentation'
import { battingLine, DEMO_SCOREBOARD } from './scoreboardModel'
import { makeScoreboardPixels } from './scoreboardTexture'

describe('responsive field readability', function () {
  it('colors a nameplate with the uniform', function () {
    expect(nameplateColor({ team: 'runner', uniformSide: 'away' })).equals(
      'rgba(16, 40, 72, 0.94)'
    )
    expect(nameplateColor({ team: 'defense', uniformSide: 'home' })).equals(
      'rgba(122, 48, 16, 0.94)'
    )
    expect(nameplateColor({ team: 'defense' })).equals('rgba(16, 40, 72, 0.94)')
    expect(nameplateColor({ team: 'runner' })).equals('rgba(122, 48, 16, 0.94)')
  })
  it('puts a jersey under the name and leaves a blank jersey unnamed', function () {
    const first = createPlayers().find(player => player.id === '1B')
    if (first == null) throw new Error('Missing first baseman')
    expect(nameplateLabel(first)).deep.equals({
      name: 'Liam B.',
      number: '#24'
    })
    expect(nameplateLabel({ ...first, jersey: '' })).deep.equals({
      name: 'Liam B.',
      number: ''
    })
    expect(nameplateLabel({ ...first, jersey: '  ' })).deep.equals({
      name: 'Liam B.',
      number: ''
    })
  })
  it('projects nameplates to a constant CSS size after the camera transform', function () {
    const camera = new PerspectiveCamera()
    for (const [width, height] of [
      [220, 1100],
      [320, 900],
      [390, 556],
      [1440, 798]
    ]) {
      applyFieldCamera(camera, { width, height, view: 'home', zoom: 1 })
      for (const player of createPlayers().filter(hasPlayerLabel)) {
        const plate = projectPlayerLabel(player, camera, width, height)
        const anchor = labelAnchor(player, camera)
        const number =
          player.jersey.trim() === ''
            ? 0
            : NAMEPLATE_LINE_GAP + NAMEPLATE_NUMBER_FONT
        expect(plate.height).equals(NAMEPLATE_FONT + number + NAMEPLATE_PAD * 2)
        expect(plate.visible).equals(true)
        expect(plate.x).within(0, width)
        expect(plate.y).within(0, height)
        if (player.id === 'C' || player.team === 'runner') {
          expect(plate.anchorX).equals(0.5)
          expect(plate.anchorY).equals(0)
          expect(anchor.offset.length()).closeTo(LABEL_GAP, 0.00001)
        } else if (player.id === '3B' || player.id === '1B') {
          const growRight = player.id === '1B'
          expect(plate.anchorX).equals(growRight ? 0 : 1)
          expect(plate.anchorY).equals(1)
          const right = new Vector3(1, 0, 0).applyQuaternion(camera.quaternion)
          const up = new Vector3(0, 1, 0).applyQuaternion(camera.quaternion)
          const expected = up.clone().multiplyScalar(LABEL_GAP)
          expected.y += 2.9 * PLAYER_SCALE + 0.13
          expected.addScaledVector(
            right,
            (growRight ? -1 : 1) * HEAD_RADIUS * PLAYER_SCALE
          )
          expect(anchor.offset.distanceTo(expected)).closeTo(0, 0.00001)
        } else {
          expect(plate.anchorX).equals(0.5)
          expect(plate.anchorY).equals(1)
          const head = new Vector3(0, 2.9 * PLAYER_SCALE + 0.13, 0)
          expect(anchor.offset.distanceTo(head)).closeTo(LABEL_GAP, 0.00001)
        }
      }
    }
  })
  it('has no scene fog at a tall desktop aspect ratio and names fielders and runners', async function () {
    const renderer = await create(
      React.createElement(FieldScene, {
        players: createPlayers(),
        selected: 'SS',
        onSelect: () => undefined,
        view: 'home',
        zoom: 0.7
      }),
      { width: 220, height: 1100 }
    )
    try {
      const scene = renderer.scene.instance
      if (!(scene instanceof Scene)) throw new Error('Expected a scene')
      expect(scene.fog).equals(null)
      const labels = renderer.scene.findAll(
        node =>
          typeof node.props.name === 'string' &&
          node.props.name.startsWith('player-label-')
      )
      expect(labels.length).equals(0)
      const named = createPlayers().filter(hasPlayerLabel)
      expect(named.length).equals(11)
      expect(named.some(player => player.id === 'P')).equals(false)
      for (const id of ['R1', 'R2', 'R3', 'SS'])
        expect(named.some(player => player.id === id)).equals(true)
      expect(
        renderer.scene.findAllByProps({ name: 'jersey-number' }).length
      ).equals(24)
    } finally {
      await renderer.unmount()
    }
  })
  it('keeps the whole scoreboard within the far plane at extreme narrow widths', function () {
    const camera = new PerspectiveCamera()
    applyFieldCamera(camera, {
      width: 180,
      height: 1100,
      view: 'home',
      zoom: 0.7
    })
    for (const x of [-63, 63])
      for (const y of [11.5, 46.5]) {
        const point = new Vector3(x, y, -135).project(camera)
        expect(point.z).within(-1, 1)
      }
  })
  it('shows hits-at-bats and both names on the compact board', function () {
    expect(battingLine(DEMO_SCOREBOARD)).equals('1-3')
    expect(
      battingLine({
        ...DEMO_SCOREBOARD,
        batterHits: undefined,
        batterAtBats: undefined
      })
    ).equals('0-0')
    const pixels = makeScoreboardPixels(DEMO_SCOREBOARD)
    const renamed = makeScoreboardPixels({
      ...DEMO_SCOREBOARD,
      batter: { firstName: 'Other', lastName: 'Name' },
      pitcher: { firstName: 'Changed', lastName: 'Name' }
    })
    expect(
      Buffer.compare(Buffer.from(pixels), Buffer.from(renamed))
    ).not.equals(0)
    const changedStats = makeScoreboardPixels({
      ...DEMO_SCOREBOARD,
      batterHits: 2
    })
    expect(
      Buffer.compare(Buffer.from(pixels), Buffer.from(changedStats))
    ).not.equals(0)
  })
})
