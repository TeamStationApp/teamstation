import { type Request, type Response, Router } from 'express'

import { badRequest } from '../../common/errors'
import type { AppLink, AppLinksConfig } from '../appLinks/config'

export interface AppLinkRouteOptions {
  appLinks: AppLinksConfig
  /** This server's own origin, where a link with no `server` goes. */
  publicUrl: string
}

/** What a sign-in link's token looks like: `makeToken`'s base64url. */
const TOKEN = /^[A-Za-z0-9_-]{16,128}$/

/**
 * What an app's link host answers, for the hosts in `appLinks.apps`.
 *
 * Apple and Google decide whether a link may open an app by fetching a file
 * from the link's host, and follow no redirect to get it, so each host must
 * answer for its own app: which app is asked about is the `Host` header, not
 * the path. Both files are built from the deployment's config, so the team
 * that signs the iOS apps and the keys that sign the Android ones are never
 * written in this repository.
 *
 * `/signin/<token>` is for the browser that has no app: an installed app is
 * handed the link by its operating system and never asks for it. It sends
 * the browser to the web sign-in of the server that issued the link, and
 * only to this server or one it knows, so a link cannot be made into an open
 * redirect. The token is never spent here; mail scanners follow links.
 */
export function appLinkRoutes(options: AppLinkRouteOptions): Router {
  const router = Router()
  const byHost = new Map<string, AppLink>(
    options.appLinks.apps.map(app => [new URL(app.origin).host, app])
  )
  const servers = new Set([options.publicUrl, ...options.appLinks.knownServers])

  const appFor = (req: Request): AppLink | undefined =>
    byHost.get((req.headers.host ?? '').toLowerCase())

  const sendJson = (res: Response, body: unknown): void => {
    res.set('cache-control', 'public, max-age=3600')
    res.type('application/json').send(JSON.stringify(body))
  }

  router.get('/.well-known/apple-app-site-association', (req, res, next) => {
    const app = appFor(req)
    const apple = app?.apple
    if (apple == null) {
      next()
      return
    }
    sendJson(res, {
      applinks: {
        details: [
          {
            appIDs: apple.appIds,
            components: [
              { '/': '/signin/*' },
              ...(app?.tvLogin === true ||
              app?.origin === 'https://app.teamstation.app'
                ? [{ '/': '/tv-login' }]
                : [])
            ]
          }
        ]
      }
    })
  })

  router.get('/.well-known/assetlinks.json', (req, res, next) => {
    const android = appFor(req)?.android
    if (android == null) {
      next()
      return
    }
    sendJson(res, [
      {
        relation: ['delegate_permission/common.handle_all_urls'],
        target: {
          namespace: 'android_app',
          package_name: android.packageName,
          sha256_cert_fingerprints: android.sha256CertFingerprints
        }
      }
    ])
  })

  router.get('/tv-login', (_req, res, next) => {
    // The app shell renders confirmation. Link previews must neither spend
    // the credential nor forward it as a referrer or cache a private page.
    res.set('cache-control', 'no-store')
    res.set('referrer-policy', 'no-referrer')
    next()
  })

  router.get('/signin/:token', (req, res, next) => {
    if (appFor(req) == null) {
      next()
      return
    }
    res.set('cache-control', 'no-store')
    res.set('referrer-policy', 'no-referrer')
    const token = req.params.token
    if (!TOKEN.test(token)) {
      next(badRequest('That is not a sign-in link'))
      return
    }
    const asked = req.query.server
    if (asked != null && typeof asked !== 'string') {
      next(badRequest('That is not a sign-in link'))
      return
    }
    const server = asked ?? options.publicUrl
    if (!servers.has(server)) {
      next(badRequest('That link is for a server this one does not know'))
      return
    }
    res.redirect(302, `${server}/signin/${token}`)
  })

  return router
}
