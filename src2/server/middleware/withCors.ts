import type { RequestHandler } from 'express'

/**
 * Lets the app call the API from its own origin during development, and from
 * wherever it is served in production.
 *
 * The allowed origins are listed in configuration and echoed back one at a
 * time; there is no `*`, because these requests carry a bearer token and a
 * wildcard would let any page on the internet spend it.
 */
export function withCors(allowedOrigins: string[]): RequestHandler {
  const allowed = new Set(allowedOrigins)

  return (req, res, next) => {
    const origin = req.header('origin')
    if (origin != null && allowed.has(origin)) {
      res.setHeader('access-control-allow-origin', origin)
      // The session cookie only travels cross-origin with this, and it is
      // legal only because the origin is echoed one at a time rather than
      // being `*`. In production the app and the API share an origin and none
      // of this applies; in development they are :8080 and :9100.
      res.setHeader('access-control-allow-credentials', 'true')
      res.setHeader('vary', 'origin')
      res.setHeader(
        'access-control-allow-headers',
        'authorization,content-type'
      )
      res.setHeader(
        'access-control-allow-methods',
        'GET,POST,PATCH,PUT,DELETE,OPTIONS'
      )
      res.setHeader('access-control-max-age', '600')
    }

    if (req.method === 'OPTIONS') {
      // Answered here rather than falling through to the router, which would
      // report a perfectly good preflight as 404.
      res.status(origin != null && allowed.has(origin) ? 204 : 403).end()
      return
    }

    next()
  }
}
