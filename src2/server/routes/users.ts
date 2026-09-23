import { Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, unauthorized } from '../../common/errors'
import { asUserId } from '../../common/userIdNumber'
import { canSeePerson, type VisibleScopes, visibleScopes } from '../access'
import { onePerson, survivorsOf } from '../admin/people'
import type { Database } from '../db/database'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { teamsOf } from './players'
import { externalIdsAsked } from './seasons'

/** One person another service knows, and which of the asked ids are theirs. */
export interface UserMatch {
  userId: number
  externalIds: string[]
}

/**
 * Who people are here, asked by the ids another service knows them by.
 *
 * A sender names people in a play by GameStation user id alone, so it asks
 * this first with the ids it holds. An `external_ids` row of entity type
 * `user` matches whatever its kind. A merged row answers as the person it
 * was merged into, carrying every asked id that points at any of their rows.
 * Only people the asker could open the page of are answered, so the ids are
 * no way to find out who else is here.
 */
export function userRoutes(db: Kysely<Database>): Router {
  const router = Router()

  router.get(
    '/users',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      // Asked for nothing, it would be a list of everybody, which is not what
      // this is for.
      const asked = externalIdsAsked(req.query.externalId)
      if (asked == null) throw badRequest('externalId is required')
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      res.json(await usersByExternalId(db, asked, scopes, actor.userId))
    })
  )

  return router
}

async function usersByExternalId(
  db: Kysely<Database>,
  externalIds: string[],
  scopes: VisibleScopes,
  actorUserId: number
): Promise<UserMatch[]> {
  const rows = await db
    .selectFrom('external_ids')
    .select(['entity_id as entityId', 'external_id as externalId'])
    .where('entity_type', '=', 'user')
    .where('external_id', 'in', externalIds)
    .execute()

  const held: Array<{ userId: number; externalId: string }> = []
  for (const row of rows) {
    // A row that does not hold a user id points at nobody to answer with.
    let userId: number
    try {
      userId = asUserId(row.entityId)
    } catch {
      continue
    }
    held.push({ userId, externalId: row.externalId })
  }
  const survivors = await survivorsOf(
    db,
    held.map(row => row.userId)
  )

  const bySurvivor = new Map<number, Set<string>>()
  for (const row of held) {
    const survivor = survivors.get(row.userId)
    if (survivor == null) continue
    const ids = bySurvivor.get(survivor) ?? new Set<string>()
    ids.add(row.externalId)
    bySurvivor.set(survivor, ids)
  }

  const out: UserMatch[] = []
  for (const [userId, ids] of bySurvivor) {
    const person = await onePerson(db, userId)
    const teams = await teamsOf(db, person.userIds)
    const isSelf = person.userIds.includes(actorUserId)
    if (!canSeePerson(scopes, isSelf, teams)) continue
    out.push({ userId, externalIds: [...ids].sort() })
  }
  return out.sort((a, b) => a.userId - b.userId)
}
