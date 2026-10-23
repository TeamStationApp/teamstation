import express, { type RequestHandler } from 'express'

import { badRequest, unauthorized } from '../common/errors'

/** Most bodies: a sign-in, a setting, a batch of log lines. */
const smallBody = express.json({ limit: '1mb' })
const analyticsBody = express.json({ limit: '64kb' })

/** One post of a game's plays is the whole game. */
const gameBody = express.json({ limit: '32mb' })

/**
 * One picture: 10 MiB of bytes is 13.4 MiB of base64, and the JSON around
 * it is a few bytes more.
 */
const pictureParser = express.json({ limit: '14mb' })

/**
 * A file for Tess: a 5 MB picture is 6.7 MB of base64. Read, as a picture
 * is, only for somebody signed in.
 */
const tessParser = express.json({ limit: '8mb' })
const tessBody: RequestHandler = (req, res, next) => {
  if (req.actor == null) {
    next(unauthorized())
    return
  }
  tessParser(req, res, next)
}

/**
 * A picture's body is read only for somebody signed in: anybody else is
 * answered 401 before a byte of it is parsed, so the 14 MB limit is not
 * open to the world. `withActor` runs ahead of this parser for that.
 */
const pictureBody: RequestHandler = (req, res, next) => {
  if (req.actor == null) {
    next(unauthorized())
    return
  }
  pictureParser(req, res, next)
}

/**
 * The requests whose body is a whole set at once, or a picture, by method and
 * path, with the parser each gets. Every other route, the ones answered
 * without a session included, keeps the 1 MB a request has always been
 * allowed, so nobody can make the server parse megabytes for a sign-in or a
 * log line.
 */
const LARGE_BODIES: ReadonlyArray<{
  method: string
  path: RegExp
  parser: RequestHandler
}> = [
  {
    method: 'POST',
    path: /^\/api\/v1\/analytics\/events$/,
    parser: analyticsBody
  },
  {
    method: 'POST',
    path: /^\/api\/v1\/admin\/analytics\/query$/,
    parser: analyticsBody
  },
  {
    method: 'PUT',
    path: /^\/api\/v1\/me\/account\/photo$/,
    parser: pictureBody
  },
  {
    method: 'PUT',
    path: /^\/api\/v1\/me\/onboarding\/photo$/,
    parser: pictureBody
  },
  {
    method: 'POST',
    path: /^\/api\/v1\/(leagues|seasons|teams)$/,
    parser: pictureBody
  },
  {
    method: 'PUT',
    path: /^\/api\/v1\/groups\/(league|season|team)\/[^/]+$/,
    parser: pictureBody
  },
  // A venue's or field's photo.
  {
    method: 'PUT',
    path: /^\/api\/v1\/venues\/[^/]+$/,
    parser: pictureBody
  },
  {
    method: 'POST',
    path: /^\/api\/v1\/venues\/[^/]+\/fields$/,
    parser: pictureBody
  },
  {
    method: 'PUT',
    path: /^\/api\/v1\/venues\/[^/]+\/fields\/[^/]+$/,
    parser: pictureBody
  },
  {
    method: 'POST',
    path: /^\/api\/v1\/games\/[^/]+\/events$/,
    parser: gameBody
  },
  {
    // A whole game's events, as large as the plays they go on.
    method: 'PATCH',
    path: /^\/api\/v1\/games\/[^/]+\/events$/,
    parser: gameBody
  },
  {
    method: 'POST',
    path: /^\/api\/v1\/me\/tess\/attachments$/,
    parser: tessBody
  },
  {
    method: 'PUT',
    path: /^\/api\/v1\/teams\/[^/]+\/logo$/,
    parser: pictureBody
  },
  {
    method: 'PUT',
    path: /^\/api\/v1\/teams\/[^/]+\/players\/[^/]+\/avatar$/,
    parser: pictureBody
  }
]

/**
 * The body parser `runWorker` mounts, after `withActor` and ahead of every
 * route.
 */
export const jsonBody: RequestHandler = (req, res, next) => {
  // Express accepts case differences and one trailing slash on these routes.
  const path = req.path.toLowerCase().replace(/\/$/, '')
  const large = LARGE_BODIES.find(
    entry => entry.method === req.method && entry.path.test(path)
  )
  const parser = large?.parser ?? smallBody
  parser(req, res, next)
}

/**
 * The parsed body as `cleaner` reads it, or a 400 carrying the cleaner's
 * reason when it refuses the body.
 */
export function cleanBody<T>(cleaner: (raw: unknown) => T, raw: unknown): T {
  try {
    return cleaner(raw)
  } catch (error) {
    throw badRequest(
      error instanceof Error ? error.message : 'Malformed request body'
    )
  }
}
