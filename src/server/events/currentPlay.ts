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
 *
 * It comes in two steps. Everything the fold reads (the replay context:
 * teams, rosters, players) is read now, with `db`, as a caller holding a
 * game row reads it under that lock; the replay it answers reads nothing,
 * so the caller runs it once the lock is let go.
 */
export async function pregameFold(
  db: Kysely<Database>,
  gameId: string,
  game: { home_team_id: string; away_team_id: string; currentPlay: unknown },
  resolved: StoredGame
): Promise<() => Promise<CurrentPlay | null>> {
  const asStored = async (): Promise<CurrentPlay | null> => resolved.currentPlay
  if (
    game.currentPlay != null ||
    resolved.plays.length > 0 ||
    resolved.currentPlay == null
  )
    return asStored
  let context: Awaited<ReturnType<typeof contextOf>>
  try {
    context = await contextOf(db, gameId, game, resolved)
  } catch {
    return asStored
  }
  if (context == null) return asStored
  return async () => {
    try {
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
