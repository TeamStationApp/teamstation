import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  advancePlayer,
  advancePlayerFrame,
  BASES,
  CATCHER_SPOT,
  catcherSpot,
  clampToField,
  createPlayers,
  type FieldPlayer,
  locomotionSpeed,
  nextBase,
  setDestination
} from './fieldModel'
import { PLAYER_SCALE } from './playerPresentation'
import { SCORING_SPEED } from './scoringSpeed'

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
      // Scoring plays at twice the natural pace.
      const prior = 1.4 * Math.min(17, 4 + distance * 1.1) * SCORING_SPEED
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
  it('follows a commanded route at both 60 and 120 Hz', function () {
    function runRoute(hz: number): number {
      const runner = createPlayers()[9]
      runner.position = { x: 0, z: 0 }
      runner.target = { x: 75, z: 0 }
      const finish = { x: 75, z: 24 }
      runner.motion = {
        id: 'turn-at-first',
        generation: 1,
        index: 0,
        reported: false,
        waypoints: [runner.target, finish]
      }
      let completions = 0
      let halfwayX = 0
      for (let frame = 1; frame <= 6 * hz; frame++) {
        if (advancePlayerFrame(runner, 1 / hz, frame > 1)) completions++
        if (frame === hz / 2) {
          halfwayX = runner.position.x
          expect(halfwayX).greaterThan(0).and.lessThan(75)
          expect(runner.position.z).equals(0)
        }
      }
      expect(runner.position).deep.equals(finish)
      expect(completions).equals(1)
      return halfwayX
    }
    expect(runRoute(120)).closeTo(runRoute(60), 0.02)
  })
  it('uses active time across frames and follows each waypoint in order', function () {
    function runner(): FieldPlayer {
      const player = createPlayers()[9]
      player.position = { x: 0, z: 0 }
      player.target = { x: 18, z: 0 }
      player.motion = {
        id: 'round-first',
        generation: 3,
        index: 0,
        reported: false,
        waypoints: [player.target, { x: 18, z: 12 }]
      }
      return player
    }
    const slow = runner()
    const ordinary = runner()
    for (const invalid of [-1, NaN, Infinity]) {
      expect(advancePlayerFrame(slow, invalid, true)).equals(false)
      expect(slow.position).deep.equals({ x: 0, z: 0 })
    }
    advancePlayerFrame(slow, 30, false)
    advancePlayer(ordinary, 0.05)
    expect(slow.position).deep.equals(ordinary.position)
    advancePlayerFrame(slow, 0.185, true)
    for (const dt of [0.05, 0.05, 0.05, 0.035]) advancePlayer(ordinary, dt)
    expect(slow.position.x).closeTo(ordinary.position.x, 1e-8)
    expect(slow.position.z).equals(0)
    expect(advancePlayerFrame(slow, 2.1, true)).equals(true)
    expect(slow.position).deep.equals({ x: 18, z: 12 })
    expect(slow.stride / 1.85).closeTo(30, 0.04)
    expect(slow.motion!.index).equals(1)
    expect(advancePlayerFrame(slow, Number.MAX_VALUE, true)).equals(false)
    const held = runner()
    held.dragging = true
    advancePlayerFrame(held, 2.1, false)
    expect(held.position).deep.equals({ x: 0, z: 0 })
    held.dragging = false
    for (const index of [0, 1]) {
      held.motion!.index = index
      held.pose = { windup: 0, swing: 0, catch: 0, throwSide: 'R', run: 1 }
      // The presentation keeps the render target at the current pose.
      held.position = { x: 7, z: 0 }
      held.target = { ...held.position }
      expect(advancePlayerFrame(held, 2.1, false)).equals(false)
      expect(held.position).deep.equals({ x: 7, z: 0 })
      expect(held.motion!.index).equals(index)
      expect(held.motion!.reported).equals(false)
    }
    delete held.pose
    expect(advancePlayerFrame(held, 0.01, false)).equals(false)
    expect(held.target).deep.equals({ x: 18, z: 12 })
    // The render target is a copy: writing it leaves the stored route alone.
    held.target.x = 25
    expect(held.motion!.waypoints[1]).deep.equals({ x: 18, z: 12 })
    expect(advancePlayerFrame(held, 2.1, true)).equals(true)
    expect(held.position).deep.equals({ x: 18, z: 12 })
  })
  it('caps a resumed frame and bounds off-field pointer destinations', function () {
    const player = createPlayers()[0]
    setDestination(player, { x: 10000, z: -10000 })
    expect(Math.hypot(player.target.x, player.target.z)).at.most(110.00001)
    advancePlayer(player, 30)
    expect(Math.hypot(player.position.x, player.position.z + 18.44)).at.most(
      1.2 * SCORING_SPEED
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

describe('where the catcher is', function () {
  it('is the catcher’s own spot, or behind the plate when nobody is there', function () {
    const players = createPlayers()
    const catcher = players.find(player => player.label === 'C')
    if (catcher == null) throw new Error('No catcher')
    catcher.position = { x: 1, z: 5 }
    expect(catcherSpot(players)).deep.equals({ x: 1, z: 5 })
    expect(
      catcherSpot(players.filter(player => player.label !== 'C'))
    ).deep.equals(CATCHER_SPOT)
  })
})
