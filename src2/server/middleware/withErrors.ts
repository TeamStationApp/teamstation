import type { ErrorRequestHandler, RequestHandler, Response } from 'express'

import {
  type ApiError,
  HttpError,
  notFound,
  toApiError
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
  if (!(error instanceof HttpError)) {
    console.error(`${req.method} ${req.path}`, error)
  }
  if (res.headersSent) {
    next(error)
    return
  }
  sendError(res, error)
}
