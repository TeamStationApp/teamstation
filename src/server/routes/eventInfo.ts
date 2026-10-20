import { Router } from 'express'
import type { Kysely } from 'kysely'

import { badRequest, notFound, unauthorized } from '../../common/errors'
import { asRsvp, asTeamEventInput } from '../../common/eventInfo'
import { isRecord } from '../../common/groupCreation'
import { asUserId } from '../../common/userId'
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
import { limitGoogleLookup } from '../location/googleLookupLimits'
import type { MediaContext } from '../media/mediaContext'
import { setAudit } from '../middleware/withAudit'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { serverConfig } from '../serverConfig'

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
    googleMapsApiKey?: string
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
      const teamId = req.query.teamId
      if (teamId !== undefined && (typeof teamId !== 'string' || teamId === ''))
        throw badRequest('Choose one attendance team')
      res
        .set('Cache-Control', 'no-store')
        .json(
          await readEventInfo(
            db,
            req.actor,
            param(req.params.id),
            media,
            teamId
          )
        )
    })
  )
  router.get(
    '/events/:id/location',
    requireActor,
    withAsync(async (req, res) => {
      if (req.actor == null) throw unauthorized()
      const info = await resolveEvent(db, req.actor, param(req.params.id))
      const address = info.address?.trim() ?? ''
      const location = address !== '' ? address : (info.venue?.trim() ?? '')
      const team = await db
        .selectFrom('teams')
        .select('locality')
        .where('id', '=', info.teamId)
        .executeTakeFirst()
      const locality = isRecord(team?.locality) ? team.locality : {}
      const locationParts = location
        .split(',')
        .map(part => part.trim().toLowerCase())
      const query =
        address !== ''
          ? address
          : [
              location,
              ...['city', 'region', 'country']
                .map(key => locality[key])
                .filter(
                  value =>
                    typeof value === 'string' &&
                    value.trim() !== '' &&
                    !locationParts.includes(value.trim().toLowerCase())
                )
            ]
              .filter(Boolean)
              .join(', ')
      const hasSavedCoordinates =
        address !== '' && info.latitude != null && info.longitude != null
      if (
        location !== '' &&
        !hasSavedCoordinates &&
        geocoder.usesGoogle === true
      )
        await limitGoogleLookup(db, req.actor.userId, true)
      const coordinates =
        location === ''
          ? { latitude: null, longitude: null }
          : address !== '' && info.latitude != null && info.longitude != null
            ? { latitude: info.latitude, longitude: info.longitude }
            : await geocoder.lookup(query)
      const googleMapsApiKey =
        options.googleMapsApiKey ?? serverConfig.googleMaps?.webApiKey
      res.set('Cache-Control', 'no-store').json({
        ...coordinates,
        tileUrl,
        ...(googleMapsApiKey != null && googleMapsApiKey !== ''
          ? { googleMapsApiKey }
          : {})
      })
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
      const userId = cleanBody(asUserId, req.params.userId)
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
