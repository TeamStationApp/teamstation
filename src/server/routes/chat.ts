import { asArray, asBoolean, asObject, asOptional } from 'cleaners'
import { Router } from 'express'
import type { Kysely } from 'kysely'

import { notFound, unauthorized } from '../../common/errors'
import { asUserId } from '../../common/userId'
import {
  addDmMembers,
  createDm,
  dmCandidateIds,
  includedAdultIds,
  leaveDm
} from '../chat/dms'
import {
  chatPeople,
  conversationFor,
  conversationsFor,
  logOf,
  membersOf,
  nameMatches,
  readsOf
} from '../chat/listing'
import { pinsFor, setMessagePin, updatePreferences } from '../chat/preferences'
import { memberNow } from '../chat/reconciler'
import type { Database } from '../db/database'
import { cleanBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { survivors } from '../teams/teamStaff'

/** At most this many people come back from a candidate search. */
export const MAX_CANDIDATES = 50

const asUserIdsBody = asObject({ userIds: asArray(asUserId) })

/**
 * Chats and who is in them (the routes that need no keys).
 *
 * - `GET /chat/conversations`: every chat the caller is in.
 * - `GET /chat/conversations/:id/members`, `…/reads`, `…/log?after=`: for
 *   members only (`memberNow`); anybody else gets 404.
 * - `GET /chat/dm-candidates?q=`: the people the caller may name.
 * - `GET /chat/included-adults?playerIds=&q=`: adults to include beside
 *   players under the MAAPP rule.
 * - `POST /chat/dms`, `POST /chat/dms/:id/members`, `DELETE
 *   /chat/dms/:id/members/me`: start, add to, and leave a DM.
 *
 * Refusals carry `details.reason`: `notCandidate` (403), `adultRequired`
 * with `playerIds` (409), `dmSize` (400), `closed` (409).
 */
export function chatRoutes(
  db: Kysely<Database>,
  media: MediaContext,
  clock: () => Date = () => new Date()
): Router {
  const router = Router()

  /** The conversation, when the caller is in it now; 404 otherwise. */
  const mustBeMember = async (
    conversationId: string,
    userId: string
  ): Promise<void> => {
    if (!(await memberNow(db, conversationId, userId, clock()))) {
      throw notFound()
    }
  }

  router.get(
    '/chat/conversations',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      res.json(
        await conversationsFor(db, media, actor.userId, actor.isAdmin, clock())
      )
    })
  )

  router.patch(
    '/chat/conversations/:conversationId/preferences',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const id = pathParam(req.params.conversationId)
      await mustBeMember(id, actor.userId)
      const patch = cleanBody(
        asObject({
          pinned: asOptional(asBoolean),
          muted: asOptional(asBoolean),
          manualUnread: asOptional(asBoolean)
        }),
        req.body
      )
      res.json(await updatePreferences(db, actor.userId, id, patch))
    })
  )
  router.get(
    '/chat/conversations/:conversationId/pins',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const id = pathParam(req.params.conversationId)
      await mustBeMember(id, actor.userId)
      res.json(await pinsFor(db, actor.userId, id))
    })
  )
  for (const method of ['put', 'delete'] as const) {
    router[method](
      '/chat/conversations/:conversationId/pins/:messageId',
      requireActor,
      withAsync(async (req, res) => {
        const actor = req.actor
        if (actor == null) throw unauthorized()
        const id = pathParam(req.params.conversationId)
        await mustBeMember(id, actor.userId)
        res.json(
          await setMessagePin(
            db,
            actor.userId,
            id,
            pathParam(req.params.messageId),
            method === 'put'
          )
        )
      })
    )
  }

  router.get(
    '/chat/conversations/:conversationId/members',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const id = pathParam(req.params.conversationId)
      await mustBeMember(id, actor.userId)
      res.json(await membersOf(db, media.space, id, clock()))
    })
  )

  router.get(
    '/chat/conversations/:conversationId/reads',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const id = pathParam(req.params.conversationId)
      await mustBeMember(id, actor.userId)
      res.json(await readsOf(db, id))
    })
  )

  router.get(
    '/chat/conversations/:conversationId/log',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const id = pathParam(req.params.conversationId)
      await mustBeMember(id, actor.userId)
      const raw = typeof req.query.after === 'string' ? req.query.after : '0'
      const after = /^\d+$/.test(raw) ? Number(raw) : 0
      res.json(await logOf(db, id, after))
    })
  )

  router.get(
    '/chat/dm-candidates',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const query = typeof req.query.q === 'string' ? req.query.q : ''
      const ids = await dmCandidateIds(db, actor.userId, clock())
      const target =
        typeof req.query.userId === 'string' ? req.query.userId : undefined
      const canonical =
        target == null ? undefined : (await survivors(db, [target])).get(target)
      const people = await chatPeople(
        db,
        media.space,
        target == null ? ids : ids.filter(id => id === canonical)
      )
      res.json(
        [...people.values()]
          .filter(person => nameMatches(person.names, query))
          .sort((a, b) => a.shortName.localeCompare(b.shortName))
          .slice(0, MAX_CANDIDATES)
          .map(person => ({
            userId: person.userId,
            shortName: person.shortName,
            avatarUrl: person.avatarUrl
          }))
      )
    })
  )

  router.get(
    '/chat/included-adults',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const raw =
        typeof req.query.playerIds === 'string' ? req.query.playerIds : ''
      const playerIds = [
        ...new Set(
          raw
            .split(',')
            .filter(part => part !== '')
            .map(part => {
              try {
                return asUserId(part)
              } catch {
                throw notFound()
              }
            })
        )
      ]
      if (playerIds.length === 0) throw notFound()
      const query = typeof req.query.q === 'string' ? req.query.q.trim() : ''
      const adults = await includedAdultIds(
        db,
        actor.userId,
        playerIds,
        query !== '',
        clock()
      )
      const people = await chatPeople(
        db,
        media.space,
        adults.map(adult => adult.userId)
      )
      res.json(
        adults.flatMap(adult => {
          const person = people.get(adult.userId)
          if (person == null || !nameMatches(person.names, query)) return []
          return [
            {
              userId: adult.userId,
              shortName: person.shortName,
              label: adult.label ?? ''
            }
          ]
        })
      )
    })
  )

  router.post(
    '/chat/dms',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const body = cleanBody(asUserIdsBody, req.body)
      const made = await createDm(db, actor.userId, body.userIds, clock())
      setAudit(res.locals, {
        entityType: 'conversation',
        entityId: made.conversationId,
        after: { userIds: body.userIds, created: made.created }
      })
      res
        .status(made.created ? 201 : 200)
        .json(
          await conversationFor(
            db,
            media,
            made.conversationId,
            actor.userId,
            actor.isAdmin
          )
        )
    })
  )

  router.post(
    '/chat/dms/:conversationId/members',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const id = pathParam(req.params.conversationId)
      const body = cleanBody(asUserIdsBody, req.body)
      const added = await addDmMembers(
        db,
        id,
        actor.userId,
        body.userIds,
        clock()
      )
      setAudit(res.locals, {
        entityType: 'conversation',
        entityId: id,
        after: { added }
      })
      res.json({ added })
    })
  )

  router.delete(
    '/chat/dms/:conversationId/members/me',
    requireActor,
    withAsync(async (req, res) => {
      const actor = req.actor
      if (actor == null) throw unauthorized()
      const id = pathParam(req.params.conversationId)
      const left = await leaveDm(db, id, actor.userId, clock())
      setAudit(res.locals, {
        entityType: 'conversation',
        entityId: id,
        after: { left: actor.userId, closed: left.closed }
      })
      res.json({ left: true, closed: left.closed })
    })
  )

  return router
}

function pathParam(value: string | string[] | undefined): string {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
