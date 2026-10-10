import { Router } from 'express'

import { badRequest } from '../../common/errors'
import {
  findPlaces,
  nearestPlace,
  placeAttribution,
  placeSnapshot
} from '../location/places'

export function locationRoutes(): Router {
  const router = Router()
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
