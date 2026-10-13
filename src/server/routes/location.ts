import { Router } from 'express'

import { badRequest } from '../../common/errors'
import {
  EVENT_PLACE_ATTRIBUTION,
  type EventPlaceSearch,
  eventPlaceSearch
} from '../location/eventPlaces'
import {
  findPlaces,
  nearestPlace,
  placeAttribution,
  placeSnapshot
} from '../location/places'
import { requireActor } from '../middleware/withAuth'
import { withAsync } from '../middleware/withErrors'

export function locationRoutes(
  search: EventPlaceSearch = eventPlaceSearch()
): Router {
  const router = Router()
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
      res.set('Cache-Control', 'no-store').json({
        places: await search.search(query, kind),
        attribution: EVENT_PLACE_ATTRIBUTION
      })
    })
  )
  router.get('/locations', (req, res) => {
    const query = req.query.query
    if (typeof query !== 'string' || query.length > 120)
      throw badRequest('Enter a city or region')
    res.json({
      places: findPlaces(query),
      attribution: placeAttribution,
      snapshot: placeSnapshot
    })
  })
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
