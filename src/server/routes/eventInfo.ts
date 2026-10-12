import { Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, notFound, unauthorized } from '../../common/errors'
import { asRsvp, asTeamEventInput } from '../../common/eventInfo'
import { isRecord } from '../../common/groupCreation'
import type { Database } from '../db/database'
import {
  createTeamEvent,
  readEventInfo,
  resolveEvent,
  saveEventRsvp,
  updateEventInfo
} from '../events/eventInfo'
import { cleanBody } from '../jsonBody'
import { type EventGeocoder, eventGeocoder } from '../location/eventGeocoder'
import type { MediaContext } from '../media/mediaContext'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

const param = (value: unknown): string => {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}

export function eventInfoRoutes(
  db: Kysely<Database>,
  media: MediaContext,
  options: {
    geocoder?: EventGeocoder
    tileUrl?: string
  } = {}
): Router {
  const router = Router()
  const geocoder = options.geocoder ?? eventGeocoder(db)
  const tileUrl =
    options.tileUrl ??
    process.env.TS_EVENT_MAP_TILES ??
    'https://tile.openstreetmap.org/{z}/{x}/{y}.png'
  router.post(
    '/events',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      const body = cleanBody(asTeamEventInput, req.body)
      const answer = await createTeamEvent(db, req.actor, body)
      setAudit(res.locals, {
        entityType: 'teamEvent',
        entityId: answer.id,
        after: body
      })
      res.status(201).json(answer)
    })
  )
  router.get(
    '/events/:id/info',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      res
        .set('Cache-Control', 'no-store')
        .json(await readEventInfo(db, req.actor, param(req.params.id), media))
    })
  )
  router.get(
    '/events/:id/location',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      const info = await resolveEvent(db, req.actor, param(req.params.id))
      const coordinates =
        info.address == null
          ? { latitude: null, longitude: null }
          : info.latitude != null && info.longitude != null
            ? { latitude: info.latitude, longitude: info.longitude }
            : await geocoder.lookup(info.address)
      res.json({ ...coordinates, tileUrl })
    })
  )
  router.put(
    '/events/:id/info',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      const id = param(req.params.id)
      try {
        await updateEventInfo(db, req.actor, id, req.body)
      } catch (error) {
        if (error instanceof TypeError) throw badRequest(error.message)
        throw error
      }
      setAudit(res.locals, {
        entityType: 'eventInfo',
        entityId: id,
        after: req.body
      })
      res.json(await readEventInfo(db, req.actor, id, media))
    })
  )
  router.put(
    '/events/:id/rsvps/:userId',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      const id = param(req.params.id)
      const text = param(req.params.userId)
      const userId = Number(text)
      if (!/^\d+$/.test(text) || !Number.isSafeInteger(userId) || userId <= 0)
        throw badRequest('Choose a valid person')
      if (!isRecord(req.body)) throw badRequest('Choose Yes, Maybe or No')
      const response = cleanBody(asRsvp, req.body.response)
      await saveEventRsvp(db, req.actor, id, userId, response)
      setAudit(res.locals, {
        entityType: 'eventRsvp',
        entityId: id,
        after: { userId, response }
      })
      res.json({ userId, response })
    })
  )
  return router
}
