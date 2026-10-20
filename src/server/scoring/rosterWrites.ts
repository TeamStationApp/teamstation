import { isDeepStrictEqual } from 'node:util'

import { conflict } from '../../common/errors'
import { applyAction } from '../../common/scoring/apply'
import { recordOf, replayPlays } from '../../common/scoring/gumbo'
import { validateRoster } from '../../common/scoring/lineup'
import type { SessionContext, StoredGame } from '../../common/scoring/session'

/**
 * Replay can preserve duplicate placements created by an account merge.
 * A newly submitted lineup action still cannot create an extra occurrence.
 */
export function assertAuthoredRosters(
  previous: StoredGame,
  next: StoredGame,
  context: SessionContext
): void {
  const oldRecords = [...previous.plays, previous.currentPlay].flatMap(play => {
    const record = recordOf(play)
    return record == null ? [] : [record]
  })
  const oldActions = oldRecords.flatMap(record => record.actions)
  const priorSides = oldRecords.map(record => record.setupBefore.sides)
  for (const action of oldActions)
    if (action.type === 'lineup' && action.setup != null)
      priorSides.push(action.setup.sides)
  for (const play of [...next.plays, next.currentPlay]) {
    const record = recordOf(play)
    if (record == null) continue
    const draft = {
      gameData: { teams: context.teams, players: record.setupBefore.players },
      liveData: { boxscore: { teams: record.setupBefore.sides } }
    }
    if (
      validateRoster(draft, true) != null &&
      !priorSides.some(sides => validateRoster(draft, true, sides) == null)
    )
      throw conflict(
        'A saved setup cannot introduce duplicate lineup placements'
      )
  }
  replayPlays(next, context, undefined, (state, action) => {
    if (
      action.type !== 'lineup' ||
      oldActions.some(old => isDeepStrictEqual(old, action))
    )
      return
    const problem = applyAction(state, action).problems[0]
    if (problem != null) throw conflict(problem.message)
  })
}
