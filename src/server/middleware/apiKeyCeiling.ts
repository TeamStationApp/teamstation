import type { RequestHandler } from 'express'

import { forbidden } from '../../common/errors'
import { keyNeeds } from '../auth/apiKeyFamilies'
import { keyAllows } from '../auth/sessions'

const API_PREFIX = '/api/v1'

/**
 * The ceiling on a user API key: the families of `API_KEY_FAMILIES`, and
 * within them only what the key was given. It runs right after `withActor`,
 * before any route, so a route keeps its own checks and the key can only
 * take rights away. A session, a machine token and Tess pass untouched.
 *
 * Health, the time and the API document ignore the key: they answer as they
 * would anybody. Every other request a key makes outside its families, under
 * `/api/v1` or not, is refused.
 */
export function withApiKeyCeiling(): RequestHandler {
  return (req, res, next) => {
    const actor = req.actor
    if (actor?.apiKey == null) {
      next()
      return
    }
    const path = req.path
    const below =
      path === API_PREFIX || path.startsWith(`${API_PREFIX}/`)
        ? path.slice(API_PREFIX.length)
        : null
    const needs = below == null ? null : keyNeeds(req.method, below)
    if (needs === 'keyless') {
      req.actor = undefined
      next()
      return
    }
    if (needs == null || !keyAllows(actor, needs)) {
      next(forbidden('This API key cannot do that'))
      return
    }
    next()
  }
}
