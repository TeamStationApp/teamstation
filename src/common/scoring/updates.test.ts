import { expect } from 'chai'
import { describe, it } from 'mocha'

import { game } from '../../test/scoringGames'
import type { CurrentPlay } from '../gumboPlay'
import type { ScoringAction } from './actions'
import { applyAction } from './apply'
import { currentDocumentOf } from './document'
import { setupOf } from './state'
import {
  scoringActionLine,
  scoringUpdateLines,
  storedScoringUpdates
} from './updates'

function document(actions: ScoringAction[]): CurrentPlay {
  const before = game()
  let state = before
  for (const action of actions) state = applyAction(state, action).state
  return currentDocumentOf(state, state.liveData.plays.currentPlay, {
    setupBefore: setupOf(before),
    actions
  })
}
describe('accepted scoring update descriptions', () => {
  const ball: ScoringAction = { type: 'pitch', call: 'B' }
  const strike: ScoringAction = { type: 'pitch', call: 'C' }
  it('describes only the accepted difference and explicitly names Undo', () => {
    const first = document([ball])
    const second = document([ball, strike])
    expect(scoringUpdateLines([first], [second])).deep.equals([
      'Top 1: Called strike'
    ])
    expect(scoringUpdateLines([second], [first])).deep.equals([
      'Undo — Top 1: Called strike'
    ])
    expect(scoringUpdateLines([second], [document([ball, ball])])).deep.equals([
      'Undo — Top 1: Called strike',
      'Top 1: Ball'
    ])
    expect(scoringUpdateLines([first], [first])).deep.equals([])
    expect(scoringUpdateLines([null], [null])).deep.equals([])
  })
  it('uses the reopened current play instead of its retained completed record', () => {
    const first = document([ball])
    const second = document([ball, strike])
    expect(scoringUpdateLines([second], [second, first])).deep.equals([
      'Undo — Top 1: Called strike'
    ])
  })
  it('omits automatic closure and coach lineup operations', () => {
    expect(scoringActionLine({ type: 'gameFlow', kind: 'closePlay' })).equals(
      undefined
    )
    expect(
      scoringActionLine({
        type: 'lineup',
        kind: 'roster',
        setup: setupOf(game())
      })
    ).equals(undefined)
  })
  it('describes the varied scoring actions without persisting player names', () => {
    const actions: ScoringAction[] = [
      { type: 'pitch', call: 'S' },
      { type: 'pitch', call: 'F' },
      { type: 'pitch', call: 'T' },
      { type: 'pitch', call: 'L' },
      {
        type: 'ballInPlay',
        contact: 'swing',
        trajectory: 'fly_ball',
        direction: 'center'
      },
      { type: 'ballInPlay', contact: 'bunt' },
      { type: 'result', eventType: 'fielders_choice' },
      { type: 'result', eventType: 'field_out', outBy: 'catch' },
      { type: 'runnerMovement', runner: 1, to: '2B' },
      {
        type: 'runnerMovement',
        runner: 1,
        to: '3B',
        out: true,
        reason: 'Tag Out'
      },
      { type: 'baseRunning', runner: 1, kind: 'steal', to: '2B' },
      { type: 'baseRunning', runner: 1, kind: 'steal' },
      { type: 'batteryEvent', kind: 'wild_pitch' },
      { type: 'fieldingPlay', fielders: [] },
      { type: 'fieldingPlay', fielders: [], error: 14 },
      { type: 'gameFlow', kind: 'endGame' }
    ]
    for (const action of actions)
      expect(scoringActionLine(action)).a('string').and.not.equals('')
  })
  it('bounds a large rewrite and reads legacy absence without inventing an author', () => {
    const many = document(Array.from({ length: 110 }, () => ball))
    expect(scoringUpdateLines([], [many])).length(100)
    expect(scoringUpdateLines([], [many]).at(-1)).equals(
      '11 more scoring changes'
    )
    expect(storedScoringUpdates(null)).deep.equals([])
    expect(storedScoringUpdates({})).deep.equals([])
    const update = {
      id: 'accepted',
      sequence: 1,
      userId: 'usr_scorer',
      name: 'Mike T.',
      lines: ['Ball']
    }
    const { name: _name, ...stored } = update
    expect(storedScoringUpdates({ updates: [update] })).deep.equals([stored])
  })
})
