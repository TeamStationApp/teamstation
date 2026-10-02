import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { Box3, Mesh, MeshBasicMaterial } from 'three'

import {
  clonePlayers,
  createStartingPlayers,
  startBatterRun
} from './batterModel'
import { advancePlayer, BASES } from './fieldModel'
import { Player } from './Player'
import { TERRAIN } from './terrain'

describe('starting batter and bat release', function () {
  it('starts with empty bases and restores the batting pose from an independent undo snapshot', function () {
    const players = createStartingPlayers()
    expect(players.filter(p => p.team === 'defense')).length(9)
    expect(players.filter(p => p.team === 'runner')).length(1)
    const batter = players[9]
    expect(batter.batting).equals(true)
    expect(batter.position.x).lessThan(0)
    expect(batter.runnerBase).equals(0)
    const saved = clonePlayers(players)
    const running = startBatterRun(players)[9]
    expect(running.batting).equals(false)
    expect(running.target).deep.equals(BASES[1])
    expect(running.droppedBat).not.equals(undefined)
    for (let i = 0; i < 600; i++) advancePlayer(running, 1 / 60)
    expect(running.position).deep.equals(BASES[1])
    expect(running.runnerBase).equals(1)
    expect(saved[9].batting).equals(true)
    expect(saved[9].droppedBat).equals(undefined)
    expect(saved[9].position).deep.equals({ x: -4, z: 0 })
  })
  it('exchanges the held bat for a falling bat while the batter runs to first', async function () {
    const players = createStartingPlayers()
    const renderer = await create(
      React.createElement(Player, { player: players[9], selected: false })
    )
    try {
      expect(renderer.scene.findAllByProps({ name: 'held-bat' })).length(1)
      const runner = startBatterRun(players)[9]
      await renderer.update(
        React.createElement(Player, { player: runner, selected: false })
      )
      expect(renderer.scene.findAllByProps({ name: 'held-bat' })).length(0)
      const bat = renderer.scene.findByProps({ name: 'dropped-bat' }).instance
      await renderer.advanceFrames(50, 1 / 60)
      expect(bat.position.y).closeTo(TERRAIN.players + 0.55, 0.001)
      expect(runner.position.x).greaterThan(-4)
      await renderer.advanceFrames(600, 1 / 60)
      expect(runner.position).deep.equals(BASES[1])
      await renderer.update(
        React.createElement(Player, {
          player: createStartingPlayers()[9],
          selected: false
        })
      )
      expect(renderer.scene.findAllByProps({ name: 'dropped-bat' })).length(0)
      expect(renderer.scene.findAllByProps({ name: 'held-bat' })).length(1)
    } finally {
      await renderer.unmount()
    }
  })
  it('keeps both number planes outside the full jersey depth, with depth bias enabled', async function () {
    const renderer = await create(
      React.createElement(Player, {
        player: createStartingPlayers()[0],
        selected: false
      })
    )
    try {
      renderer.scene.instance.updateMatrixWorld(true)
      const torso = new Box3().setFromObject(
        renderer.scene.findByProps({ name: 'jersey-torso' }).instance
      )
      for (const item of renderer.scene.findAllByProps({
        name: 'jersey-number'
      })) {
        const number = item.instance
        if (
          !(number instanceof Mesh) ||
          !(number.material instanceof MeshBasicMaterial)
        )
          throw new Error('Missing number material')
        const box = new Box3().setFromObject(number)
        const gap = Math.max(box.min.z - torso.max.z, torso.min.z - box.max.z)
        expect(gap).greaterThan(0.15)
        expect(number.material.polygonOffset).equals(true)
        expect(number.material.polygonOffsetFactor).lessThan(0)
        expect(number.material.depthTest).equals(true)
      }
    } finally {
      await renderer.unmount()
    }
  })
})
