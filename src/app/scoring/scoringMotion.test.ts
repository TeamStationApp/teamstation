import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'

import { completeMotions } from '../../test/scoringHelpers'
import { scoringSession } from '../../test/scoringSession'
import { advancePlayer } from '../field/fieldModel'
import { FieldScene } from '../field/FieldScene'
import { Player } from '../field/Player'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { scoringFieldPlayers } from './scoringMotion'
import { playerRef } from './scoringSelectors'
describe('owned runner animations', function () {
  it('finishes a strikeout between sparse field frames before accepting strike one for the next batter', async function () {
    let state = initialScoringState(scoringSession(gameFixture), true)
    const nextPitch = { type: 'PITCH', kind: 'called' } as const
    for (const kind of ['called', 'called', 'swing'] as const) {
      state = scoringReducer(state, { type: 'PITCH', kind })
      const { id, generation, stage } = state.presentation!
      expect(scoringReducer(state, nextPitch)).equals(state)
      state = scoringReducer(state, {
        type: 'PRESENTATION_DONE',
        id,
        generation,
        stage
      })
    }
    expect(state.phase).equals('runnerMovement')
    expect(scoringReducer(state, nextPitch)).equals(state)
    const { id, generation } = state.motions[0]
    expect(
      scoringReducer(state, {
        type: 'MOTION_DONE',
        id,
        generation: generation + 1
      })
    ).equals(state)
    const completions: Array<[string, number]> = []
    let players = scoringFieldPlayers(state)
    const scene = (paused = false): React.ReactElement =>
      React.createElement(FieldScene, {
        players,
        selected: '',
        view: 'home',
        zoom: 1,
        onSelect: () => undefined,
        presentationPaused: paused,
        activeMotionTime: true,
        onMovementComplete: (id, generation) => {
          completions.push([id, generation])
          state = scoringReducer(state, { type: 'MOTION_DONE', id, generation })
        }
      })
    let requests = 0
    const renderer = await create(scene(), {
      onCreated: root => {
        root.set({
          invalidate: () => {
            requests++
          }
        })
      }
    })
    try {
      const first = players.find(player => player.motion?.id === id)!
      const start = { ...first.position }
      const before = requests
      await renderer.advanceFrames(1, 0)
      expect(first.position).deep.equals(start)
      expect(requests).greaterThan(before)
      players = scoringFieldPlayers(state, players)
      await renderer.update(scene())
      const runner = players.find(player => player.motion?.id === id)!
      await renderer.advanceFrames(1, 0.185)
      expect(
        Math.hypot(runner.position.x - start.x, runner.position.z - start.z)
      ).greaterThan(5)
      await renderer.update(scene(true))
      await renderer.update(scene())
      const resumed = { ...runner.position }
      await renderer.advanceFrames(1, 2.1)
      expect(
        Math.hypot(runner.position.x - resumed.x, runner.position.z - resumed.z)
      ).within(0.01, 4.77)
      expect(scoringReducer(state, nextPitch)).equals(state)
      await renderer.update(scene(true))
      const pausedAt = { ...runner.position }
      const pausedWaypoint = runner.motion!.index
      await renderer.advanceFrames(1, 2.1)
      expect(runner.position).deep.equals(pausedAt)
      expect(runner.motion!.index).equals(pausedWaypoint)
      expect(completions).deep.equals([])
      await renderer.update(scene())
      await renderer.advanceFrames(2, 2.1)
      expect(completions).deep.equals([[id, generation]])
      state = scoringReducer(state, { type: 'GESTURE', active: true })
      expect(scoringReducer(state, nextPitch)).equals(state)
      state = scoringReducer(state, { type: 'GESTURE', active: false })
      state = scoringReducer(state, nextPitch)
      expect(
        state.session.liveData.plays.currentPlay!.matchup.batter.id
      ).equals(2)
      expect(state.session.liveData.linescore.strikes).equals(1)
      expect(state.session.liveData.linescore.outs).equals(1)
    } finally {
      await renderer.unmount()
    }
  })
  it('bounds the first frame of a replacement generation with the same command id', async function () {
    const state = scoringReducer(
      initialScoringState(scoringSession(gameFixture)),
      { type: 'MORE', input: { action: 'Hit by Pitch' } }
    )
    const player = scoringFieldPlayers(state).find(
      player => player.motion != null
    )!
    const model = (): React.ReactElement =>
      React.createElement(Player, {
        player,
        selected: false,
        activeMotionTime: true
      })
    const renderer = await create(model())
    try {
      await renderer.advanceFrames(1, 30)
      expect(player.motion!.reported).equals(false)
      const before = { ...player.position }
      player.motion = {
        ...player.motion!,
        generation: player.motion!.generation + 1
      }
      await renderer.update(model())
      await renderer.advanceFrames(1, 30)
      expect(
        Math.hypot(player.position.x - before.x, player.position.z - before.z)
      ).within(0.01, 4.77)
      expect(player.motion.reported).equals(false)
      await renderer.advanceFrames(1, 2.1)
      expect(player.motion.reported).equals(true)
    } finally {
      await renderer.unmount()
    }
  })
  it('follows every base waypoint, reports once and survives model updates without restarting', async function () {
    let state = initialScoringState(scoringSession(gameFixture))
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
      await renderer.advanceFrames(1, 1 / 60)
      const expected = { ...batter, position: { ...batter.position } }
      advancePlayer(expected, 0.05)
      // The native canvas uses this default clock even on a continuing command.
      await renderer.advanceFrames(1, 2.1)
      expect(batter.position).deep.equals(expected.position)
      expect(completions).equals(0)
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
  it('names a runner named in full for this reader by his public label', function () {
    let state = initialScoringState(scoringSession(gameFixture))
    for (const id of [1, 3])
      Object.assign(state.session.gameData.players[id], {
        fullName: id === 1 ? 'Mookie Betts' : 'Freddie Freeman',
        nameFormat: 'full',
        compactName: id === 1 ? 'Mookie B' : 'Freddie F'
      })
    state.session.liveData.linescore.offense.second = playerRef(
      state.session,
      3
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
    const players = scoringFieldPlayers(state)
    const batter = players.find(player => player.playerId === 1)!
    const runner = players.find(player => player.playerId === 3)!
    expect([batter.name, batter.displayName]).deep.equals([
      'Mookie B',
      'Mookie B'
    ])
    expect(runner.displayName).equals('Freddie F')
    expect(JSON.stringify(players)).not.include('Betts')
  })
  it('places home arrivals two feet apart, clears departed players and restores the correct dugout side', function () {
    let state = initialScoringState(scoringSession(gameFixture))
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
