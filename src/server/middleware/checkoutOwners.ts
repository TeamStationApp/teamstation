import type { Request, RequestHandler, Response } from 'express'

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

/** Methods that only read, so work left undone when the caller goes is lost to nobody. */
const READS = ['GET', 'HEAD']

/**
 * The owner of a request's checkouts, made the first time it is asked for. A
 * read is abandoned when its response closes before it was ended: the caller
 * went away, gave up or was superseded. A write is not: what it changes is
 * finished whether or not anybody hears the answer.
 */
export function requestOwner(req: Request, res: Response): CheckoutOwner {
  let owner = requestOwners.get(req)
  if (owner == null) {
    const label = (): string => routeLabel(req)
    if (READS.includes(req.method)) {
      const gone = new AbortController()
      res.once('close', () => {
        if (!res.writableEnded) gone.abort()
      })
      owner = { label, abandoned: gone.signal }
    } else owner = { label }
    requestOwners.set(req, owner)
  }
  return owner
}

/**
 * Names every checkout a request makes by its route, and refuses those of a
 * read whose caller has gone. Used before the first middleware that reads the
 * database; a body parser keeps the context, as it binds its callbacks to the
 * request's.
 */
export const checkoutOwners: RequestHandler = (req, res, next) => {
  runCheckoutsFor(requestOwner(req, res), next)
}
