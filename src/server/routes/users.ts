import { Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, unauthorized } from '../../common/errors'
import { asUserId } from '../../common/userId'
import {
  canSeePerson,
  guardedPlayers,
  type VisibleScopes,
  visibleScopes
} from '../access'
import { onePerson, survivorsOf } from '../admin/people'
import type { Database } from '../db/database'
import {
  accessibleVideoGames,
  hasVideoFilter,
  participantsInGames,
  videoCollectionFilter
} from '../events/videoCollections'
import { publicNames } from '../groups/playerNamePrivacy'
import { imageUrl } from '../media/imageUrls'
import type { SpaceSettings } from '../media/spacesHls'
import { requireActor } from '../middleware/withAuth'
import { withRevision } from '../socket/syncRevision'
import { candidateQueryOf, rosterCandidates } from '../users/rosterCandidates'
import { teamsOf } from './players'
import { externalIdsAsked } from './seasons'

/** One person another service knows, and which of the asked ids are theirs. */
export interface UserMatch {
  userId: string
  gumboId: number | null
  externalIds: string[]
  /** `Jordan P`, told apart from anybody else in the same answer. */
  shortName: string
  /** Their picture, signed and short-lived; null when they have none. */
  avatarUrl: string | null
}

/**
 * Who people are here, asked by the ids another service knows them by, or
 * the players the asker is a guardian of.
 *
 * A sender names people in a play by TeamStation user id alone, so it asks
 * this first with the ids it holds. An `external_ids` row of entity type
 * `user` matches whatever its kind. A merged row answers as the person it
 * was merged into, carrying every asked id that points at any of their rows.
 * Only people the asker could open the page of are answered, so the ids are
 * no way to find out who else is here.
 *
 * `guardedBy=me` asks instead for the players the asker is a guardian of
 * (`guardedPlayers`), by short name: what Home lists as "Your Players". Only
 * `me` is accepted, and never beside `externalId`.
 *
 * `forTeam=<teamId>`, with `forGame`, `q`, `limit` and `after`, asks for the
 * players a roster manager may add to that team (`rosterCandidates`).
 */
export function userRoutes(
  db: Kysely<Database>,
  space?: SpaceSettings
): Router {
  const router = Router()

  router.get(
    '/users',
    requireActor,
    withRevision(db, async (db, req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      if (hasVideoFilter(req.query)) {
        const filter = videoCollectionFilter(req.query)
        const games = await accessibleVideoGames(db, actor, filter)
        const ids = await participantsInGames(
          db,
          games.map(game => game.gameId)
        )
        const people = await describe(
          db,
          space,
          ids.map(userId => ({ userId, externalIds: [] }))
        )
        res.json(
          people
            .filter(person =>
              person.shortName.toLowerCase().includes(filter.q.toLowerCase())
            )
            .sort(
              (a, b) =>
                [
                  a.shortName.localeCompare(b.shortName),
                  a.userId.localeCompare(b.userId)
                ].find(order => order !== 0) ?? 0
            )
            .slice(filter.offset, filter.offset + filter.limit)
        )
        return
      }
      if (req.query.forTeam !== undefined) {
        const ask = candidateQueryOf(req.query)
        res.json(await rosterCandidates(db, actor, ask, space))
        return
      }
      const guardedBy = req.query.guardedBy
      if (guardedBy !== undefined) {
        if (guardedBy !== 'me') throw badRequest('guardedBy must be me')
        if (req.query.externalId !== undefined) {
          throw badRequest('Ask by externalId or by guardedBy, not both')
        }
        const guarded = await guardedPlayers(db, actor.userId)
        const people = await describe(
          db,
          space,
          guarded.map(userId => ({ userId, externalIds: [] }))
        )
        res.json(
          people.sort((a, b) => {
            const byName = a.shortName.localeCompare(b.shortName)
            return byName === 0 ? a.userId.localeCompare(b.userId) : byName
          })
        )
        return
      }
      // Asked for nothing, it would be a list of everybody, which is not what
      // this is for.
      const asked = externalIdsAsked(req.query.externalId)
      if (asked == null) throw badRequest('externalId is required')
      const scopes = await visibleScopes(db, actor.userId, actor.isAdmin)
      const system = req.query.system
      if (system != null && (typeof system !== 'string' || system === ''))
        throw badRequest('system must be a nonempty string')
      const matches = await usersByExternalId(
        db,
        asked,
        scopes,
        actor.userId,
        system
      )
      res.json(await describe(db, space, matches))
    })
  )

  return router
}

/** Each person's short name and picture, beside what was already known. */
async function describe(
  db: Kysely<Database>,
  space: SpaceSettings | undefined,
  people: Array<Pick<UserMatch, 'userId' | 'externalIds'>>
): Promise<UserMatch[]> {
  if (people.length === 0) return []
  const rows = await db
    .selectFrom('users')
    .leftJoin('gumbo_ids', 'gumbo_ids.user_id', 'users.id')
    .select([
      'gumbo_ids.gumbo_id as gumboId',
      'id',
      'display_name as displayName',
      'first_name as firstName',
      'last_name as lastName',
      'avatar_path as avatarPath'
    ])
    .where(
      'id',
      'in',
      people.map(person => person.userId)
    )
    .execute()
  const names = await publicNames(
    db,
    rows.map(person => ({ person }))
  )
  const byId = new Map(rows.map(row => [row.id, row]))
  return people.map(person => {
    const row = byId.get(person.userId)
    return {
      ...person,
      gumboId: row?.gumboId ?? null,
      shortName: names.get(person.userId) ?? '',
      avatarUrl: space == null ? null : imageUrl(space, row?.avatarPath ?? null)
    }
  })
}

async function usersByExternalId(
  db: Kysely<Database>,
  externalIds: string[],
  scopes: VisibleScopes,
  actorUserId: string,
  system?: string
): Promise<Array<Pick<UserMatch, 'userId' | 'externalIds'>>> {
  let query = db
    .selectFrom('external_ids')
    .innerJoin('users', 'users.id', 'external_ids.entity_id')
    .select(['entity_id as entityId', 'external_id as externalId'])
    .where('entity_type', '=', 'user')
    .where('external_id', 'in', externalIds)
  if (system != null) query = query.where('system', '=', system)
  const rows = await query.execute()

  const held: Array<{ userId: string; externalId: string }> = []
  for (const row of rows) {
    // A row that does not hold a user id points at nobody to answer with.
    let userId: string
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

  const bySurvivor = new Map<string, Set<string>>()
  for (const row of held) {
    const survivor = survivors.get(row.userId)
    if (survivor == null) continue
    const ids = bySurvivor.get(survivor) ?? new Set<string>()
    ids.add(row.externalId)
    bySurvivor.set(survivor, ids)
  }

  const out: Array<Pick<UserMatch, 'userId' | 'externalIds'>> = []
  for (const [userId, ids] of bySurvivor) {
    const person = await onePerson(db, userId)
    const teams = await teamsOf(db, person.userIds)
    const isSelf = person.userIds.includes(actorUserId)
    if (!canSeePerson(scopes, isSelf, teams)) continue
    out.push({ userId, externalIds: [...ids].sort() })
  }
  return out.sort((a, b) => a.userId.localeCompare(b.userId))
}
