import { asObject, asOptional, asString } from 'cleaners'
import type { Kysely } from 'kysely'

import { asLiteral } from '../../common/asLiteral'
import { forbidden } from '../../common/errors'
import { type Tool, toolSchema } from '../../common/scoring/actions'
import {
  type RosterTool,
  rosterToolSchema
} from '../../common/scoring/rosterCommands'
import { canScore, isHeadCoach, roleScopes } from '../access'
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
  /** Roster tools, offered beside `tools`. Absent means none. */
  rosterTools?: readonly RosterTool[]
  /**
   * The utterance ends at its transcript: the LLM is never asked, and the
   * socket takes the next `start` as soon as the words are sent.
   */
  transcriptOnly?: boolean
  /** Throws, an `HttpError` or a `TypeError`, unless the actor may speak about the target. */
  authorise: (
    db: Kysely<Database>,
    actor: Actor,
    target: Record<string, unknown>
  ) => Promise<void>
}

const asScoringTarget = asObject({ gameId: asString })
const asRosterTarget = asObject({
  gameId: asString,
  side: asOptional(asLiteral('away', 'home'))
})

/**
 * The roster sheet: a scorekeeper of either team, or the head coach of the
 * team that plays `side`. A coach names his side; a scorekeeper need not.
 */
async function authoriseRoster(
  db: Kysely<Database>,
  actor: Actor,
  target: Record<string, unknown>
): Promise<void> {
  const { gameId, side } = asRosterTarget(target)
  await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
  const game = await db
    .selectFrom('games')
    .select(['home_team_id', 'away_team_id'])
    .where('id', '=', gameId)
    .executeTakeFirstOrThrow()
  const roles = await roleScopes(db, actor.userId, actor.isAdmin)
  if (canScore(roles, game.home_team_id) || canScore(roles, game.away_team_id))
    return
  if (
    side != null &&
    isHeadCoach(roles, side === 'home' ? game.home_team_id : game.away_team_id)
  )
    return
  throw forbidden(
    "Only the team's head coach or a scorekeeper may change its lineup"
  )
}

export const SCOPES: ReadonlyMap<string, Scope> = new Map<string, Scope>([
  [
    'scoring',
    {
      // Substitutions are roster commands now; the screen still makes the
      // `lineup` actions when they are saved, but the model never does.
      tools: toolSchema().filter(tool => tool.name !== 'lineup'),
      rosterTools: rosterToolSchema(),
      authorise: async (db, actor, target) => {
        const { gameId } = asScoringTarget(target)
        await requireVisibleGame(db, actor.userId, actor.isAdmin, gameId)
      }
    }
  ],
  [
    'roster',
    { tools: [], rosterTools: rosterToolSchema(), authorise: authoriseRoster }
  ],
  [
    // Tess: what was said becomes the person's next chat message, and Tess
    // reads it with that person's own permissions. Any signed-in actor may
    // speak; the target is `{}`.
    'tess',
    { tools: [], transcriptOnly: true, authorise: async () => undefined }
  ]
])
