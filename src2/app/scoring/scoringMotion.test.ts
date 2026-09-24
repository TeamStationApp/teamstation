import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'

import { completeMotions } from '../../test/scoringHelpers'
import { Player } from '../field/Player'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { scoringFieldPlayers } from './scoringMotion'
import { playerRef } from './scoringSelectors'
describe('owned runner animations', function () {
  it('follows every base waypoint, reports once and survives model updates without restarting', async function () {
    let state = initialScoringState(
      createDevelopmentSession(gameFixture, [], [])
    )
    state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Home Run' })
    state = scoringReducer(state, {
      type: 'LANDING',
      point: { x: 5, z: -50 },
      generation: 0
    })
    state = scoringReducer(state, {
      type: 'TRAJECTORY',
      angle: 45,
      generation: 0
    })
    const original = JSON.stringify(state)
    const players = scoringFieldPlayers(state)
    const batter = players.find(player => player.playerId === 1)!
    let completions = 0
    const renderer = await create(
      React.createElement(Player, {
        player: batter,
        selected: false,
        onMovementComplete: (id, generation) => {
          expect(id).equals(state.motions[0].id)
          expect(generation).equals(0)
          completions++
        }
      })
    )
    try {
      await renderer.advanceFrames(60, 1 / 60)
      const rebuilt = scoringFieldPlayers(state, players).find(
        player => player.playerId === 1
      )!
      expect(rebuilt.position).deep.equals(batter.position)
      expect(rebuilt.motion).equals(batter.motion)
      await renderer.advanceFrames(2400, 1 / 60)
      expect(completions).equals(1)
      expect(batter.motion!.index).equals(5)
      await renderer.advanceFrames(120, 1 / 60)
      expect(completions).equals(1)
      expect(JSON.stringify(state)).equals(original)
      state = completeMotions(state)
      expect(
        scoringFieldPlayers(state).find(player => player.playerId === 1)
      ).equals(undefined)
      expect(
        state.session.liveData.plays.currentPlay!.matchup.batter.id
      ).equals(2)
    } finally {
      await renderer.unmount()
    }
  })
  it('places home arrivals two feet apart, clears departed players and restores the correct dugout side', function () {
    let state = initialScoringState(
      createDevelopmentSession(gameFixture, [], [])
    )
    state.session.liveData.linescore.offense.second = playerRef(
      state.session,
      3
    )
    state.session.liveData.linescore.offense.third = playerRef(state.session, 4)
    state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Triple' })
    state = scoringReducer(state, {
      type: 'FIELDER',
      id: 10,
      point: { x: 5, z: -50 },
      generation: 0
    })
    state = completeMotions(
      scoringReducer(state, { type: 'TRAJECTORY', angle: 45, generation: 0 })
    )
    const players = scoringFieldPlayers(state)
    const lead = players.find(player => player.playerId === 4)!
    const tail = players.find(player => player.playerId === 3)!
    expect(
      Math.hypot(
        lead.position.x - tail.position.x,
        lead.position.z - tail.position.z
      )
    ).closeTo(0.61, 0.00001)
    expect(lead.labelOrder!).greaterThan(tail.labelOrder!)
    state = scoringReducer(state, { type: 'HOME', decision: 'out' })
    state = scoringReducer(state, {
      type: 'THROWER',
      id: 10,
      point: { x: 5, z: -15 },
      generation: 0
    })
    state = scoringReducer(state, {
      type: 'DEFENDER',
      id: 11,
      point: { x: 1, z: 0 },
      generation: 0
    })
    state = scoringReducer(state, {
      type: 'DEFENDER',
      generation: state.generation
    })
    expect(
      state.motions.find(motion => motion.playerId === 4)!.waypoints.at(-1)!.x
    ).lessThan(0)
    const moving = scoringFieldPlayers(state)
    expect(moving.find(player => player.playerId === 11)!.position).deep.equals(
      { x: 0, z: 0 }
    )
    state = completeMotions(state)
    expect(
      scoringFieldPlayers(state).some(player => player.playerId === 4)
    ).equals(false)
  })
})
