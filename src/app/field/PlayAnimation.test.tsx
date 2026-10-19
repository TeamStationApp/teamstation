import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import { type Mesh, Vector3 } from 'three'

import { scoringSession } from '../../test/scoringSession'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { scoringAudio } from '../scoring/scoringAudio'
import { initialScoringState, scoringReducer } from '../scoring/scoringMachine'
import { pitchPresentation } from '../scoring/scoringPresentation'
import { PlayAnimation } from './PlayAnimation'
import { Player } from './Player'
describe('rendered pitch timeline', function () {
  it('moves a visible ball and player poses from one clock, pauses, and completes once', async function () {
    const sequence = pitchPresentation(
      initialScoringState(scoringSession(gameFixture), true),
      'foul'
    )
    const players = sequence.players
    const cues: string[] = []

    const oldCue = scoringAudio.cue
    scoringAudio.cue = cue => {
      cues.push(cue)
    }
    let completed = 0
    const view = (paused: boolean): React.ReactElement => (
      <>
        <PlayAnimation
          sequence={sequence}
          players={players}
          paused={paused}
          onComplete={() => {
            completed++
          }}
        />
        {players.map(player => (
          <Player key={player.id} player={player} selected={false} />
        ))}
      </>
    )
    const renderer = await create(view(false))
    try {
      await renderer.advanceFrames(14, 0.05)
      const ball = renderer.scene.findByProps({ name: 'animated-baseball' })
        .instance as Mesh
      expect(ball.visible).equals(true)
      expect(ball.scale.toArray()).deep.equals([1, 1, 1])
      expect(cues).deep.equals(['swish'])
      const before = ball.position.clone()
      await renderer.update(view(true))
      await renderer.advanceFrames(20, 0.05)
      expect(ball.position.toArray()).deep.equals(before.toArray())
      expect(cues).has.length(1)
      await renderer.update(view(false))
      await renderer.advanceFrames(10, 0.05)
      expect(ball.position.z).greaterThan(0)
      expect(cues).deep.equals(['swish', 'pop', 'bat'])
      expect(
        players.find(player => player.playerId === sequence.batter)!.pose!.swing
      ).greaterThan(0)
      await renderer.advanceFrames(30, 0.05)
      expect(completed).equals(1)
      expect(ball.visible).equals(false)
    } finally {
      await renderer.unmount()
      scoringAudio.cue = oldCue
    }
  })
})

describe('rendered hit timeline', function () {
  for (const outcome of ['Single', 'Ball Caught'] as const)
    it(`samples ${outcome} while the fielder and batter run from their original positions`, async function () {
      let state = initialScoringState(scoringSession(gameFixture), true)
      state = scoringReducer(state, { type: 'OUTCOME', outcome })
      state = scoringReducer(state, {
        type: 'FIELDER',
        id: 10,
        point: { x: 25, z: -75 },
        generation: 0
      })
      state = scoringReducer(state, {
        type: 'TRAJECTORY',
        angle: -45,
        generation: 0
      })
      const sequence = state.presentation!
      if (sequence.kind !== 'hit') throw new Error('Expected hit')
      const players = sequence.players.map(p => ({
        ...p,
        position: { ...p.position },
        target: { ...p.target }
      }))
      let contacts = 0
      let completions = 0
      const renderer = await create(
        <PlayAnimation
          sequence={sequence}
          players={players}
          paused={false}
          onContact={() => {
            contacts++
            sequence.stage = 'flight'
          }}
          onComplete={() => {
            completions++
          }}
        />
      )
      try {
        const fielder = players.find(p => p.playerId === sequence.fielder)!
        await renderer.advanceFrames(5, 0.05)
        expect(fielder.position).deep.equals(sequence.fielderStart)
        await renderer.advanceFrames(20, 0.05)
        expect(contacts).equals(1)
        if (outcome === 'Ball Caught') {
          const batter = players.find(p => p.playerId === sequence.batter)!
          expect(batter.position.x).greaterThan(
            sequence.players.find(p => p.playerId === sequence.batter)!.position
              .x
          )
          expect(batter.position.z).lessThan(0)
        }
        expect(completions).equals(0)
        if (outcome === 'Ball Caught') {
          expect(fielder.position).not.deep.equals(sequence.fielderStart)
        }
        // Advance to just after landing without crossing the delayed pickup.
        const frames = Math.ceil((sequence.flightEndMs - 1200) / 50)
        await renderer.advanceFrames(frames, 0.05)
        if (outcome === 'Single') {
          expect(fielder.position).not.deep.equals(sequence.arc.target)
          expect(completions).equals(0)
        }
        const ball = renderer.scene.findByProps({ name: 'animated-baseball' })
          .instance as Mesh
        expect(ball.visible).equals(outcome === 'Single')
        await renderer.advanceFrames(200, 0.05)
        expect(completions).equals(1)
        expect(fielder.position).deep.equals(sequence.arc.target)
        expect(ball.position.x).equals(sequence.arc.target.x)
        expect(ball.position.z).equals(sequence.arc.target.z)
      } finally {
        await renderer.unmount()
      }
    })
})

describe('rendered defensive transfers', function () {
  for (const unassisted of [false, true])
    it(`animates ${unassisted ? 'a touch without a self-throw' : 'a visible throw to a receiver'}`, async function () {
      let state = initialScoringState(scoringSession(gameFixture), true)
      state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Throw Out' })
      state = scoringReducer(state, {
        type: 'FIELDER',
        id: 10,
        point: { x: 15, z: -40 },
        generation: 0
      })
      state = scoringReducer(state, {
        type: 'TRAJECTORY',
        angle: 25,
        generation: 0
      })
      const hit = state.presentation!
      state = scoringReducer(state, {
        type: 'PRESENTATION_DONE',
        id: hit.id,
        generation: 0,
        stage: hit.stage
      })
      state = scoringReducer(state, {
        type: 'DEFENDER',
        id: unassisted ? undefined : 12,
        generation: 0
      })
      const sequence = state.presentation!
      if (sequence.kind !== 'throw') throw new Error('Expected throw')
      const players = sequence.players.map(p => ({
        ...p,
        position: { ...p.position },
        target: { ...p.target }
      }))
      let complete = 0
      const renderer = await create(
        <PlayAnimation
          sequence={sequence}
          players={players}
          paused={false}
          onComplete={() => {
            complete++
          }}
        />
      )
      try {
        await renderer.advanceFrames(8, 0.05)
        const ball = renderer.scene.findByProps({ name: 'animated-baseball' })
          .instance as Mesh
        expect(ball.visible).equals(!unassisted)
        if (unassisted) {
          const runner = players.find(p => p.playerId === sequence.runner)!
          const defender = players.find(p => p.playerId === sequence.thrower)!
          const progress = Math.min(1, 350 / sequence.durationMs)
          const defenderProgress = Math.min(1, progress * 3)
          expect(defender.position.z).closeTo(
            sequence.holderOrigin.z +
              (sequence.to.z - sequence.holderOrigin.z) * defenderProgress,
            1e-8
          )
          expect(runner.position.x).closeTo(
            sequence.runnerFrom.x +
              (sequence.to.x - sequence.runnerFrom.x) * progress,
            0.00001
          )
          expect(runner.position.z).closeTo(
            sequence.runnerFrom.z +
              (sequence.to.z - sequence.runnerFrom.z) * progress,
            0.00001
          )
          expect(
            players.find(p => p.playerId === sequence.thrower)!.pose!.run
          ).equals(defenderProgress < 1 ? 1 : 0)
        }
        await renderer.advanceFrames(200, 0.05)
        expect(complete).equals(1)
        expect(ball.position.x).closeTo(sequence.to.x, 0.001)
        expect(ball.position.z).closeTo(sequence.to.z, 0.001)
      } finally {
        await renderer.unmount()
      }
    })
})

describe('presentation mounted over an existing field', () => {
  it('updates persistent player meshes in the same frame as the ball landing', async () => {
    let state = initialScoringState(scoringSession(gameFixture), true)
    state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Single' })
    state = scoringReducer(state, {
      type: 'FIELDER',
      id: 10,
      point: { x: 25, z: -75 },
      generation: 0
    })
    state = scoringReducer(state, {
      type: 'TRAJECTORY',
      angle: 45,
      generation: 0
    })
    const sequence = state.presentation!
    if (sequence.kind !== 'hit') throw new Error('Expected hit')
    const players = sequence.players.map(p => ({
      ...p,
      position: { ...p.position },
      target: { ...p.target }
    }))
    const view = (active: boolean): React.ReactElement => (
      <>
        {players.map(player => (
          <Player key={player.id} player={player} selected={false} />
        ))}
        {active && (
          <PlayAnimation
            sequence={sequence}
            players={players}
            paused={false}
            onComplete={() => undefined}
          />
        )}
      </>
    )
    const renderer = await create(view(false))
    try {
      await renderer.update(view(true))
      await renderer.advanceFrames(1, 0.01) // mounted timeline begins at zero
      await renderer.advanceFrames(1, sequence.flightEndMs / 1000)
      const fielder = players.find(p => p.playerId === 10)!
      const mesh = renderer.scene.findByProps({
        name: `player-${fielder.id}`
      }).instance
      const ball = renderer.scene.findByProps({
        name: 'animated-baseball'
      }).instance
      expect(ball.position.z).closeTo(sequence.arc.target.z, 1e-8)
      expect(
        (fielder.position.z - sequence.fielderStart.z) /
          (sequence.arc.target.z - sequence.fielderStart.z)
      ).closeTo(0.8, 1e-8)
      expect(mesh.position.z).closeTo(fielder.position.z, 1e-8)
    } finally {
      await renderer.unmount()
    }
  })
})

describe('rendered bunt timeline', () => {
  for (const side of ['R', 'L'] as const) {
    it(`selects and pauses the ${side} bunt pose from scoring contact identity`, async () => {
      let state = initialScoringState(scoringSession(gameFixture), true)
      state.session.liveData.plays.currentPlay!.matchup.batSide.code = side
      state = scoringReducer(state, {
        type: 'OUTCOME',
        outcome: 'Single',
        contactKind: 'bunt'
      })
      state = scoringReducer(state, {
        type: 'FIELDER',
        id: 10,
        point: { x: 20, z: -40 },
        generation: 0
      })
      state = scoringReducer(state, {
        type: 'TRAJECTORY',
        angle: -5,
        generation: 0
      })
      const sequence = state.presentation!
      expect(sequence.kind).equals('hit')
      if (sequence.kind !== 'hit') throw new Error('Expected hit')
      expect(sequence.contactKind).equals('bunt')
      const player = sequence.players.find(p => p.playerId === sequence.batter)!
      const view = (paused: boolean): React.ReactElement => (
        <>
          <PlayAnimation
            sequence={sequence}
            players={sequence.players}
            paused={paused}
            onComplete={() => {}}
          />
          <Player player={player} selected={false} />
        </>
      )
      const renderer = await create(view(false))
      try {
        await renderer.advanceFrames(1, 0)
        await renderer.advanceFrames(1, sequence.contactMs / 1000)
        const bat = renderer.scene.findByProps({
          name: 'animated-bat'
        }).instance
        const direction = new Vector3(0, 1, 0).applyQuaternion(bat.quaternion)
        expect(direction.x).closeTo(side === 'R' ? 1 : -1, 1e-6)
        expect(direction.y).closeTo(0, 1e-6)
        const held = bat.quaternion.clone()
        await renderer.update(view(true))
        await renderer.advanceFrames(5, 0.1)
        expect(bat.quaternion.equals(held)).equals(true)
        await renderer.update(view(false))
        await renderer.advanceFrames(1, 0)
        await renderer.advanceFrames(1, 0.1)
        expect(bat.quaternion.angleTo(held)).lessThan(1e-6)
      } finally {
        await renderer.unmount()
      }
      expect(player.pose).equals(undefined)
    })
  }
})
