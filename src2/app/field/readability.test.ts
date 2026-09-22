import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { PerspectiveCamera, Scene, Sprite, Vector3 } from 'three'

import { applyFieldCamera } from './cameraModel'
import { createPlayers } from './fieldModel'
import { FieldScene } from './FieldScene'
import {
  hasPlayerLabel,
  LABEL_GAP,
  placePlayerLabel,
  PLAYER_SCALE
} from './playerPresentation'
import { battingLine, DEMO_SCOREBOARD } from './scoreboardModel'
import { makeScoreboardPixels } from './scoreboardTexture'

describe('responsive field readability', function () {
  it('keeps labels half size in pixels across narrow desktop, phone and wide layouts', function () {
    const label = new Sprite()
    const camera = new PerspectiveCamera()
    for (const [width, height] of [
      [220, 1100],
      [320, 900],
      [390, 556],
      [1440, 798]
    ]) {
      applyFieldCamera(camera, { width, height, view: 'home', zoom: 1 })
      for (const player of createPlayers().filter(hasPlayerLabel)) {
        placePlayerLabel(label, player, camera, height)
        const depth = -label.position
          .clone()
          .add(new Vector3(player.position.x, 0.7, player.position.z))
          .applyMatrix4(camera.matrixWorldInverse).z
        const pixelsPerMetre =
          height / (2 * depth * Math.tan((camera.fov * Math.PI) / 360))
        expect(label.scale.x * pixelsPerMetre).closeTo(56, 0.00001)
        expect(label.scale.y * pixelsPerMetre).closeTo(14, 0.00001)
        if (player.id === 'C') expect(label.center.y).equals(1)
        else if (player.id === '3B') expect(label.center.x).equals(1)
        else if (player.id === '1B') expect(label.center.x).equals(0)
        else {
          expect(label.center.y).equals(0)
          const head = new Vector3(0, 2.9 * PLAYER_SCALE + 0.13, 0)
          expect(label.position.distanceTo(head)).closeTo(LABEL_GAP, 0.00001)
        }
      }
    }
    label.material.dispose()
  })
  it('has no scene fog at a tall desktop aspect ratio and only eight field nameplates', async function () {
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
      expect(labels.length).equals(8)
      for (const id of ['P', 'R1', 'R2', 'R3'])
        expect(
          labels.some(node => node.props.name === `player-label-${id}`)
        ).equals(false)
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
      for (const y of [18, 83]) {
        const point = new Vector3(x, y, -158).project(camera)
        expect(point.z).within(-1, 1)
      }
  })
  it('shows hits-at-bats with names hidden by default, but retains opt-in names', function () {
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
    expect(Buffer.compare(Buffer.from(pixels), Buffer.from(renamed))).equals(0)
    const visibleNames = makeScoreboardPixels({
      ...DEMO_SCOREBOARD,
      showPlayerNames: true
    })
    expect(
      Buffer.compare(Buffer.from(pixels), Buffer.from(visibleNames))
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
