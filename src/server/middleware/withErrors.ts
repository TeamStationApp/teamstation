import { captureException } from '@sentry/node'
import type { ErrorRequestHandler, RequestHandler, Response } from 'express'

import {
  type ApiError,
  badRequest,
  HttpError,
  notFound,
  toApiError,
  tooLarge
} from '../../common/errors'

/** Writes the one error shape, and nothing else, to a response. */
export function sendError(res: Response, error: unknown): void {
  const body: ApiError = toApiError(error)
  const status = error instanceof HttpError ? error.status : 500
  res.status(status).json(body)
}

/**
 * Wraps an async handler so a rejected promise reaches the error middleware
 * instead of hanging the request. Express 5 forwards rejections on its own,
 * but being explicit here keeps the behaviour the same if that changes.
 */
export function withAsync(
  handler: (...args: Parameters<RequestHandler>) => Promise<void>
): RequestHandler {
  return (req, res, next) => {
    handler(req, res, next).catch(next)
  }
}

/** Anything that reaches here was not a route: 404 in the usual shape. */
export const notFoundHandler: RequestHandler = (req, res) => {
  sendError(res, notFound())
}

/**
 * The last middleware. An `HttpError` is reported as itself; anything else is
 * logged in full and reported as a bare `internal`, because the text of an
 * unplanned error is not fit to show a user and may name a file or a password.
 */
export const errorHandler: ErrorRequestHandler = (error, req, res, next) => {
  // A body express could not parse is the caller's mistake, not ours. It
  // arrives as a SyntaxError carrying a status, and without this it fell
  // through to `internal` — so a stray comma answered 500 and said "Something
  // went wrong", which sends whoever is integrating to look at the wrong end.
  if (isBadJson(error)) {
    sendError(res, badRequest('That request body is not valid JSON'))
    return
  }
  // A body over the parser's limit is the caller's too, and says so as 413
  // rather than as a 500 that hides which end to fix.
  if (isTooLarge(error)) {
    sendError(res, tooLarge('That request body is too large'))
    return
  }
  if (!(error instanceof HttpError)) {
    console.error('%s %s', req.method, req.path, error)
    captureException(error)
  }
  if (res.headersSent) {
    next(error)
    return
  }
  sendError(res, error)
}

/** express.json() rejects an unparseable body with a 400-carrying SyntaxError. */
function isBadJson(error: unknown): boolean {
  return (
    error instanceof SyntaxError &&
    'status' in error &&
    (error as { status?: number }).status === 400
  )
}

/** express.json() rejects a body over its limit with `entity.too.large`. */
function isTooLarge(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error != null &&
    (error as { type?: unknown }).type === 'entity.too.large'
  )
}
