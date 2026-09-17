import { join, resolve, sep } from 'node:path'

import { Router } from 'express'

import { verifyMediaPath } from '../media/mediaTokens'

/**
 * Serves `/media/*` from disk, the way Caddy does in production.
 *
 * **Development only.** In production Caddy checks the token through
 * `forward_auth` and streams the file itself, so media bytes never pass
 * through Node; this exists so the whole watch path — playback URL, token,
 * playlist, segments, seeking — can be run and tested on one machine. It
 * applies exactly the same check, so a token that works here works there.
 */
export function devMediaRoutes(mediaRoot: string, mediaSecret: string): Router {
  const router = Router()
  const root = resolve(mediaRoot)

  router.use('/media', (req, res, next) => {
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      next()
      return
    }

    const path = req.originalUrl.split('?')[0]
    const result = verifyMediaPath(mediaSecret, path)
    if (!result.ok) {
      res.status(403).end()
      return
    }

    const file = resolve(join(root, result.media.dir, result.media.rest))
    // The token check already refused anything containing `..`; this refuses
    // it a second time from the resolved path, where a symlink out of the
    // tree would also show up.
    if (file !== root && !file.startsWith(root + sep)) {
      res.status(403).end()
      return
    }

    if (result.media.rest.endsWith('.m3u8')) {
      res.type('application/vnd.apple.mpegurl')
    }
    res.setHeader('cache-control', 'private, max-age=3600')
    // `sendFile` answers Range requests, which is how a player seeks.
    res.sendFile(file, error => {
      if (error != null && !res.headersSent) res.status(404).end()
    })
  })

  return router
}
