import type { Request, RequestHandler } from 'express'

import { type CheckoutOwner, runCheckoutsFor } from '../db/checkouts'

const METHODS = ['GET', 'HEAD', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS']

/**
 * A request's label: its method and the pattern of the route it matched, read
 * when it is asked for, so a checkout made before routing (the session lookup)
 * is named by its route once the route is known. Never the path itself, which
 * carries ids.
 */
export function routeLabel(req: Request): string {
  const method = METHODS.includes(req.method) ? req.method : 'OTHER'
  const path: unknown = (req.route as { path?: unknown } | undefined)?.path
  if (typeof path !== 'string') return `${method} (before route)`
  return `${method} ${req.baseUrl}${path}`
}

const requestOwners = new WeakMap<Request, CheckoutOwner>()

/** The owner of a request's checkouts, made the first time it is asked for. */
export function requestOwner(req: Request): CheckoutOwner {
  let owner = requestOwners.get(req)
  if (owner == null) {
    owner = { label: () => routeLabel(req) }
    requestOwners.set(req, owner)
  }
  return owner
}

/**
 * Names every checkout a request makes by its route. Used before the first
 * middleware that reads the database; a body parser keeps the context, as it
 * binds its callbacks to the request's.
 */
export const checkoutOwners: RequestHandler = (req, _res, next) => {
  runCheckoutsFor(requestOwner(req), next)
}
