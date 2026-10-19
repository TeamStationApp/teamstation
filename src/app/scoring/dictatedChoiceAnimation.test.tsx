import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React from 'react'
import type { Mesh } from 'three'

import { choiceRelayPhrases } from '../../test/fieldersChoicePhrases'
import { scoringSession } from '../../test/scoringSession'
import { BASES } from '../field/fieldModel'
import { PlayAnimation } from '../field/PlayAnimation'
import { gameFixture } from './isUnscoredGame.test'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'

describe('rendered dictated fielder choice relays', function () {
  for (const unassisted of [false, true, undefined])
    for (const startingOuts of [0, 2])
      for (const runnerOnly of [false, true])
        it(`joins the actual off-base tag position to the following walk off (${unassisted}/${startingOuts}/${runnerOnly})`, async function () {
          const session = scoringSession(gameFixture)
          session.liveData.linescore.offense.first = playerRef(session, 6)
          session.liveData.linescore.outs = startingOuts
          const target = { x: 4, z: -11 }
          const state = scoringReducer(initialScoringState(session, true), {
            type: 'DICTATED',
            transcript: "Fielder's choice. Ground ball to third.",
            actions: [
              {
                type: 'ballInPlay',
                contact: 'swing',
                trajectory: 'ground_ball',
                fielder: 15
              },
              { type: 'result', eventType: 'fielders_choice' },
              {
                type: 'runnerMovement',
                runner: 6,
                to: '2B',
                out: true,
                fielders:
                  unassisted == null ? undefined : unassisted ? [15] : [15, 13],
                ...(runnerOnly
                  ? { runnerLocation: target }
                  : {
                      locations:
                        unassisted !== false
                          ? [target]
                          : [{ x: -19, z: -27 }, target]
                    })
              },
              { type: 'runnerMovement', runner: 1, to: '1B' }
            ]
          })
          expect(state.dictation?.problem).equals(undefined)
          const sequence = [
            state.presentation,
            ...state.reel!.map(beat => beat.presentation)
          ].findLast(p => p?.kind === 'throw')!
          if (sequence.kind !== 'throw') throw new Error('Expected tag throw')
          const walk = state
            .reel!.flatMap(beat => beat.motions)
            .findLast(m => m.playerId === 6)!
          const players = sequence.players.map(p => ({
            ...p,
            position: { ...p.position },
            target: { ...p.target }
          }))
          let completed = 0
          const renderer = await create(
            <PlayAnimation
              sequence={sequence}
              players={players}
              paused={false}
              onComplete={() => {
                completed++
              }}
            />
          )
          try {
            await renderer.advanceFrames(200, 0.05)
            expect(completed).equals(1)
            expect(players.find(p => p.playerId === 6)!.position).deep.equals(
              target
            )
            expect(walk.waypoints[0]).deep.equals(
              players.find(p => p.playerId === 6)!.position
            )
          } finally {
            await renderer.unmount()
          }
        })
  it('renders a late Safe throw after its carrier has scored without showing him again', async function () {
    const session = scoringSession(gameFixture)
    session.liveData.linescore.offense.first = playerRef(session, 6)
    session.liveData.linescore.offense.third = playerRef(session, 8)
    const state = scoringReducer(initialScoringState(session, true), {
      type: 'DICTATED',
      transcript: "Fielder's choice. Ground ball to third.",
      actions: [
        {
          type: 'ballInPlay',
          contact: 'swing',
          trajectory: 'ground_ball',
          fielder: 15
        },
        { type: 'result', eventType: 'fielders_choice' },
        { type: 'runnerMovement', runner: 6, to: '3B', fielders: [15, 13] },
        { type: 'runnerMovement', runner: 8, to: 'home', fielders: [13, 11] },
        { type: 'runnerMovement', runner: 1, to: '1B' }
      ]
    })
    expect(state.dictation?.problem).equals(undefined)
    const sequences = [
      state.presentation,
      ...state.reel!.map(beat => beat.presentation)
    ].filter(p => p?.kind === 'throw')
    expect(sequences.map(p => [p.thrower, p.receiver])).deep.equals([
      [15, 13],
      [13, 11]
    ])
    for (const sequence of sequences) {
      const players = sequence.players.map(p => ({
        ...p,
        position: { ...p.position },
        target: { ...p.target }
      }))
      expect(players.some(p => p.playerId === 8)).equals(false)
      let completed = 0
      const renderer = await create(
        <PlayAnimation
          sequence={sequence}
          players={players}
          paused={false}
          onComplete={() => {
            completed++
          }}
        />
      )
      try {
        await renderer.advanceFrames(200, 0.05)
        expect(completed).equals(1)
        expect(players.some(p => p.playerId === 8)).equals(false)
        const ball = renderer.scene.findByProps({ name: 'animated-baseball' })
          .instance as Mesh
        expect(ball.position.x).closeTo(sequence.to.x, 0.001)
        expect(ball.position.z).closeTo(sequence.to.z, 0.001)
      } finally {
        await renderer.unmount()
      }
    }
  })
  for (const example of choiceRelayPhrases)
    it(`renders the ball and defenders through every catch: ${example.said}`, async function () {
      const session = scoringSession(gameFixture)
      for (const [index, key] of (
        ['first', 'second', 'third'] as const
      ).entries())
        session.liveData.linescore.offense[key] =
          (example.mask & (1 << index)) !== 0
            ? playerRef(session, index + 6)
            : null
      const state = scoringReducer(initialScoringState(session, true), {
        type: 'DICTATED',
        transcript: example.said,
        actions: [
          {
            type: 'ballInPlay',
            contact: 'swing',
            trajectory: 'ground_ball',
            fielder: 15
          },
          { type: 'result', eventType: 'fielders_choice' }
        ]
      })
      expect(state.dictation?.problem).equals(undefined)
      expect(state.dictationQuestion).equals(undefined)
      const sequences = [
        state.presentation,
        ...(state.reel ?? []).map(b => b.presentation)
      ].filter(p => p?.kind === 'throw')
      expect(sequences.map(p => [p.thrower, p.receiver])).deep.equals(
        example.throws
      )
      for (const sequence of sequences) {
        if (sequence?.kind !== 'throw') throw new Error('Expected throw')
        const players = sequence.players.map(p => ({
          ...p,
          position: { ...p.position },
          target: { ...p.target }
        }))
        let completed = 0
        const renderer = await create(
          <PlayAnimation
            sequence={sequence}
            players={players}
            paused={false}
            onComplete={() => {
              completed++
            }}
          />
        )
        try {
          await renderer.advanceFrames(8, 0.05)
          const ball = renderer.scene.findByProps({ name: 'animated-baseball' })
            .instance as Mesh
          expect(ball.visible).equals(!sequence.unassisted)
          const receiver = players.find(p => p.playerId === sequence.receiver)!
          if (!sequence.unassisted)
            expect(receiver.position).deep.equals({
              x: sequence.to.x,
              z: sequence.to.z
            })
          if (sequence.safe === true)
            expect(players.find(p => p.playerId === 1)!.position).deep.equals(
              BASES[1]
            )
          await renderer.advanceFrames(200, 0.05)
          expect(completed).equals(1)
          expect(ball.position.x).closeTo(sequence.to.x, 0.001)
          expect(ball.position.z).closeTo(sequence.to.z, 0.001)
          if (sequence.unassisted)
            expect(receiver.position).deep.equals({
              x: sequence.to.x,
              z: sequence.to.z
            })
        } finally {
          await renderer.unmount()
        }
      }
    })
})
