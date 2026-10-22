import { type Request, Router } from 'express'
import type { Kysely } from 'kysely'

import {
  badRequest,
  HttpError,
  notFound,
  unauthorized
} from '../../common/errors'
import { isRecord } from '../../common/groupCreation'
import { asFieldChanges, asVenueChanges } from '../../common/venues'
import type { Actor } from '../auth/sessions'
import type { Database } from '../db/database'
import { type Clock, realClock } from '../groups/requests'
import type { GooglePlaces } from '../location/googlePlaces'
import type { MediaContext } from '../media/mediaContext'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'
import { serverConfig } from '../serverConfig'
import {
  asNear,
  claimPlace,
  claimVenue,
  createField,
  decideVenueClaim,
  deleteField,
  endVenueClaim,
  type FieldsChanged,
  placeDetail,
  searchVenues,
  updateField,
  updateVenue,
  venueDetail,
  type VenueServices
} from '../venues/venues'

function actor(req: Request): Actor {
  if (req.actor == null) throw unauthorized()
  return req.actor
}
function clean<T>(fn: (value: unknown) => T, value: unknown): T {
  try {
    return fn(value)
  } catch (error) {
    if (error instanceof TypeError) throw badRequest(error.message)
    throw error
  }
}
const param = (value: unknown): string => {
  if (typeof value !== 'string' || value === '') throw notFound()
  return value
}
const text = (value: unknown, label: string): string => {
  if (typeof value !== 'string' || value.trim() === '')
    throw badRequest(`Choose a ${label}`)
  return value.trim()
}
/** A query parameter that may repeat. */
const many = (value: unknown): string[] =>
  value == null
    ? []
    : (Array.isArray(value) ? value : [value]).filter(
        (item): item is string => typeof item === 'string' && item !== ''
      )

/**
 * The venue registry. Venues come from Google Maps; leagues claim them and
 * edit them and their fields. See `docs/api.md`: the list is filtered by
 * query parameters, and a claim's decisions are a resource of their own.
 */
export function venueRoutes(
  db: Kysely<Database>,
  media: MediaContext,
  options: {
    places?: GooglePlaces
    clock?: Clock
    tileUrl?: string
    googleMapsApiKey?: string
    fieldsChanged?: FieldsChanged
  } = {}
): Router {
  const router = Router()
  const services: VenueServices = {
    places: options.places,
    media,
    clock: options.clock ?? realClock,
    map: {
      tileUrl:
        options.tileUrl ??
        process.env.TS_EVENT_MAP_TILES ??
        'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
      googleMapsApiKey:
        options.googleMapsApiKey ?? serverConfig.googleMaps?.webApiKey
    }
  }
  router.get(
    '/venues',
    requireActor,
    withAsync(async (req, res) => {
      const place = req.query.place
      const leagues = many(req.query.league)
      if (place != null) {
        if (
          req.query.query != null ||
          req.query.near != null ||
          leagues.length > 0
        )
          throw badRequest('place is asked for alone')
        // Zero or one item: a place Google doesn't know is no item.
        const found = await placeDetail(
          db,
          actor(req),
          text(place, 'place'),
          services
        ).catch((error: unknown) => {
          if (error instanceof HttpError && error.code === 'notFound')
            return null
          throw error
        })
        res.json({ items: found == null ? [] : [found] })
        return
      }
      const query = req.query.query
      if (query != null && typeof query !== 'string')
        throw badRequest('query is one search')
      res.json({
        items: await searchVenues(
          db,
          actor(req),
          {
            query: query ?? undefined,
            near: asNear(req.query.near),
            leagueIds: leagues
          },
          services
        )
      })
    })
  )
  router.post(
    '/venues',
    requireActor,
    withAsync(async (req, res) => {
      const body: unknown = req.body
      if (!isRecord(body)) throw badRequest('Choose a place and a league')
      res
        .status(201)
        .json(
          await claimPlace(
            db,
            actor(req),
            text(body.placeId, 'place'),
            text(body.leagueId, 'league'),
            services
          )
        )
    })
  )
  router.get(
    '/venues/:venueId',
    requireActor,
    withAsync(async (req, res) => {
      res.json(
        await venueDetail(db, actor(req), param(req.params.venueId), services)
      )
    })
  )
  router.put(
    '/venues/:venueId',
    requireActor,
    withAsync(async (req, res) => {
      res.json(
        await updateVenue(
          db,
          actor(req),
          param(req.params.venueId),
          clean(asVenueChanges, req.body),
          services,
          options.fieldsChanged
        )
      )
    })
  )
  router.post(
    '/venues/:venueId/claims',
    requireActor,
    withAsync(async (req, res) => {
      const body: unknown = req.body
      if (!isRecord(body)) throw badRequest('Choose a league')
      res
        .status(201)
        .json(
          await claimVenue(
            db,
            actor(req),
            param(req.params.venueId),
            text(body.leagueId, 'league'),
            services
          )
        )
    })
  )
  router.post(
    '/venues/:venueId/claims/:claimId/decisions',
    requireActor,
    withAsync(async (req, res) => {
      const body: unknown = req.body
      const decision = isRecord(body) ? body.decision : undefined
      if (decision !== 'approve' && decision !== 'reject')
        throw badRequest('decision is approve or reject')
      res.json(
        await decideVenueClaim(
          db,
          actor(req),
          param(req.params.venueId),
          param(req.params.claimId),
          decision,
          services
        )
      )
    })
  )
  router.delete(
    '/venues/:venueId/claims/:claimId',
    requireActor,
    withAsync(async (req, res) => {
      res.json(
        await endVenueClaim(
          db,
          actor(req),
          param(req.params.venueId),
          param(req.params.claimId),
          services
        )
      )
    })
  )
  router.post(
    '/venues/:venueId/fields',
    requireActor,
    withAsync(async (req, res) => {
      res.status(201).json(
        await createField(
          db,
          actor(req),
          param(req.params.venueId),
          clean(raw => asFieldChanges(raw, true), req.body),
          services
        )
      )
    })
  )
  router.put(
    '/venues/:venueId/fields/:fieldId',
    requireActor,
    withAsync(async (req, res) => {
      res.json(
        await updateField(
          db,
          actor(req),
          param(req.params.venueId),
          param(req.params.fieldId),
          clean(raw => asFieldChanges(raw, false), req.body),
          services,
          options.fieldsChanged
        )
      )
    })
  )
  router.delete(
    '/venues/:venueId/fields/:fieldId',
    requireActor,
    withAsync(async (req, res) => {
      res.json(
        await deleteField(
          db,
          actor(req),
          param(req.params.venueId),
          param(req.params.fieldId),
          services,
          options.fieldsChanged
        )
      )
    })
  )
  return router
}
