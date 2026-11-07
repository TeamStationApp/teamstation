import { create } from '@react-three/test-renderer'
import { expect } from 'chai'
import { describe, it } from 'mocha'
import React, { act } from 'react'
import { createRoot } from 'react-dom/client'
import type { InstancedMesh, Mesh, MeshBasicMaterial } from 'three'

import { completeMotions } from '../../test/scoringHelpers'
import { scoringSession } from '../../test/scoringSession'
import {
  celebrationPulse,
  FIREWORK_BULBS,
  fireworkBulb
} from '../field/homeRunFireworks'
import { Scoreboard } from '../field/Scoreboard'
import { DEMO_SCOREBOARD } from '../field/scoreboardModel'
import { gameFixture } from './isUnscoredGame.test'
import type { ScoringClock } from './scoringClock'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
import type {
  HomeRunCelebration,
  ScoringEvent,
  ScoringState
} from './scoringTypes'
import { CELEBRATION_MS, useHomeRunCelebration } from './useHomeRunCelebration'
import { useHomeRunCelebration as nativeCelebration } from './useHomeRunCelebration.native'

function acceptedHomeRun(
  outside: boolean,
  animate = false,
  loaded = false
): ScoringState {
  let state = initialScoringState(scoringSession(gameFixture), animate)
  if (loaded) {
    const offense = state.session.liveData.linescore.offense
    offense.first = playerRef(state.session, 3)
    offense.second = playerRef(state.session, 4)
    offense.third = playerRef(state.session, 5)
  }
  state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Home Run' })
  state = scoringReducer(state, {
    type: 'LANDING',
    point: { x: 0, z: outside ? -130 : -113.5 },
    generation: 0
  })
  expect(state.celebration).equals(null)
  return scoringReducer(state, { type: 'TRAJECTORY', angle: 45, generation: 0 })
}
describe('home-run scoreboard celebration', () => {
  it('keeps celebrating a grand slam until the last runner finishes', () => {
    for (const outside of [false, true]) {
      let state = acceptedHomeRun(outside, false, true)
      const token = state.celebration
      const motions = state.motions.filter(motion => !motion.complete)
      expect(motions).has.length(4)
      for (const [index, motion] of motions.entries()) {
        state = scoringReducer(state, {
          type: 'MOTION_DONE',
          id: motion.id,
          generation: motion.generation
        })
        if (index < motions.length - 1) {
          expect(state.celebration).deep.equals(token)
          expect(state.phase).equals('runnerMovement')
        }
      }
      expect(state.phase).equals('ready')
      expect(state.celebration).equals(null)
      expect(state.session.liveData.linescore.offense.batter?.id).equals(2)
      expect(state.session.liveData.linescore.teams.away.runs).equals(4)
    }
  })
  it('keeps the unavailable native renderer inert', () => {
    nativeCelebration()
  })
  it('celebrates while runners move and restores the scoreboard for the next batter', () => {
    for (const outside of [false, true])
      for (const animate of [false, true]) {
        let state = acceptedHomeRun(outside, animate)
        const token = state.celebration!
        expect(token.kind).equals(outside ? 'out-of-park' : 'in-park')
        expect(
          scoringReducer(state, {
            type: 'CELEBRATION_DONE',
            id: 'old',
            generation: 0
          })
        ).equals(state)
        const expired = scoringReducer(state, {
          type: 'CELEBRATION_DONE',
          id: token.id,
          generation: 0
        })
        expect(expired.celebration).equals(null)
        expect(expired.past).equals(state.past)
        expect(expired.session).equals(state.session)
        expect(
          scoringReducer(state, {
            type: 'CELEBRATION_DONE',
            id: token.id,
            generation: 999
          })
        ).equals(state)
        if (state.presentation != null) {
          const seq = state.presentation
          state = scoringReducer(state, {
            type: 'PRESENTATION_CONTACT',
            id: seq.id,
            generation: 0
          })
          state = scoringReducer(state, {
            type: 'PRESENTATION_DONE',
            id: seq.id,
            generation: 0,
            stage: 'flight'
          })
        }
        expect(state.motions.some(motion => !motion.complete)).equals(true)
        expect(state.celebration).deep.equals(token)
        state = completeMotions(state)
        expect(state.phase).equals('ready')
        expect(state.session.liveData.linescore.offense.batter?.id).equals(2)
        expect(state.celebration).equals(null)
        expect(
          scoringReducer(state, {
            type: 'CELEBRATION_DONE',
            id: token.id,
            generation: 0
          })
        ).equals(state)
        expect(
          scoringReducer(state, { type: 'PITCH', kind: 'ball' }).celebration
        ).equals(null)
        expect(scoringReducer(state, { type: 'UNDO' }).celebration).equals(null)
        expect(scoringReducer(state, { type: 'END_HALF' }).celebration).equals(
          null
        )
      }
  })
  it('keeps LED fireworks to either side of the title', () => {
    for (let t = 0; t < 6; t += 0.05)
      for (let i = 0; i < FIREWORK_BULBS; i++) {
        const p = fireworkBulb(i, t)
        expect(Math.abs(p.x)).within(21, 31)
        expect(p.y).within(-7, 7)
        expect(p.scale).within(0, 1)
      }
  })
  it('bursts and pulses the LED fireworks at twice their natural pace', () => {
    // A burst's 1.8 s cycle now takes 0.9 s, and the pulse's one second half.
    for (let i = 0; i < FIREWORK_BULBS; i++) {
      const later = fireworkBulb(i, 0.9 + 0.3)
      const now = fireworkBulb(i, 0.3)
      expect(later.x).closeTo(now.x, 1e-9)
      expect(later.y).closeTo(now.y, 1e-9)
      expect(later.scale).closeTo(now.scale, 1e-9)
    }
    expect(fireworkBulb(0, 0.45)).not.deep.equals(fireworkBulb(0, 0))
    expect(celebrationPulse(0.5 + 0.1)).closeTo(celebrationPulse(0.1), 1e-12)
    expect(celebrationPulse(0.125)).closeTo(1, 1e-12)
  })
  it('renders pulsing letters, moving LED bursts and disposes the texture on clear', async () => {
    for (const kind of ['in-park', 'out-of-park'] as const) {
      const state = {
        ...DEMO_SCOREBOARD,
        celebration: { kind, id: 'celebrate', paused: false }
      }
      const renderer = await create(<Scoreboard state={state} />)
      const normal = renderer.scene.findByProps({ name: 'scoreboard-bulbs' })
        .instance as Mesh
      expect(normal.visible).equals(false)
      const letters = renderer.scene.findByProps({ name: 'home-run-letters' })
        .instance as Mesh
      const material = letters.material as MeshBasicMaterial
      const texture = material.map!
      let disposed = false
      texture.addEventListener('dispose', () => {
        disposed = true
      })
      const fireworks = renderer.scene.findByProps({
        name: 'home-run-fireworks'
      }).instance as InstancedMesh
      await renderer.advanceFrames(1, 4)
      const before = Array.from(fireworks.instanceMatrix.array)
      const opacity = material.opacity
      await renderer.advanceFrames(3, 0.05)
      expect(material.opacity).not.equals(opacity)
      expect(Array.from(fireworks.instanceMatrix.array)).not.deep.equals(before)
      await renderer.update(
        <Scoreboard
          state={{
            ...state,
            celebration: { ...state.celebration, paused: true }
          }}
        />
      )
      await renderer.advanceFrames(1, 1)
      const paused = Array.from(fireworks.instanceMatrix.array)
      await renderer.advanceFrames(3, 1)
      expect(Array.from(fireworks.instanceMatrix.array)).deep.equals(paused)
      await renderer.update(<Scoreboard state={DEMO_SCOREBOARD} />)
      // The board is drawn again in a task of its own (`Scoreboard`).
      await act(async () => {
        await new Promise(resolve => setTimeout(resolve, 5))
      })
      expect(disposed).equals(true)
      expect(
        (
          renderer.scene.findByProps({ name: 'scoreboard-bulbs' })
            .instance as Mesh
        ).visible
      ).equals(true)
      await renderer.unmount()
    }
  })
  it('expires after three active seconds, pauses, rejects stale callbacks and cleans up', async () => {
    let time = 0
    let callback = (): void => {}
    let delay = 0
    let canceled = 0
    const clock: ScoringClock = {
      now: () => time,
      schedule: (cb, ms) => {
        callback = cb
        delay = ms
        return 1
      },
      cancel: () => {
        canceled++
      }
    }
    const events: ScoringEvent[] = []
    const dispatch = (event: ScoringEvent): void => {
      events.push(event)
    }
    const root = createRoot(document.createElement('div'))
    function Clock({
      value,
      paused = false
    }: {
      value?: HomeRunCelebration
      paused?: boolean
    }): null {
      useHomeRunCelebration(value, paused, dispatch, clock)
      return null
    }
    const token: HomeRunCelebration = {
      id: 'one',
      generation: 0,
      kind: 'in-park'
    }
    try {
      await act(async () => {
        root.render(<Clock />)
      })
      await act(async () => {
        root.render(<Clock value={token} />)
      })
      // Twice as fast as the six seconds it once took.
      expect(CELEBRATION_MS).equals(3000)
      expect(delay).equals(3000)
      const stale = callback
      time = 1000
      await act(async () => {
        root.render(<Clock value={token} paused />)
      })
      stale()
      expect(events).has.length(0)
      time = 10000
      await act(async () => {
        root.render(<Clock value={token} />)
      })
      expect(delay).equals(2000)
      callback()
      expect(events).deep.equals([
        { type: 'CELEBRATION_DONE', id: 'one', generation: 0 }
      ])
      await act(async () => {
        root.render(<Clock value={{ ...token, id: 'two' }} />)
      })
      expect(delay).equals(3000)
      const removed = callback
      await act(async () => {
        root.unmount()
      })
      removed()
      expect(events).has.length(1)
      expect(canceled).equals(3)
    } catch (error) {
      await act(async () => {
        root.unmount()
      })
      throw error
    }
  })
})
