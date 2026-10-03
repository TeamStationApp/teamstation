import { asObject, asOptional, asString, asUnknown, uncleaner } from 'cleaners'

import { asLiteral } from './asLiteral'

/**
 * Every failure this API returns uses one shape, so a client never has to
 * guess. The `code` is what callers branch on; the `message` is for people,
 * and is safe to show. `details` carries field-level problems when a cleaner
 * rejects a request body, and is absent otherwise.
 */
export const asErrorCode = asLiteral(
  /**
   * The request never left the device. Not a server answer at all — no server
   * can send this — but it travels as one so a caller has a single shape to
   * branch on rather than a status number and a bare TypeError.
   */
  'offline',
  'badRequest',
  'unauthorized',
  'forbidden',
  'notFound',
  'conflict',
  'tooLarge',
  'unsupportedMedia',
  'rateLimited',
  'internal',
  /** A service the answer depends on is away for now; ask again later. */
  'unavailable'
)
export type ErrorCode = ReturnType<typeof asErrorCode>

export const asApiError = asObject({
  code: asErrorCode,
  message: asString,
  details: asOptional(asUnknown)
})

/**
 * Written out rather than taken from `ReturnType<typeof asApiError>`, which is
 * the usual idiom here. `asOptional` leaves `details` a required key whose
 * value may be undefined, so that derived type cannot describe the body we
 * actually send — one where the key is absent, because `JSON.stringify` drops
 * an undefined value anyway. The cleaner still validates anything incoming.
 */
export interface ApiError {
  code: ErrorCode
  message: string
  details?: unknown
}

export const wasApiError = uncleaner(asApiError)

/** The HTTP status each code answers with. */
export const errorStatus: Record<ErrorCode, number> = {
  // 0, the way a browser reports a request that never got a response.
  offline: 0,
  badRequest: 400,
  unauthorized: 401,
  forbidden: 403,
  notFound: 404,
  conflict: 409,
  tooLarge: 413,
  unsupportedMedia: 415,
  rateLimited: 429,
  internal: 500,
  unavailable: 503
}

/**
 * Thrown anywhere in the server; the error middleware turns it into the shape
 * above. Anything else that escapes becomes `internal` with its message
 * withheld, because an unplanned error's text is not fit to show a user.
 */
export class HttpError extends Error {
  readonly code: ErrorCode
  readonly details: unknown

  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message)
    this.name = 'HttpError'
    this.code = code
    this.details = details
  }

  get status(): number {
    return errorStatus[this.code]
  }

  toApiError(): ApiError {
    return this.details === undefined
      ? { code: this.code, message: this.message }
      : { code: this.code, message: this.message, details: this.details }
  }
}

export const badRequest = (message: string, details?: unknown): HttpError =>
  new HttpError('badRequest', message, details)

export const unauthorized = (message = 'Sign in to continue'): HttpError =>
  new HttpError('unauthorized', message)

/**
 * Used for anything the signed-in user may not see. It is deliberately the
 * same message as `notFound` at the route level for private resources, so a
 * stranger cannot learn that a team or a video exists by probing.
 */
export const forbidden = (message = 'Not found'): HttpError =>
  new HttpError('forbidden', message)

export const notFound = (message = 'Not found'): HttpError =>
  new HttpError('notFound', message)

export const conflict = (message: string, details?: unknown): HttpError =>
  new HttpError('conflict', message, details)

/**
 * Too many attempts. `retryAfterSec` is carried in `details` so a client can
 * say how long rather than asking the person to guess.
 */
export const rateLimited = (
  message: string,
  retryAfterSec: number
): HttpError => new HttpError('rateLimited', message, { retryAfterSec })

/** A body, or a part of one, heavier than this route takes. */
export const tooLarge = (message: string): HttpError =>
  new HttpError('tooLarge', message)

/** A body of a kind this route cannot read. */
export const unsupportedMedia = (message: string): HttpError =>
  new HttpError('unsupportedMedia', message)

/** Something the answer needs is away for now, and will be back. */
export const unavailable = (message: string): HttpError =>
  new HttpError('unavailable', message)

/** Turns anything at all into the one shape, without leaking internals. */
export function toApiError(error: unknown): ApiError {
  if (error instanceof HttpError) return error.toApiError()
  return { code: 'internal', message: 'Something went wrong' }
}
