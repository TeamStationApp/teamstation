import { asObject, asString } from 'cleaners'
import type { Kysely } from 'kysely'

import { type Tool, toolSchema } from '../../common/scoring/actions'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { requireVisibleGame } from '../events/requireVisibleGame'

/**
 * What a dictation socket can be talking about.
 *
 * A `start` names a scope and a target. The scope says which tools the LLM is
 * offered and who may speak about the target; the route asks it before any of
 * the utterance's audio is read, on every `start`, so a socket opened while
 * looking at one game is not a capability for another. A later scope — game
 * setup, admin settings — is another entry here and touches neither the route
 * nor the client.
 */
export interface Scope {
  tools: readonly Tool[]
  /** Throws, an `HttpError` or a `TypeError`, unless the actor may speak about the target. */
  authorise: (
    db: Kysely<Database>,
    actor: Actor,
    target: Record<string, unknown>
  ) => Promise<void>
}

const asScoringTarget = asObject({ gameId: asString })

export const SCOPES: ReadonlyMap<string, Scope> = new Map([
  [
    'scoring',
    {
      tools: toolSchema(),
      authorise: async (db, actor, target) => {
        const { gameId } = asScoringTarget(target)
        await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
      }
    }
  ]
])
