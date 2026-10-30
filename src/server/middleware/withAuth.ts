import { getIsolationScope } from '@sentry/node'
import type { RequestHandler } from 'express'
import type { Kysely } from 'kysely'

import { forbidden, unauthorized } from '../../common/errors'
import { type Actor, actorForToken } from '../auth/sessions'
import { sessionToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { runSpoken } from '../users/readerNames'

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor
  }
}

/**
 * The header every request Tess's tools send carries. It only ever takes
 * rights away: whoever sends it is a machine acting for the person
 * (`isMachine`), so a client that sends it on its own gains nothing, and it
 * needs no secret. One that a secret had to vouch for would fail open:
 * a request of Tess's whose secret did not match would pass as the person.
 */
export const TESS_HEADER = 'x-teamstation-tess'

/**
 * A request Tess's tools sent is answered with names a model may be given, a
 * change she confirms included: what the change writes for everybody else
 * leaves this (`outsideSpoken`). Sending the header on purpose only narrows
 * what comes back.
 */
export function spokenRequests(): RequestHandler {
  return (req, _res, next) => {
    if (req.header(TESS_HEADER) != null) runSpoken(next)
    else next()
  }
}

/**
 * Attaches the caller to the request when a token is present and good. It does
 * not reject an anonymous request: routes that need somebody say so with
 * `requireActor`, so a public route and a private one are told apart in one
 * place rather than by remembering to check. A request Tess's tools sent is
 * marked as hers.
 */
export function withActor(db: Kysely<Database>): RequestHandler {
  return (req, res, next) => {
    const token = sessionToken(
      req.header('authorization'),
      req.header('cookie')
    )
    if (token == null) {
      next()
      return
    }
    const viaTess = req.header(TESS_HEADER) != null
    actorForToken(db, token).then(
      found => {
        const actor =
          found != null && viaTess
            ? { ...found, viaTess: true as const }
            : found
        req.actor = actor
        // The account by id only, on this request's own scope, so an error
        // it raises names who was signed in and nothing else about them.
        if (actor != null)
          getIsolationScope().setUser({ id: String(actor.userId) })
        next()
      },
      (error: unknown) => {
        next(error)
      }
    )
  }
}

/** Rejects anyone not signed in. */
export const requireActor: RequestHandler = (req, res, next) => {
  if (req.actor == null) {
    next(unauthorized())
    return
  }
  next()
}

/** Rejects anyone who is not a site administrator. */
export const requireAdmin: RequestHandler = (req, res, next) => {
  if (req.actor == null) {
    next(unauthorized())
    return
  }
  if (!req.actor.isAdmin) {
    next(forbidden())
    return
  }
  next()
}
