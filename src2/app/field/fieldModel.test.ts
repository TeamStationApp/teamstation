import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  advancePlayer,
  BASES,
  clampToField,
  createPlayers,
  nextBase,
  setDestination
} from './fieldModel'

describe('field locomotion', function () {
  it('creates nine defenders and three independently movable runners', function () {
    const players = createPlayers()
    expect(players.filter(player => player.team === 'defense')).length(9)
    expect(players.filter(player => player.team === 'runner')).length(3)
    setDestination(players[0], { x: 10, z: -30 })
    expect(players[1].target).deep.equals({ x: 0, z: 4 })
    expect(createPlayers()[0].target).deep.equals({ x: 0, z: -18.44 })
  })
  it('arrives without overshooting and stops animating', function () {
    const player = createPlayers()[0]
    setDestination(player, { x: 20, z: -60 })
    for (let i = 0; i < 1200; i++) {
      advancePlayer(player, 1 / 60)
      expect(player.position.x).within(0, 20)
      expect(player.position.z).within(-60, -18.44)
    }
    expect(player.position).deep.equals(player.target)
    expect(player.speed).equals(0)
    expect(player.stride).greaterThan(0)
  })
  it('moves consistently at different refresh rates', function () {
    const a = createPlayers()[0]
    const b = createPlayers()[0]
    setDestination(a, { x: 30, z: -85 })
    setDestination(b, { x: 30, z: -85 })
    for (let i = 0; i < 60; i++) advancePlayer(a, 1 / 60)
    for (let i = 0; i < 120; i++) advancePlayer(b, 1 / 120)
    expect(
      Math.hypot(a.position.x - b.position.x, a.position.z - b.position.z)
    ).lessThan(0.02)
  })
  it('caps a resumed frame and bounds off-field pointer destinations', function () {
    const player = createPlayers()[0]
    setDestination(player, { x: 10000, z: -10000 })
    expect(Math.hypot(player.target.x, player.target.z)).at.most(110.00001)
    advancePlayer(player, 30)
    expect(Math.hypot(player.position.x, player.position.z + 18.44)).at.most(
      0.86
    )
    expect(clampToField({ x: NaN, z: Infinity })).deep.equals({ x: 0, z: 0 })
  })
  it('advances runners through first, second, third, home, and first again', function () {
    const runner = createPlayers()[9]
    for (const index of [2, 3, 0, 1]) {
      setDestination(runner, nextBase(runner))
      expect(runner.target).deep.equals(BASES[index])
    }
  })
})
