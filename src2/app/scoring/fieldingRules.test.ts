import { expect } from 'chai'
import { describe, it } from 'mocha'

import { completeMotions } from '../../test/scoringHelpers'
import type { BallArcState } from '../field/ballArcModel'
import { fieldingLocation, isFairLocation } from '../field/fieldingLocation'
import { fieldKey } from '../field/fieldKeyboard'
import { createPlayers } from '../field/fieldModel'
import type { FieldCanvasProps } from '../field/fieldTypes'
import { homeRunKind, homeRunLanding } from '../field/stadiumBoundary'
import { initialHitTarget } from '../field/trajectoryGuide'
import { battedBallField, fieldStageInstruction } from './battedBallField'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { asScoringPlay } from './scoringContract'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { playerRef } from './scoringSelectors'
const initial = (): ReturnType<typeof initialScoringState> =>
  initialScoringState(createDevelopmentSession(gameFixture, [], []))
describe('outcome-specific fielding', function () {
  it('uses the current batting side for home-run default guidance and restores it with Undo', function () {
    for (const code of ['L', 'R'] as const) {
      let state = initial()
      state.session.liveData.plays.currentPlay!.matchup.batSide.code = code
      state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Home Run' })
      expect(state.pendingPlay!.location).deep.equals(initialHitTarget(code))
      state = scoringReducer(state, { type: 'UNDO' })
      expect(
        state.session.liveData.plays.currentPlay!.matchup.batSide.code
      ).equals(code)
    }
  })
  it('coordinates the rendered landing, placement and trajectory phases with reducer events', function () {
    let state = initial()
    let landing: BallArcState | null = null
    let angle = 45
    const field = (blocked = false): ReturnType<typeof battedBallField> =>
      battedBallField(state, angle, landing, blocked, {
        dispatch: event => {
          state = scoringReducer(state, event)
        },
        landing: arc => {
          landing = arc
        },
        angle: value => {
          angle = value
        }
      })
    expect(fieldStageInstruction(state)).equals(undefined)
    expect(field().arc).equals(null)
    expect(field().arcMode).equals('off')
    field().onArcChange!({ target: { x: 0, z: -20 }, angle: -90 })
    expect(angle).equals(-45)
    state = scoringReducer(state, { type: 'OUTCOME', outcome: 'Home Run' })
    expect(fieldStageInstruction(state)).equals('Drag where the ball was hit')
    expect(field().arc!.target).deep.equals(initialHitTarget('R'))
    expect(field().arcMode).equals('aim')
    expect(field(true).arcMode).equals('off')
    field().onArcChange!({
      target: { x: 0, z: -130 },
      angle: 45,
      landingHeight: 4
    })
    expect(field().arc!.target.z).equals(-130)
    field().onLandingAccepted!(field().arc!, state.generation)
    expect(fieldStageInstruction(state)).equals(
      'Drag up and down for ball trajectory.'
    )
    expect(field().arcMode).equals('edit')
    field().onArcChange!({ target: { x: 0, z: -130 }, angle: -45 })
    expect(angle).equals(10)
    expect(field().arc!.angle).equals(10)
    state = scoringReducer(initial(), { type: 'OUTCOME', outcome: 'Single' })
    expect(fieldStageInstruction(state)).equals(
      'Tap or drag a player to where the ball was fielded.'
    )
    expect(field().acceptDefenderTap).equals(true)
    expect(field().constrainPlacement!({ x: 40, z: -10 })).deep.equals({
      x: 10,
      z: -10
    })
    state = { ...state, phase: 'chooseThrower' }
    expect(fieldStageInstruction(state)).contains('Tap or drag')
    state = { ...state, phase: 'chooseDefender' }
    expect(fieldStageInstruction(state)).contains('finish the out')
    expect(field().acceptDefenderTap).equals(true)
    state = {
      ...state,
      runnerAction: {
        playerId: 1,
        from: 0,
        to: 1,
        origin: 'current',
        returnPhase: 'resolveBatter',
        purpose: 'errorAttribution'
      }
    }
    expect(fieldStageInstruction(state)).contains('committed the error')
  })
  for (const outcome of [
    'Single',
    'Double',
    'Triple',
    'Error',
    "Fielder's Choice"
  ] as const)
    it(`keeps ${outcome} on the fair surface and includes foul lines`, function () {
      const start = initial()
      start.session.liveData.linescore.offense.first = playerRef(
        start.session,
        6
      )
      const state = scoringReducer(start, { type: 'OUTCOME', outcome })
      for (const point of [
        { x: 30, z: -10 },
        { x: -100, z: -20 },
        { x: 300, z: -300 },
        { x: 5, z: 5 },
        { x: 0, z: -115 }
      ]) {
        const next = scoringReducer(state, {
          type: 'FIELDER',
          id: 10,
          point,
          generation: state.generation
        })
        expect(isFairLocation(next.pendingPlay!.location!)).equals(true)
        expect(
          Math.hypot(...Object.values(next.pendingPlay!.location!))
        ).at.most(118.000001)
      }
      expect(fieldingLocation(outcome, { x: 25, z: -25 })).deep.equals({
        x: 25,
        z: -25
      })
    })
  for (const foul of [false, true])
    it(`records a ${foul ? 'foul' : 'fair'} caught ball as one out with round-trip metadata`, function () {
      let state = scoringReducer(initial(), {
        type: 'OUTCOME',
        outcome: 'Ball Caught'
      })
      state = scoringReducer(state, {
        type: 'FIELDER',
        id: 10,
        point: { x: foul ? 30 : 0, z: -20 },
        generation: 0
      })
      state = scoringReducer(state, {
        type: 'TRAJECTORY',
        angle: -45,
        generation: 0
      })
      const play = asScoringPlay(state.session.liveData.plays.currentPlay)
      expect(play.source.gamestation.foulCaught).equals(foul ? true : undefined)
      expect(play.hitData!.launchAngle).equals(10)
      expect(state.session.liveData.linescore.outs).equals(1)
      expect(state.session.liveData.linescore.teams.away.hits).equals(0)
      expect(play.playEvents.filter(e => e.isPitch)).length(1)
      if (foul) expect(play.result.description).equals('Foul ball caught')
      state = scoringReducer(state, { type: 'UNDO' })
      expect(state.session.liveData.linescore.outs).equals(0)
    })
  it('requires a distinct landing event for home runs and tolerates absent defense', function () {
    let state = scoringReducer(initial(), {
      type: 'OUTCOME',
      outcome: 'Home Run'
    })
    expect(state.phase).equals('locateLanding')
    expect(state.pendingPlay!.location).deep.equals(initialHitTarget('R'))
    expect(
      scoringReducer(state, {
        type: 'FIELDER',
        id: 10,
        point: { x: 0, z: -70 },
        generation: 0
      })
    ).equals(state)
    expect(
      scoringReducer(state, { type: 'TRAJECTORY', angle: 45, generation: 0 })
    ).equals(state)
    for (const event of [
      { type: 'LANDING' as const, point: { x: NaN, z: -70 }, generation: 0 },
      { type: 'LANDING' as const, point: { x: 0, z: -70 }, generation: 99 },
      {
        type: 'LANDING' as const,
        point: { x: 0, z: -70 },
        generation: 0,
        landingHeight: Infinity
      }
    ])
      expect(scoringReducer(state, event)).equals(state)
    for (const position of Object.keys(
      state.session.liveData.linescore.defense
    ))
      state.session.liveData.linescore.defense[position as 'P'] = null
    state.presentationEnabled = true
    state = scoringReducer(state, {
      type: 'LANDING',
      point: { x: 0, z: -70 },
      generation: 0
    })
    expect(state.pendingPlay!.fielder).equals(undefined)
    state = scoringReducer(state, {
      type: 'TRAJECTORY',
      angle: -45,
      generation: 0
    })
    expect(state.presentation!.kind).equals('hit')
    expect(state.session.liveData.plays.currentPlay!.hitData!.fielder).equals(
      undefined
    )
    asScoringPlay(state.session.liveData.plays.currentPlay)
  })
  it('uses fair stands without inventing a fielding credit and restores landing on Undo', function () {
    let state = scoringReducer(initial(), {
      type: 'OUTCOME',
      outcome: 'Home Run'
    })
    state = scoringReducer(state, {
      type: 'LANDING',
      point: { x: 0, z: -130 },
      landingHeight: 8,
      generation: 0
    })
    expect(state.pendingPlay!.fielder).equals(undefined)
    expect(state.pendingPlay!.landingHeight).equals(8)
    const located = state
    state = scoringReducer(state, {
      type: 'TRAJECTORY',
      angle: -45,
      generation: 0
    })
    expect(
      state.session.liveData.plays.currentPlay!.hitData!.launchAngle
    ).equals(10)
    expect(state.session.liveData.plays.currentPlay!.hitData!.fielder).equals(
      undefined
    )
    state = scoringReducer(located, { type: 'UNDO' })
    expect(state.phase).equals('locateLanding')
    expect(
      scoringReducer(state, {
        type: 'LANDING',
        point: { x: 0, z: -130 },
        generation: 0
      })
    ).equals(state)
    expect(isFairLocation(homeRunLanding({ x: 130, z: 0 }))).equals(true)
    expect(homeRunKind(homeRunLanding({ x: 130, z: 0 }))).equals('out-of-park')
  })
  for (const receivers of [[], [12, 13, 10]])
    it(`allows interference with ${receivers.length} receivers and retires only the batter`, function () {
      let state = initial()
      state.session.liveData.linescore.offense.second = playerRef(
        state.session,
        6
      )
      state = scoringReducer(state, {
        type: 'OUTCOME',
        outcome: 'Batter Interference'
      })
      state = scoringReducer(state, {
        type: 'FIELDER',
        id: 10,
        point: { x: 0, z: -20 },
        generation: 0
      })
      state = scoringReducer(state, {
        type: 'TRAJECTORY',
        angle: 20,
        generation: 0
      })
      expect(state.phase).equals('chooseDefender')
      for (const id of receivers)
        state = scoringReducer(state, {
          type: 'DEFENDER',
          id,
          point: { x: id, z: -30 },
          generation: 0
        })
      expect(state.session.liveData.linescore.outs).equals(0)
      state = completeMotions(
        scoringReducer(state, { type: 'DEFENDER', generation: 0 })
      )
      expect(state.session.liveData.linescore.outs).equals(1)
      expect(state.session.liveData.linescore.offense.second!.id).equals(6)
      expect(
        state.session.liveData.plays
          .currentPlay!.source.gamestation.runnerActions!.at(-1)!
          .defensiveRoute!.map(h => h.player.id)
      ).deep.equals([10, ...receivers])
      expect(state.session.liveData.plays.currentPlay!.result.event).equals(
        'Batter Interference'
      )
    })
  it('aims landing independently from trajectory and clamps keyboard field placements', function () {
    const props: FieldCanvasProps = {
      players: createPlayers(),
      selected: '',
      onSelect: id => {
        props.selected = id
      },
      view: 'home',
      zoom: 1,
      homeRunPlacement: true,
      arcMode: 'aim',
      arc: { target: { x: 0, z: -60 }, angle: 45 },
      interaction: {
        generation: 4,
        selectableIds: [],
        gestures: ['trajectory']
      },
      onArcChange: arc => {
        props.arc = arc
      }
    }
    let accepted = 0
    props.onLandingAccepted = (arc, generation) => {
      expect(generation).equals(4)
      expect(arc.angle).equals(45)
      accepted++
    }
    for (const key of [' ', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'])
      expect(fieldKey(props, key)).equals(true)
    expect(fieldKey(props, 'x')).equals(false)
    fieldKey(props, 'Enter')
    expect(accepted).equals(1)
    props.arcMode = 'off'
    props.interaction!.gestures = ['place']
    props.interaction!.selectableIds = ['P']
    props.constrainPlacement = p => fieldingLocation('Single', p)
    fieldKey(props, ' ')
    for (let i = 0; i < 30; i++) fieldKey(props, 'ArrowRight')
    expect(isFairLocation(props.players[0].target)).equals(true)
    fieldKey(props, 'Enter')
  })
})
