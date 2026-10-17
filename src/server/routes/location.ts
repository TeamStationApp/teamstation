import { Router } from 'express'
import type { Kysely } from 'kysely'

import {
  badRequest,
  HttpError,
  notFound,
  unauthorized
} from '../../common/errors'
import type { Database } from '../db/database'
import {
  EVENT_PLACE_ATTRIBUTION,
  type EventPlaceSearch,
  eventPlaceSearch
} from '../location/eventPlaces'
import { limitGoogleLookup } from '../location/googleLookupLimits'
import type { GooglePlaces } from '../location/googlePlaces'
import {
  findPlaces,
  nearestPlace,
  placeAttribution,
  placeById,
  placeSnapshot
} from '../location/places'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

export function locationRoutes(
  search: EventPlaceSearch = eventPlaceSearch(),
  cities?: { db: Kysely<Database>; googlePlaces?: GooglePlaces }
): Router {
  const router = Router()
  async function limit(userId: number, details: boolean): Promise<void> {
    if (cities == null) return
    await limitGoogleLookup(cities.db, userId, details)
  }
  const sessionToken = (value: unknown): string | undefined => {
    if (value === undefined) return undefined
    if (typeof value !== 'string' || value.length < 1 || value.length > 64)
      throw badRequest('City search session is invalid')
    return value
  }
  router.get(
    '/locations',
    (req, res, next) => {
      if (req.query.kind === undefined) {
        next()
        return
      }
      requireActor(req, res, next)
    },
    withAsync(async (req, res, next) => {
      if (req.query.kind === undefined) {
        next()
        return
      }
      const { query, kind } = req.query
      if (
        typeof query !== 'string' ||
        query.length > 120 ||
        (kind !== 'venue' && kind !== 'address')
      )
        throw badRequest(
          'Choose venue or address and enter at most 120 characters'
        )
      const google = cities?.googlePlaces
      if (google != null) {
        if (query.trim().length >= 2) await limit(req.actor!.userId, false)
        try {
          const places = await google.eventPlaces(query, kind)
          res.set('Cache-Control', 'no-store').json({
            places,
            provider: 'google',
            attribution: 'Powered by Google'
          })
          return
        } catch (error) {
          if (!(error instanceof HttpError) || error.code !== 'unavailable')
            throw error
        }
      }
      res.set('Cache-Control', 'no-store').json({
        places: await search.search(query, kind),
        provider: 'openstreetmap',
        attribution: EVENT_PLACE_ATTRIBUTION
      })
    })
  )
  router.get(
    '/locations',
    withAsync(async (req, res) => {
      const query = req.query.query
      if (typeof query !== 'string' || query.length > 120)
        throw badRequest('Enter a city or region')
      const session = sessionToken(req.query.session)
      const places = findPlaces(query)
      const google = cities?.googlePlaces
      const signedIn = req.actor != null && req.actor.apiTokenId == null
      // Legacy callers omit session and keep their catalogue data and attribution.
      if (
        google != null &&
        session != null &&
        signedIn &&
        query.trim().length >= 2
      ) {
        await limit(req.actor!.userId, false)
        res.set('Cache-Control', 'no-store').json({
          places,
          suggestions: await google.autocomplete(query, session),
          provider: 'google',
          attribution: 'Powered by Google',
          snapshot: placeSnapshot
        })
      } else
        res.json({
          places,
          suggestions: places.slice(0, 8).map(place => ({
            id: `geonames:${place.placeId}`,
            primary: place.city,
            secondary: `${place.region}, ${place.country}`
          })),
          provider: 'geonames',
          attribution: placeAttribution,
          snapshot: placeSnapshot
        })
    })
  )
  router.get(
    '/locations/:id',
    withAsync(async (req, res) => {
      const id = req.params.id
      if (typeof id !== 'string')
        throw badRequest('Location identifier is invalid')
      const session = sessionToken(req.query.session)
      if (id.startsWith('google:')) {
        if (req.actor == null || req.actor.apiTokenId != null)
          throw unauthorized()
        if (cities?.googlePlaces == null) throw notFound()
        await limit(req.actor.userId, true)
        res.set('Cache-Control', 'no-store').json({
          place: await cities.googlePlaces.locality(id.slice(7), session)
        })
      } else if (id.startsWith('geonames:')) {
        const place = placeById(id.slice(9))
        if (place == null) throw notFound()
        res.json({ place })
      } else throw notFound()
    })
  )
  // Coordinates stay in the POST body and are never attached to audit metadata.
  router.post('/location-suggestions', (req, res) => {
    const { latitude, longitude } = req.body ?? {}
    if (typeof latitude !== 'number' || typeof longitude !== 'number')
      throw badRequest('Location estimate is invalid')
    try {
      res.json({
        place: nearestPlace(latitude, longitude),
        attribution: placeAttribution
      })
    } catch (error) {
      if (error instanceof TypeError) throw badRequest(error.message)
      throw error
    }
  })
  return router
}
