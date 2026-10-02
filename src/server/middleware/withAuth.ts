import type { RequestHandler } from 'express'
import type { Kysely } from 'kysely'

import { forbidden, unauthorized } from '../../common/errors'
import { type Actor, actorForToken } from '../auth/sessions'
import { sessionToken } from '../auth/tokens'
import type { Database } from '../db/database'

declare module 'express-serve-static-core' {
  interface Request {
    actor?: Actor
  }
}

/**
 * Attaches the caller to the request when a token is present and good. It does
 * not reject an anonymous request: routes that need somebody say so with
 * `requireActor`, so a public route and a private one are told apart in one
 * place rather than by remembering to check.
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
    actorForToken(db, token).then(
      actor => {
        req.actor = actor
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
