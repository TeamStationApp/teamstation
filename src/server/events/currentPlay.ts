import type { Kysely } from 'kysely'

import type { CurrentPlay } from '../../common/gumboPlay'
import {
  type EventStore,
  ScoringSession,
  type StoredGame
} from '../../common/scoring/session'
import type { Database } from '../db/database'
import { contextOf } from '../scoring/replayContext'

/**
 * The at-bat in progress a reader is answered. Before the first pitch the
 * game stores only its pregame lineups (`atBatOf` gives them as a shell);
 * a reader gets them folded into a Gumbo current play, as the scoring screen
 * folds them: the away leadoff against the home pitcher, the count and the
 * tag targets. The fold is never stored, and digests stay of what is. Any
 * other time, and for a pregame that does not replay, it is the at-bat as
 * `resolved` holds it: the game's stored plays and at-bat, their accounts
 * resolved (`resolveScoringGame`).
 */
export async function gameCurrentPlay(
  db: Kysely<Database>,
  gameId: string,
  game: { home_team_id: string; away_team_id: string; currentPlay: unknown },
  resolved: StoredGame
): Promise<CurrentPlay | null> {
  if (
    game.currentPlay != null ||
    resolved.plays.length > 0 ||
    resolved.currentPlay == null
  )
    return resolved.currentPlay
  try {
    const context = await contextOf(db, gameId, game, resolved)
    if (context == null) return resolved.currentPlay
    const session = await ScoringSession.open(
      readOnlyStore(resolved),
      gameId,
      context
    )
    return session.picture().current ?? resolved.currentPlay
  } catch {
    return resolved.currentPlay
  }
}

/** A store that reads `stored` and refuses to save: a reader's session. */
export function readOnlyStore(stored: StoredGame): EventStore {
  return {
    load: async () => stored,
    save: async () => {
      throw new Error('A reader saves nothing')
    }
  }
}
