import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  advancePlayer,
  BASES,
  clampToField,
  createPlayers,
  locomotionSpeed,
  nextBase,
  setDestination
} from './fieldModel'
import { PLAYER_SCALE } from './playerPresentation'

describe('field locomotion', function () {
  it('creates nine defenders and three independently movable runners', function () {
    const players = createPlayers()
    expect(players.filter(player => player.team === 'defense')).length(9)
    expect(players.filter(player => player.team === 'runner')).length(3)
    setDestination(players[0], { x: 10, z: -30 })
    expect(players[1].target).deep.equals({ x: 0, z: 4 })
    expect(createPlayers()[0].target).deep.equals({ x: 0, z: -18.44 })
  })
  it('stands short and second on the dirt edge and the corners behind the bags', function () {
    expect(PLAYER_SCALE).equals(3.2 * 1.15)
    const byId = Object.fromEntries(
      createPlayers().map(player => [player.id, player.position])
    )
    const bag = BASES[2]
    const shoulder = 1.12 * PLAYER_SCALE
    const from = { x: 15, z: -41 }
    const dx = bag.x - from.x
    const dz = bag.z - from.z
    const length = Math.hypot(dx, dz)
    const x = from.x + (dx / length) * shoulder
    expect(byId['2B'].x).closeTo(x, 1e-9)
    expect(byId['2B'].z).closeTo(-Math.sqrt(47.5 ** 2 - x * x), 1e-9)
    expect(byId.SS.x).closeTo(-byId['2B'].x, 1e-9)
    expect(byId.SS.z).closeTo(byId['2B'].z, 1e-9)
    expect(Math.hypot(byId['2B'].x, byId['2B'].z)).closeTo(47.5, 1e-9)
    expect(Math.hypot(byId['2B'].x - bag.x, byId['2B'].z - bag.z)).lessThan(
      Math.hypot(from.x - bag.x, from.z - bag.z)
    )
    expect(byId['1B'].x).closeTo(24.17, 1e-9)
    expect(byId['1B'].z).closeTo(-40.91, 1e-9)
    expect(byId['3B'].x).closeTo(-24.72, 1e-9)
    expect(byId['3B'].z).closeTo(-40.12, 1e-9)
  })
  it('doubles normal offense while out approaches retain the slower pace', () => {
    for (const distance of [0.5, 5, 40]) {
      const prior = 1.4 * Math.min(17, 4 + distance * 1.1)
      expect(locomotionSpeed(distance, false)).equals(prior)
      expect(locomotionSpeed(distance, true)).equals(prior * 2)
      expect(locomotionSpeed(distance, true, true)).equals(prior)
    }
    const runner = {
      ...createPlayers()[9],
      position: { x: 0, z: 0 },
      target: { x: 50, z: 0 }
    }
    const slow = {
      ...runner,
      position: { ...runner.position },
      slowApproach: true
    }
    advancePlayer(runner, 0.05)
    advancePlayer(slow, 0.05)
    expect(runner.position.x).closeTo(slow.position.x * 2, 1e-10)
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
      1.2
    )
    expect(clampToField({ x: NaN, z: Infinity })).deep.equals({ x: 0, z: 0 })
  })
  it('advances runners through first, second, third, home, and first again', function () {
    const runner = createPlayers()[9]
    for (const index of [2, 3, 0, 1]) {
      setDestination(runner, nextBase(runner))
      expect(runner.target).deep.equals(BASES[index])
      for (let frame = 0; frame < 1200; frame++) advancePlayer(runner, 1 / 60)
    }
  })
})
