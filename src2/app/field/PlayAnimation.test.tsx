import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import type { Mesh } from 'three'

import { createDevelopmentSession } from '../scoring/developmentSession'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { scoringAudio } from '../scoring/scoringAudio'
import { initialScoringState, scoringReducer } from '../scoring/scoringMachine'
import { pitchPresentation } from '../scoring/scoringPresentation'
import { PlayAnimation } from './PlayAnimation'
import { Player } from './Player'
describe('rendered pitch timeline', function () {
  it('moves a visible ball and player poses from one clock, pauses, and completes once', async function () {
    const sequence = pitchPresentation(
      initialScoringState(createDevelopmentSession(gameFixture, [], []), true),
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
      await renderer.advanceFrames(7, 0.05)
      const ball = renderer.scene.findByProps({ name: 'animated-baseball' })
        .instance as Mesh
      expect(ball.visible).equals(true)
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
  it('samples the chosen arc while the fielder runs from the original position', async function () {
    let state = initialScoringState(
      createDevelopmentSession(gameFixture, [], []),
      true
    )
    state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Single' })
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
    const players = sequence.players
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
      expect(fielder.position).not.deep.equals(sequence.fielderStart)
      const ball = renderer.scene.findByProps({ name: 'animated-baseball' })
        .instance as Mesh
      expect(ball.visible).equals(true)
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
