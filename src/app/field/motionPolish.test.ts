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
    it(`finishes ${distance}-unit fielding travel from contact at eighty percent of catching speed`, function () {
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
      const flight = hit.flightEndMs - hit.contactMs
      expect(sampleHit(hit, hit.contactMs).fielder).deep.equals(
        hit.fielderStart
      )
      const half = sampleHit(hit, hit.contactMs + flight / 0.8 / 2)
      expect(half.fielder.z).closeTo(
        (hit.fielderStart.z + hit.arc.target.z) / 2,
        1e-8
      )
      const arrived = sampleHit(hit, hit.fielderEndMs)
      expect(arrived.fielder.z).closeTo(hit.arc.target.z, 1e-8)
      expect(arrived.visible).equals(false)
      expect(arrived.ball.z).equals(hit.arc.target.z)
      expect(sampleHit(hit, hit.fielderEndMs).running).equals(false)
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
  for (const outcome of [
    'Single',
    'Throw Out',
    'Ball Caught',
    'Error',
    'Batter Interference',
    'Home Run'
  ] as const)
    it(`separates landing and pickup for ${outcome}`, () => {
      let state = scoringReducer(initial(), { type: 'OUTCOME', outcome })
      state = scoringReducer(
        state,
        outcome === 'Home Run'
          ? { type: 'LANDING', point: { x: 25, z: -130 }, generation: 0 }
          : { type: 'FIELDER', id: 10, point: { x: 25, z: -75 }, generation: 0 }
      )
      state = scoringReducer(state, {
        type: 'TRAJECTORY',
        angle: 45,
        generation: 0
      })
      const hit = state.presentation!
      if (hit.kind !== 'hit') throw new Error('Expected hit')
      const target = hit.fielderTarget!
      const gap = (t: number): number => {
        const p = sampleHit(hit, t).fielder
        return Math.hypot(p.x - target.x, p.z - target.z)
      }
      const caught = outcome === 'Ball Caught'
      const noFielder = outcome === 'Home Run'
      expect(hit.durationMs - hit.flightEndMs).closeTo(
        caught || noFielder ? 0 : (hit.flightEndMs - hit.contactMs) * 0.25,
        1e-8
      )
      expect(hit.fielderStartMs).equals(hit.contactMs)
      const startDistance = gap(hit.contactMs)
      expect(
        gap(hit.contactMs + (hit.flightEndMs - hit.contactMs) / 2)
      ).closeTo(startDistance * (caught || noFielder ? 0.5 : 0.6), 1e-8)
      const landed = sampleHit(hit, hit.flightEndMs)
      expect(landed.ball.x).closeTo(hit.arc.target.x, 1e-8)
      expect(landed.ball.z).closeTo(hit.arc.target.z, 1e-8)
      if (!noFielder) {
        expect(gap(hit.flightEndMs)).satisfies((n: number) =>
          caught ? n < 1e-8 : n > 0
        )
        if (!caught) {
          expect(gap((hit.flightEndMs + hit.durationMs) / 2)).greaterThan(0)
          expect(
            sampleHit(hit, (hit.flightEndMs + hit.durationMs) / 2).ball
          ).deep.equals(landed.ball)
          expect(
            sampleHit(hit, (hit.flightEndMs + hit.durationMs) / 2).visible
          ).equals(true)
          expect(gap(hit.durationMs)).closeTo(0, 1e-8)
          expect(sampleHit(hit, hit.flightEndMs - 1).ball.z).not.equals(
            hit.arc.target.z
          )
        }
      }
      expect(sampleHit(hit, hit.durationMs).visible).equals(false)
    })
  it('keeps a stationary fielder and landed ball until the pickup boundary', () => {
    let state = scoringReducer(initial(), {
      type: 'OUTCOME',
      outcome: 'Single'
    })
    state = scoringReducer(state, {
      type: 'FIELDER',
      id: 10,
      point: { x: 0, z: -18.44 },
      generation: 0
    })
    state = scoringReducer(state, {
      type: 'TRAJECTORY',
      angle: 20,
      generation: 0
    })
    const hit = state.presentation!
    if (hit.kind !== 'hit') throw new Error('Expected hit')
    const sample = sampleHit(hit, hit.flightEndMs)
    expect(sample.fielder).deep.equals(hit.fielderStart)
    expect(sample.visible).equals(true)
    expect(sampleHit(hit, hit.durationMs).visible).equals(false)
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
