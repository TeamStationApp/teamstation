import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PerspectiveCamera, Vector3 } from 'three'

import { createDevelopmentSession } from '../scoring/developmentSession'
import { gameFixture } from '../scoring/isUnscoredGame.test'
import { initialScoringState, scoringReducer } from '../scoring/scoringMachine'
import { PITCH_TIMING, pitchPresentation } from '../scoring/scoringPresentation'
import { applyFieldCamera } from './cameraModel'
import { sampleHit, samplePitch, sampleThrow } from './playAnimationModel'

const initial = (): ReturnType<typeof initialScoringState> =>
  initialScoringState(createDevelopmentSession(gameFixture, [], []), true)
describe('defender speed and perspective foul flight', function () {
  for (const distance of [12, 90])
    it(`finishes ${distance}-unit fielding travel in one third of flight time and waits`, function () {
      let state = scoringReducer(initial(), {
        type: 'OUTCOME',
        outcome: 'Throw Out'
      })
      state = scoringReducer(state, {
        type: 'FIELDER',
        id: 10,
        point: { x: 0, z: -distance },
        generation: 0
      })
      state = scoringReducer(state, {
        type: 'TRAJECTORY',
        angle: 45,
        generation: 0
      })
      const hit = state.presentation!
      if (hit.kind !== 'hit') throw new Error('Expected hit')
      const flight = hit.durationMs - hit.contactMs
      expect(sampleHit(hit, hit.contactMs).fielder).deep.equals(
        hit.fielderStart
      )
      const half = sampleHit(hit, hit.contactMs + flight / 6)
      expect(half.fielder.z).closeTo(
        (hit.fielderStart.z + hit.arc.target.z) / 2,
        1e-8
      )
      const arrived = sampleHit(hit, hit.contactMs + flight / 3)
      expect(arrived.fielder.z).closeTo(hit.arc.target.z, 1e-8)
      expect(arrived.visible).equals(true)
      expect(arrived.ball.z).not.equals(hit.arc.target.z)
      expect(sampleHit(hit, hit.contactMs + flight / 2).running).equals(false)
      state = scoringReducer(state, {
        type: 'PRESENTATION_DONE',
        id: hit.id,
        generation: 0,
        stage: hit.stage
      })
      state = scoringReducer(state, { type: 'DEFENDER', generation: 0 })
      const tag = state.presentation!
      if (tag.kind !== 'throw') throw new Error('Expected tag')
      const sampled = sampleThrow(tag, tag.durationMs / 3)
      expect(sampled.ball.x).closeTo(tag.to.x, 1e-8)
      expect(sampled.ball.z).closeTo(tag.to.z, 1e-8)
      expect(sampled.ball.y).equals(tag.to.y)
      expect(sampled.progress).closeTo(1 / 3, 1e-8)
      expect(sampled.defenderProgress).equals(1)
      expect(state.session.liveData.linescore.outs).equals(0)
      expect(sampleThrow({ ...tag, unassisted: false }, 150).ball).deep.equals(
        tag.from
      )
    })
  for (const [width, height] of [
    [1200, 900],
    [390, 844],
    [844, 390]
  ])
    for (const side of ['R', 'L'] as const)
      it(`keeps a fixed-radius ${side} foul visible at 2–3x apparent diameter at ${width}x${height}`, function () {
        const camera = new PerspectiveCamera()
        applyFieldCamera(camera, {
          width,
          height,
          view: 'home',
          zoom: 1.25,
          tilt: (-11 * Math.PI) / 180,
          heightOffset: 33,
          bottomExtension: 112
        })
        const sequence = pitchPresentation(initial(), 'foul')
        sequence.batSide = side
        const contact = samplePitch(
          sequence,
          PITCH_TIMING.plate,
          camera.position
        )
        expect(contact.ball).deep.equals(sequence.plate)
        const late = samplePitch(
          sequence,
          sequence.durationMs - 200,
          camera.position
        )
        const depth = (p: typeof sequence.plate): number =>
          -new Vector3(p.x, p.y, p.z).applyMatrix4(camera.matrixWorldInverse).z
        expect(depth(contact.ball) / depth(late.ball)).within(2, 3)
        expect(late.opacity).equals(1)
        expect(late.ball.z).greaterThan(0)
        expect(late.ball.x * (side === 'R' ? 1 : -1)).greaterThan(0)
        for (let i = 0; i <= 20; i++) {
          const sample = samplePitch(
            sequence,
            PITCH_TIMING.plate +
              ((sequence.durationMs - PITCH_TIMING.plate) * i) / 20,
            camera.position
          )
          expect(depth(sample.ball)).greaterThan(camera.near)
          const projected = new Vector3(
            sample.ball.x,
            sample.ball.y,
            sample.ball.z
          ).project(camera)
          expect(Math.abs(projected.x)).lessThan(1)
          expect(Math.abs(projected.y)).lessThan(1)
        }
      })
})
