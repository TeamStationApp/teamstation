import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import type { Mesh } from 'three'

import { createDevelopmentSession } from '../scoring/developmentSession'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { scoringAudio } from '../scoring/scoringAudio'
import { initialScoringState } from '../scoring/scoringMachine'
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
