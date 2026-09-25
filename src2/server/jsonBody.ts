import express, { type RequestHandler } from 'express'

/** Most bodies: a sign-in, a setting, a batch of log lines. */
const smallBody = express.json({ limit: '1mb' })

/** One post of a game's plays is the whole game. */
const largeBody = express.json({ limit: '32mb' })

/**
 * The posts whose body is a whole set at once. Only these get the large
 * limit: every other route, the ones answered without a session included,
 * keeps the 1 MB a request has always been allowed, so nobody can make the
 * server parse 32 MB for a sign-in or a log line.
 */
const LARGE_POSTS: readonly RegExp[] = [/^\/api\/v1\/games\/[^/]+\/events$/]

/** The body parser `runWorker` mounts, ahead of every route. */
export const jsonBody: RequestHandler = (req, res, next) => {
  const large =
    req.method === 'POST' && LARGE_POSTS.some(path => path.test(req.path))
  if (large) largeBody(req, res, next)
  else smallBody(req, res, next)
}
