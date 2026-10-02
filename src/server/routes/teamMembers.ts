import { Router } from 'express'
import type { Kysely } from 'kysely'

import { forbidden, notFound, unauthorized } from '../../common/errors'
import { asTeamPlayersBody } from '../../common/teamMembers'
import {
  adminScopes,
  canManageTeam,
  canSeeTeam,
  visibleScopes
} from '../access'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { cleanBody } from '../jsonBody'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { addPlayers } from '../teams/addPlayers'

/**
 * A team's people, added by the ids another system knows them by.
 *
 * Only an administrator of the team may call these: one set on the team, on
 * its season or on its league, its owner or manager, or a site
 * administrator. A team the caller can neither see nor administer answers
 * 404, so probing cannot reveal that it exists; one they can see but not
 * administer, 403. Somebody another system's id already names is added to
 * the team wherever else they are, as adding a person by address is.
 */
export function teamMemberRoutes(db: Kysely<Database>): Router {
  const router = Router()

  /** 404 or 403 unless the caller may manage the team. */
  const mustManage = async (actor: Actor, teamId: string): Promise<void> => {
    const team = await db
      .selectFrom('teams')
      .select(['id'])
      .where('id', '=', teamId)
      .executeTakeFirst()
    if (team == null) throw notFound()
    const admin = await adminScopes(db, actor.userId, actor.isAdmin)
    if (canManageTeam(admin, teamId)) return
    const seen = await visibleScopes(db, actor.userId, actor.isAdmin)
    if (!canSeeTeam(seen, teamId)) throw notFound()
    throw forbidden('Only an administrator of this team may add its people')
  }

  /**
   * Players, by external id: the user holding the id, or a new one who
   * cannot sign in, made a player of the team.
   */
  router.post(
    '/teams/:teamId/players',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const teamId = pathParam(req.params.teamId)
      await mustManage(actor, teamId)
      const body = cleanBody(asTeamPlayersBody, req.body)

      const answer = await addPlayers(db, teamId, body.players)
      setAudit(res.locals, {
        entityType: 'team',
        entityId: teamId,
        after: { players: answer.counts }
      })
      res.json(answer)
    })
  )

  return router
}

/** A path segment, or 404 for one Express could not give as one string. */
function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
