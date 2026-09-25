import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { describe, it } from 'mocha'

import type { Database } from './db/database'
import type { MediaContext } from './media/mediaContext'
import { openApiDocument } from './openapi'
import { authRoutes } from './routes/auth'
import { directorRoutes } from './routes/director'
import { eventRoutes } from './routes/events'
import { healthRoutes } from './routes/health'
import { inviteRoutes } from './routes/invites'
import { liveRoutes } from './routes/live'
import { manageRoutes } from './routes/manage'
import { mediaRoutes } from './routes/media'
import { seasonRoutes } from './routes/seasons'
import { statsRoutes } from './routes/stats'
import { teamRoutes } from './routes/teams'

/**
 * The document says what the API promises; the routers are what it does. This
 * is the check that they are the same list.
 *
 * Nothing here calls a route — the routers are built against a database that
 * would throw if anybody touched it, which is the point: what is being read is
 * the shape of the router, not its behaviour.
 */

const db = {} as unknown as Kysely<Database>
const media: MediaContext = {
  ffmpegPath: '/usr/bin/ffmpeg',
  mediaRoot: '/tmp',
  mediaSecret: 'secret',
  publicUrl: 'http://127.0.0.1',
  space: {
    endpoint: '',
    region: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    pathStyle: false
  },
  workDir: '/tmp'
}
const live = {
  live: {
    enabled: true,
    bindHost: '127.0.0.1',
    port: 1936,
    app: 'live',
    segmentSeconds: 4,
    closeAfterHours: 6
  },
  sessionSecret: 'secret',
  host: '127.0.0.1'
}

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> }
}

/** Every `METHOD /path` a router answers, in the document's spelling. */
function routesOf(router: { stack: RouteLayer[] }): string[] {
  const out: string[] = []
  for (const layer of router.stack) {
    const route = layer.route
    if (route == null) continue
    // Express writes `:gameId`; OpenAPI writes `{gameId}`.
    const path = route.path.replace(/:([A-Za-z0-9_]+)/g, '{$1}')
    for (const method of Object.keys(route.methods)) {
      if (method === '_all') continue
      out.push(`${method.toUpperCase()} ${path}`)
    }
  }
  return out
}

/**
 * Routes that are deliberately not in the document.
 *
 * Two kinds: things that are not the API at all — a page somebody reads, the
 * document itself — and the media paths, which a player is handed rather than
 * calls, and whose tokens would be meaningless in a specification.
 */
const UNDOCUMENTED = new Set([
  'GET /videos/{videoId}/playback',
  'GET /videos/{videoId}/still',
  'GET /videos/{videoId}/hls/{file}',
  'GET /videos/{videoId}/highlights'
])

describe('the API document', function () {
  it('describes every route the server answers', function () {
    const mounted = [
      ...routesOf(healthRoutes(db, '0.0.0')),
      ...routesOf(authRoutes(db, { sendCode: async () => undefined })),
      ...routesOf(seasonRoutes(db, media)),
      ...routesOf(teamRoutes(db, media)),
      ...routesOf(eventRoutes(db)),
      ...routesOf(statsRoutes(db)),
      ...routesOf(mediaRoutes(db, media)),
      ...routesOf(liveRoutes(db, live)),
      ...routesOf(directorRoutes(db, live)),
      ...routesOf(inviteRoutes(db, { sendCode: async () => undefined })),
      ...routesOf(manageRoutes(db, { sendInvite: async () => undefined }))
    ]

    const documented = new Set<string>()
    const paths = openApiDocument('0.0.0').paths
    for (const [path, entry] of Object.entries(paths)) {
      for (const method of Object.keys(entry as Record<string, unknown>)) {
        documented.add(`${method.toUpperCase()} ${path}`)
      }
    }

    const missing = mounted
      .filter(route => !documented.has(route))
      .filter(route => !UNDOCUMENTED.has(route))
    expect(missing, `undocumented: ${missing.join(', ')}`).deep.equals([])
  })

  it('describes nothing the server does not answer', function () {
    const mounted = new Set([
      ...routesOf(healthRoutes(db, '0.0.0')),
      ...routesOf(authRoutes(db, { sendCode: async () => undefined })),
      ...routesOf(seasonRoutes(db, media)),
      ...routesOf(teamRoutes(db, media)),
      ...routesOf(eventRoutes(db)),
      ...routesOf(statsRoutes(db)),
      ...routesOf(mediaRoutes(db, media)),
      ...routesOf(liveRoutes(db, live)),
      ...routesOf(directorRoutes(db, live)),
      ...routesOf(inviteRoutes(db, { sendCode: async () => undefined })),
      ...routesOf(manageRoutes(db, { sendInvite: async () => undefined }))
    ])

    const paths = openApiDocument('0.0.0').paths
    const promised: string[] = []
    for (const [path, entry] of Object.entries(paths)) {
      for (const method of Object.keys(entry as Record<string, unknown>)) {
        promised.push(`${method.toUpperCase()} ${path}`)
      }
    }

    const invented = promised.filter(route => !mounted.has(route))
    expect(
      invented,
      `promised but not served: ${invented.join(', ')}`
    ).deep.equals([])
  })
})
