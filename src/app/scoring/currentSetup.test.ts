import { expect } from 'chai'
import { describe, it } from 'mocha'
import { PerspectiveCamera } from 'three'

import { asRosterEntry } from '../../common/api'
import type { ScoringAction } from '../../common/scoring/actions'
import {
  applyAction as applyStoredAction,
  ScoringSession
} from '../../common/scoring/session'
import { copyState, setupOf } from '../../common/scoring/state'
import { completeMotions } from '../../test/scoringHelpers'
import { fieldKey } from '../field/fieldKeyboard'
import { projectPlayerLabel } from '../field/playerPresentation'
import {
  assignDefender,
  battingWarningKey,
  defensiveRosterLabel,
  emptyDefensePlayers,
  lineupCountMessage,
  missingDefense,
  setupEditable,
  withRosterDetails
} from './currentSetup'
import { createDevelopmentSession } from './developmentSession'
import { gameFixture } from './isUnscoredGame.test'
import { addPlaceholderPlayers } from './placeholderPlayers'
import { initialScoringState, scoringReducer } from './scoringMachine'
import { memoryStore } from './scoringSource'
import { POSITIONS, type ScoringSessionState } from './scoringTypes'

const applyAction = (
  state: ScoringSessionState,
  action: ScoringAction
): ReturnType<typeof applyStoredAction> =>
  applyStoredAction(state, action, { requireCurrentSetup: true })
const game = (): ReturnType<typeof createDevelopmentSession> =>
  createDevelopmentSession(gameFixture, [], [])
describe('current scoring setup', function () {
  it('retains lineup acceptance through queued sentences and question answers', function () {
    const initial = game()
    initial.liveData.boxscore.teams.home.battingOrder.pop()
    const oldKey = battingWarningKey(initial)
    const half = applyStoredAction(initial, {
      type: 'gameFlow',
      kind: 'endHalf'
    }).state
    const state = initialScoringState(half)
    const actions = [{ type: 'pitch' as const, call: 'B' as const }]
    const queued = scoringReducer(
      {
        ...state,
        queuedDictation: [
          { transcript: 'Ball', actions, acceptedLineup: oldKey }
        ]
      },
      { type: 'PRESENTATION', enabled: false }
    )
    expect(queued.session.liveData.linescore.balls).equals(0)
    expect(queued.dictation?.problem?.message).includes(
      'Accept the current batting lineup'
    )
    const answered = scoringReducer(
      {
        ...state,
        dictationQuestion: {
          transcript: 'Ball',
          question: 'Confirm?',
          acceptedLineup: oldKey,
          options: [{ label: 'Ball', actions }]
        }
      },
      { type: 'DICTATION_ANSWER', option: 0 }
    )
    expect(answered.session.liveData.linescore.balls).equals(0)
    expect(answered.dictation?.problem?.message).includes(
      'Accept the current batting lineup'
    )
  })
  it('closes and persists the valid dictated third-out prefix before blocking next defense', function () {
    const initial = game()
    initial.liveData.boxscore.teams.away.defense.C = null
    let state = initialScoringState(initial)
    for (let i = 0; i < 8; i++)
      state = completeMotions(
        scoringReducer(state, { type: 'PITCH', kind: 'called' })
      )
    const next = completeMotions(
      scoringReducer(
        { ...state, presentationEnabled: false },
        {
          type: 'DICTATED',
          transcript: 'Strike then Ball',
          acceptedLineup: null,
          actions: [
            { type: 'pitch', call: 'C' },
            { type: 'pitch', call: 'B' }
          ]
        }
      )
    )
    expect(next.session.liveData.plays.allPlays).has.length(3)
    expect(next.session.liveData.linescore.isTopInning).equals(false)
    expect(next.session.liveData.linescore.balls).equals(0)
    expect(
      next.log.some(action => action.type === 'pitch' && action.call === 'B')
    ).equals(false)
    expect(next.dictation?.problem?.message).includes('C')
  })
  it('preserves an automatically closed third out before rejecting the next incomplete half pitch', async function () {
    const initial = game()
    const store = memoryStore()
    const session = ScoringSession.start(store, 'g1', initial, {
      requireCurrentSetup: true
    })
    const setup = setupOf(initial)
    setup.sides.away.defense.C = null
    let screen = scoringReducer(initialScoringState(initial), {
      type: 'ROSTER',
      draft: applyStoredAction(initial, {
        type: 'lineup',
        kind: 'roster',
        setup
      }).state
    })
    for (let i = 0; i < 9; i++)
      screen = completeMotions(
        scoringReducer(screen, { type: 'PITCH', kind: 'called' })
      )
    session.sync(screen.log)
    expect(session.state.liveData.linescore.isTopInning).equals(false)
    expect(session.state.liveData.plays.allPlays).has.length(3)
    expect(
      session.apply({ type: 'pitch', call: 'B' }).problems[0].message
    ).includes('C')
    expect(session.state.liveData.plays.allPlays).has.length(3)
    await session.flush()
    expect(store.games.get('g1')!.plays).has.length(3)
  })
  it('finishes an old partial-defense ball in play and gates the following appearance', async function () {
    const initial = game()
    const setup = setupOf(initial)
    const store = memoryStore()
    setup.sides.home.defense.C = null
    const legacy = ScoringSession.start(
      store,
      'g1',
      applyStoredAction(initial, { type: 'lineup', kind: 'roster', setup })
        .state
    )
    expect(
      legacy.apply({
        type: 'ballInPlay',
        contact: 'swing',
        fielder: initial.liveData.boxscore.teams.home.defense.RF!,
        location: { x: 20, z: -60 },
        launchAngle: 15
      }).problems
    ).deep.equals([])
    await legacy.flush()
    const live = await ScoringSession.open(
      store,
      'g1',
      { gamePk: 'g1', teams: initial.gameData.teams, setup: setupOf(initial) },
      { requireCurrentSetup: true }
    )
    expect(setupEditable(initialScoringState(live.state))).equals(false)
    expect(
      live.apply({ type: 'result', eventType: 'single' }).problems
    ).deep.equals([])
    expect(
      live.apply({ type: 'gameFlow', kind: 'closePlay' }).problems
    ).deep.equals([])
    expect(live.state.liveData.plays.allPlays).has.length(1)
    expect(
      live.apply({ type: 'pitch', call: 'B' }).problems[0].message
    ).includes('C')
    await live.flush()
    expect(store.games.get('g1')!.plays).has.length(1)
  })
  it('blocks the next pitch after two balls and a defender move, while preserving the count', function () {
    const initial = game()
    let pitched = applyAction(initial, { type: 'pitch', call: 'B' }).state
    pitched = applyAction(pitched, { type: 'pitch', call: 'B' }).state
    const moved = assignDefender(
      pitched,
      'P',
      pitched.liveData.boxscore.teams.home.defense.C!
    )
    const changed = applyAction(pitched, {
      type: 'lineup',
      kind: 'roster',
      setup: setupOf(moved)
    })
    expect(changed.problems).deep.equals([])
    const next = applyAction(changed.state, { type: 'pitch', call: 'B' })
    expect(next.problems[0].message).includes('C')
    expect(next.state.liveData.linescore.balls).equals(2)
  })
  it('reports current setup problems consistently for dictation, including a missing pitcher', function () {
    for (const slot of ['C', 'P'] as const) {
      const initial = game()
      const setup = setupOf(initial)
      setup.sides.home.defense[slot] = null
      const missing = applyStoredAction(initial, {
        type: 'lineup',
        kind: 'roster',
        setup
      }).state
      const state = initialScoringState(missing)
      const next = scoringReducer(state, {
        type: 'DICTATED',
        transcript: 'Ball',
        actions: [{ type: 'pitch', call: 'B' }]
      })
      expect(next.dictation?.problem?.message).equals(
        `Missing defensive positions: ${slot}`
      )
      expect(next.session.liveData.linescore.balls).equals(0)
    }
  })
  it('moves defenders uniquely, keeps the full roster and leaves the original untouched', function () {
    const original = game()
    const { P: pitcher, C: catcher } =
      original.liveData.boxscore.teams.home.defense
    const moved = assignDefender(original, 'P', catcher!)
    expect(moved.liveData.boxscore.teams.home.defense.P).equals(catcher)
    expect(missingDefense(moved)).deep.equals(['C'])
    expect(original.liveData.boxscore.teams.home.defense.P).equals(pitcher)
    expect(JSON.stringify(assignDefender(original, 'P', -1))).equals(
      JSON.stringify(original)
    )
    expect(JSON.stringify(assignDefender(original, 'P', pitcher!))).equals(
      JSON.stringify(original)
    )
    expect(moved.liveData.boxscore.teams.home.players).deep.equals(
      original.liveData.boxscore.teams.home.players
    )
  })
  it('formats actual lineup counts, stable acceptance keys and roster names', function () {
    expect(lineupCountMessage(0)).equals('No players in lineup')
    expect(lineupCountMessage(1)).equals('Only one player in lineup')
    expect(lineupCountMessage(8)).equals('Only eight players in lineup')
    expect(lineupCountMessage(10)).equals('Only 10 players in lineup')
    const session = game()
    const player = session.gameData.players[1]
    expect(
      defensiveRosterLabel({
        ...player,
        fullName: 'Mookie Betts',
        jersey: '00'
      })
    ).equals('#00 Mookie B')
    expect(
      defensiveRosterLabel({
        ...player,
        fullName: '  Mike  Trout ',
        jersey: ''
      })
    ).equals('Mike T')
    expect(
      defensiveRosterLabel({ ...player, fullName: 'Shohei', jersey: '7' })
    ).equals('#7 Shohei')
    expect(
      defensiveRosterLabel({ ...player, fullName: '', jersey: '7' })
    ).equals('#7 ?')
    const key = battingWarningKey(session)
    session.liveData.boxscore.teams.home.battingOrder = []
    expect(battingWarningKey(session)).equals(key)
    session.liveData.linescore.isTopInning = false
    expect(battingWarningKey(session)).not.equals(key)
  })
  it('displays current team jerseys without changing saved setup or placeholders', function () {
    const original = game()
    const player = original.gameData.players[1]
    player.local = false
    player.userId = 101
    player.fullName = 'Mookie B'
    player.jersey = ''
    const before = JSON.stringify(original)
    const entry = asRosterEntry({
      userId: 101,
      shortName: 'Mookie B',
      jersey: '00',
      positions: [],
      isPlayer: true,
      role: 'member'
    })
    const otherTeam = original.gameData.teams.home.id
    expect(withRosterDetails(original, { [otherTeam]: [entry] })).equals(
      original
    )
    const shown = withRosterDetails(original, { [player.teamId]: [entry] })
    expect(defensiveRosterLabel(shown.gameData.players[1])).equals(
      '#00 Mookie B'
    )
    expect(shown.gameData.players[2]).equals(original.gameData.players[2])
    expect(shown.liveData).equals(original.liveData)
    expect(JSON.stringify(original)).equals(before)
    const withoutNumber = withRosterDetails(shown, {
      [player.teamId]: [{ ...entry, jersey: null }]
    })
    expect(defensiveRosterLabel(withoutNumber.gameData.players[1])).equals(
      'Mookie B'
    )
    expect(withRosterDetails(original, {})).equals(original)
  })
  it('uses all nine centered square placeholders with visible edge bounds and keyboard setup taps', function () {
    const session = game()
    for (const slot of POSITIONS)
      session.liveData.boxscore.teams.home.defense[slot] = null
    const players = emptyDefensePlayers(session)
    expect(players.map(player => player.label)).deep.equals(POSITIONS)
    const camera = new PerspectiveCamera(43, 390 / 844, 0.1, 1000)
    camera.position.set(0, 100, 114)
    camera.lookAt(0, 0, -25)
    camera.updateMatrixWorld()
    for (const player of players) {
      const plate = projectPlayerLabel(player, camera, 390, 844)
      expect([
        plate.width,
        plate.height,
        plate.anchorX,
        plate.anchorY
      ]).deep.equals([48, 48, 0.5, 0.5])
      expect(plate.x).within(26, 364)
      expect(plate.y).within(26, 818)
      expect(plate.emptyPosition).equals(true)
    }
    const tapped: string[] = []
    const props = {
      players,
      selected: players[0].id,
      onSelect: () => undefined,
      view: 'home' as const,
      zoom: 1,
      tapIds: players.map(player => player.id),
      onPlayerTap: (id: string) => tapped.push(id)
    }
    expect(fieldKey(props, ' ')).equals(true)
    expect(fieldKey(props, 'Enter')).equals(true)
    expect(tapped).deep.equals(['empty-P', 'empty-P'])
    expect(players[0].keyboardOrigin).equals(undefined)
  })
  it('edits only at rest and keeps active-play interactions intact', function () {
    const state = initialScoringState(game())
    expect(setupEditable(state)).equals(true)
    expect(
      setupEditable({ ...state, session: { ...state.session, final: true } })
    ).equals(false)
    expect(setupEditable({ ...state, phase: 'awaitingBatter' })).equals(true)
    expect(setupEditable({ ...state, phase: 'locateFielder' })).equals(false)
    const begun = scoringReducer(state, { type: 'OUTCOME', outcome: 'Single' })
    expect(setupEditable(begun)).equals(false)
    expect(scoringReducer(begun, { type: 'ROSTER', draft: game() })).equals(
      begun
    )
  })
  it('persists a temporarily vacated pitcher, blocks pitching, restores setup and Undo', async function () {
    const initial = game()
    const store = memoryStore()
    const session = ScoringSession.start(store, 'g1', initial, {
      requireCurrentSetup: true
    })
    const pitcher = initial.liveData.boxscore.teams.home.defense.P!
    const moved = assignDefender(initial, 'C', pitcher)
    expect(
      session.apply({ type: 'lineup', kind: 'roster', setup: setupOf(moved) })
        .problems
    ).deep.equals([])
    expect(
      session.apply({ type: 'pitch', call: 'B' }).problems[0].message
    ).includes('P')
    await session.flush()
    const opened = await ScoringSession.open(store, 'g1', {
      gamePk: 'g1',
      teams: initial.gameData.teams,
      setup: setupOf(initial)
    })
    expect(missingDefense(opened.state)).deep.equals(['P'])
    const fixed = assignDefender(
      opened.state,
      'P',
      initial.liveData.boxscore.teams.home.defense.C!
    )
    expect(
      opened.apply({ type: 'lineup', kind: 'roster', setup: setupOf(fixed) })
        .problems
    ).deep.equals([])
    expect(opened.apply({ type: 'pitch', call: 'B' }).problems).deep.equals([])
    const screen = initialScoringState(initial)
    const next = scoringReducer(screen, { type: 'ROSTER', draft: moved })
    expect(scoringReducer(next, { type: 'UNDO' }).session).deep.equals(
      screen.session
    )
  })
  it('accepts zero current batting order safely and reopens an appearance after a batter is added', async function () {
    const initial = game()
    const setup = setupOf(initial)
    setup.sides.away.battingOrder = []
    const empty = applyAction(initial, {
      type: 'lineup',
      kind: 'roster',
      setup
    })
    expect(empty.problems).deep.equals([])
    const pitched = applyAction(initial, { type: 'pitch', call: 'B' }).state
    expect(
      applyAction(pitched, { type: 'lineup', kind: 'roster', setup })
        .problems[0].message
    ).includes('Finish the at-bat')
    expect(empty.state.liveData.plays.currentPlay).equals(null)
    expect(
      applyAction(empty.state, { type: 'pitch', call: 'B' }).problems[0].message
    ).equals('No players in lineup')
    const store = memoryStore()
    const session = ScoringSession.start(store, 'g1', initial)
    session.apply({ type: 'lineup', kind: 'roster', setup })
    await session.flush()
    const reopened = await ScoringSession.open(store, 'g1', {
      gamePk: 'g1',
      teams: initial.gameData.teams,
      setup: setupOf(initial)
    })
    expect(
      reopened.state.liveData.boxscore.teams.away.battingOrder
    ).deep.equals([])
    setup.sides.away.battingOrder = [1]
    const restored = applyAction(reopened.state, {
      type: 'lineup',
      kind: 'roster',
      setup
    })
    expect(restored.problems).deep.equals([])
    expect(restored.state.liveData.plays.currentPlay?.matchup.batter.id).equals(
      1
    )
    expect(
      applyAction(restored.state, { type: 'pitch', call: 'B' }).problems
    ).deep.equals([])
  })
  it('does not evaluate next-half readiness until that half becomes current', function () {
    const original = game()
    const draft = copyState(original)
    draft.liveData.boxscore.teams.home.battingOrder = []
    draft.liveData.boxscore.teams.away.defense.C = null
    const changed = applyAction(original, {
      type: 'lineup',
      kind: 'roster',
      setup: setupOf(draft)
    })
    expect(changed.problems).deep.equals([])
    expect(
      applyAction(changed.state, { type: 'pitch', call: 'B' }).problems
    ).deep.equals([])
    const half = applyAction(changed.state, {
      type: 'gameFlow',
      kind: 'endHalf'
    })
    expect(half.problems).deep.equals([])
    expect(missingDefense(half.state)).deep.equals(['C'])
    expect(
      applyAction(half.state, { type: 'pitch', call: 'B' }).problems[0].message
    ).includes('C')
  })
  it('preserves awaiting-batter state on defense-only edits and placeholder creation, including Undo', function () {
    const initial = game()
    initial.liveData.boxscore.teams.away.battingOrder = [1]
    initial.liveData.linescore.offense.first = {
      id: 1,
      fullName: initial.gameData.players[1].fullName
    }
    initial.awaitingBatter = {
      teamId: initial.gameData.teams.away.id,
      dueIndex: 0,
      duePlayerId: 1
    }
    initial.liveData.plays.currentPlay = null
    initial.liveData.linescore.offense.batter = null
    const state = initialScoringState(initial)
    const draft = assignDefender(
      initial,
      'C',
      initial.liveData.boxscore.teams.home.defense.P!
    )
    addPlaceholderPlayers(draft, 'home', 2)
    const next = scoringReducer(state, { type: 'ROSTER', draft })
    expect(next.phase).equals('awaitingBatter')
    expect(next.session.awaitingBatter).deep.equals(initial.awaitingBatter)
    expect(next.session.liveData.plays.currentPlay).equals(null)
    expect(next.session.liveData.boxscore.teams.home.players).has.length(11)
    expect(scoringReducer(next, { type: 'UNDO' }).session).deep.equals(initial)
    const unsafe = copyState(draft)
    unsafe.liveData.boxscore.teams.away.battingOrder.push(2)
    expect(
      applyAction(initial, {
        type: 'lineup',
        kind: 'roster',
        setup: setupOf(unsafe)
      }).problems
    ).has.length(1)
  })
})
