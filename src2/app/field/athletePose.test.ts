import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { Vector3 } from 'three'

import { createDevelopmentSession } from '../scoring/developmentSession'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { initialScoringState } from '../scoring/scoringMachine'
import { PITCH_TIMING, pitchPresentation } from '../scoring/scoringPresentation'
import {
  BAT_CONTACT_DISTANCE,
  battingPose,
  pitchingHand,
  pitchingPose
} from './athletePose'
import { BALL_CONTACT } from './ballArcModel'
import { createStartingPlayers } from './batterModel'
import { samplePitch } from './playAnimationModel'
import { Player } from './Player'
import { makePlayerLabel } from './playerLabels'
import { PLAYER_SCALE } from './playerPresentation'
import { TERRAIN } from './terrain'

describe('articulated athlete motion', function () {
  for (const side of ['R', 'L'] as const) {
    it(`loads the pelvis before the torso and releases continuously from the ${side} hand`, function () {
      const state = initialScoringState(
        createDevelopmentSession(gameFixture, [], []),
        true
      )
      state.session.gameData.players[10].throws =
        side === 'L' ? 'left' : 'right'
      const sequence = pitchPresentation(state, 'called')
      const origin = sequence.players.find(
        p => p.playerId === sequence.pitcher
      )!.position
      for (const time of [0, 100, 300, 450, 649, 650, 1000, 1500]) {
        const pose = pitchingPose(time, PITCH_TIMING.release, side)
        expect(
          Object.values(pose)
            .flat(Infinity)
            .every(n => typeof n !== 'number' || Number.isFinite(n))
        ).equals(true)
        if (time <= PITCH_TIMING.release)
          expect(samplePitch(sequence, time).ball).deep.equals(
            pitchingHand(origin, time, PITCH_TIMING.release, side)
          )
      }
      const coil = pitchingPose(280, 650, side)
      const opening = pitchingPose(390, 650, side)
      const sign = side === 'R' ? 1 : -1
      expect(sign * (opening.pelvis - coil.pelvis)).greaterThan(0)
      expect(sign * (opening.torso - coil.torso)).at.most(0.001)
      expect(
        new Vector3(
          ...pitchingPose(649.99, 650, side).hands[side === 'R' ? 1 : 0]
        ).distanceTo(
          new Vector3(
            ...pitchingPose(650, 650, side).hands[side === 'R' ? 1 : 0]
          )
        )
      ).lessThan(0.001)
      const follow = pitchingPose(975, 650, side)
      expect(follow.lean).greaterThan(0.5)
      expect(sign * follow.hands[side === 'R' ? 1 : 0][0]).lessThan(0)
    })
    for (const miss of [false, true]) {
      it(`puts the rendered ${side} barrel ${miss ? 'above' : 'through'} the pitch and keeps both hands on the bat`, async function () {
        const player = createStartingPlayers().find(p => p.batting === true)!
        player.position = { x: side === 'R' ? -4 : 4, z: 0 }
        player.target = { ...player.position }
        player.batSide = side
        player.pose = {
          windup: 0,
          swing: 1,
          catch: 0,
          throwSide: 'R',
          athlete: battingPose(
            1050,
            1050,
            side,
            player.position,
            { x: 0, y: BALL_CONTACT, z: 0 },
            miss
          )
        }
        const renderer = await create(
          React.createElement(Player, { player, selected: false })
        )
        try {
          await renderer.advanceFrames(1, 1 / 60)
          renderer.scene.instance.updateMatrixWorld(true)
          const bat = renderer.scene.findByProps({
            name: 'animated-bat'
          }).instance
          const barrel = bat.localToWorld(
            new Vector3(0, BAT_CONTACT_DISTANCE, 0)
          )
          expect(barrel.x).closeTo(0, 0.00001)
          expect(barrel.z).closeTo(0, 0.00001)
          expect(barrel.y).closeTo(
            BALL_CONTACT + (miss ? 0.3 * PLAYER_SCALE : 0),
            0.00001
          )
          for (const i of [0, 1]) {
            const hand = renderer.scene
              .findByProps({ name: `hand-${i}` })
              .instance.getWorldPosition(new Vector3())
            expect(
              hand.distanceTo(bat.localToWorld(new Vector3(0, i * 0.15, 0)))
            ).lessThan(0.00001)
          }
          const lead = player.pose.athlete!.feet[0]
          for (const time of [600, 800, 1049, 1050, 1200, 1400]) {
            const pose = battingPose(time, 1050, side, player.position, {
              x: 0,
              y: BALL_CONTACT,
              z: 0
            })
            expect(pose.feet[0]).deep.equals(lead)
            player.pose.athlete = pose
            await renderer.advanceFrames(1, 1 / 60)
          }
          delete player.pose
          await renderer.advanceFrames(1, 1 / 60)
          expect(
            renderer.scene.findByProps({ name: 'athlete-rig' }).instance.visible
          ).equals(false)
        } finally {
          await renderer.unmount()
        }
      })
    }
  }
  it('renders a possession ball in the right hand and four white foot rings', async function () {
    const player = createStartingPlayers()[0]
    player.hasBall = true
    const texture = makePlayerLabel('⚾ Pitcher', true)
    const rgba = Array.from(texture.image.data as Uint8Array)
    expect(
      rgba.some((v, i) => i % 4 === 0 && v === 196 && rgba[i + 1] === 48)
    ).equals(true)
    texture.dispose()
    const renderer = await create(
      React.createElement(Player, { player, selected: false })
    )
    try {
      expect(
        renderer.scene.findAllByProps({ name: 'possession-ring' })
      ).has.length(4)
      const ball = renderer.scene.findByProps({
        name: 'possession-ball'
      }).instance
      expect(ball.parent!.position.x).equals(0.56)
      expect(
        renderer.scene.findAllByProps({ name: 'active-grab-ring' })
      ).has.length(0)
      player.hasBall = false
      await renderer.update(
        React.createElement(Player, { player, selected: false })
      )
      expect(
        renderer.scene.findAllByProps({ name: 'possession-ball' })
      ).has.length(0)
    } finally {
      await renderer.unmount()
    }
  })
  it('mirrors pitching hand positions throughout all phases', function () {
    for (const time of [0, 200, 450, 650, 900, 1300, 1600]) {
      const right = pitchingHand({ x: 0, z: -18.44 }, time, 650, 'R')
      const left = pitchingHand({ x: 0, z: -18.44 }, time, 650, 'L')
      expect(left.x).closeTo(-right.x, 0.000001)
      expect(left.y).equals(right.y)
      expect(left.z).equals(right.z)
      expect(left.y).greaterThan(TERRAIN.players)
    }
  })
})
