import { expect } from 'chai'
import { describe, it } from 'mocha'

import type { ScoringAction } from '../../common/scoring/actions'
import { recordOf, replayPlays } from '../../common/scoring/gumbo'
import { ScoringSession } from '../../common/scoring/session'
import { setupOf } from '../../common/scoring/state'
import { MemoryStore } from '../../test/replayGameFixture'
import { after, F, game, TEAMS } from '../../test/scoringGames'
import { projectScoringGame } from './projection'

describe('projecting a game a stand-in played in (U13)', function () {
  it('keeps a stand-in’s position and changes only player ids', async () => {
    // The hosts field with nobody at short or first.
    const start = game()
    const setup = setupOf(start)
    setup.sides.home.defense.SS = null
    setup.sides.home.defense['1B'] = null
    const opening = after(start, { type: 'lineup', kind: 'roster', setup })
    const store = new MemoryStore()
    const session = ScoringSession.start(store, 'g1', opening)
    const actions: ScoringAction[] = [
      { type: 'ballInPlay', contact: 'swing', fielder: 'SS' },
      { type: 'result', eventType: 'field_out', outBy: 'throw' },
      {
        type: 'runnerMovement',
        runner: 1,
        to: '1B',
        out: true,
        fielders: ['SS', '1B']
      },
      { type: 'gameFlow', kind: 'closePlay' },
      { type: 'ballInPlay', contact: 'swing', fielder: F['3B'] },
      { type: 'result', eventType: 'field_out', outBy: 'throw' },
      {
        type: 'runnerMovement',
        runner: 2,
        to: '1B',
        out: true,
        fielders: [F['3B'], '1B']
      },
      { type: 'gameFlow', kind: 'closePlay' }
    ]
    for (const action of actions)
      expect(
        session.apply(action).problems,
        JSON.stringify(action)
      ).deep.equals([])
    await session.flush()
    const stored = store.storedForms()
    const before = structuredClone(stored)
    const merged = 300
    const projected = projectScoringGame(stored, id =>
      id === F['3B'] ? merged : id
    )
    expect(stored).deep.equals(before)
    const saved = projected.plays.flatMap(
      play => recordOf(play, TEAMS)?.actions ?? []
    )
    const plays = saved.filter(
      (action): action is Extract<ScoringAction, { type: 'runnerMovement' }> =>
        action.type === 'runnerMovement'
    )
    expect(plays.map(action => action.fielders)).deep.equals([
      ['SS', '1B'],
      [merged, '1B']
    ])
    expect(
      saved
        .filter(action => action.type === 'ballInPlay')
        .map(action => 'fielder' in action && action.fielder)
    ).deep.equals(['SS', merged])
    // The stored game still replays: the stand-ins credit nobody.
    const replayed = replayPlays(stored, {
      gamePk: 'g1',
      teams: TEAMS,
      setup: setupOf(start)
    })
    expect(replayed.problems).deep.equals([])
    const first = replayed.state.liveData.plays.allPlays[0]
    expect(first.runners[0].credits).deep.equals([
      { credit: 'f_assist', position: 'SS' },
      { credit: 'f_putout', position: '1B' }
    ])
  })
})
