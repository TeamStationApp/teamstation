import { expect } from 'chai'
import type { Router } from 'express'
import type { Kysely } from 'kysely'
import { describe, it } from 'mocha'
import type Provider from 'oidc-provider'

import {
  HIT_TRAJECTORIES,
  MOVEMENT_REASONS,
  PITCH_CODES,
  STORED_EVENT_TYPES
} from '../common/gumbo/reference'
import type { Database } from './db/database'
import type { MediaContext } from './media/mediaContext'
import { oauthInteractionRoutes } from './oauth/routes'
import { openApiDocument } from './openapi'
import { accountRoutes } from './routes/account'
import { adminRoutes } from './routes/admin'
import { authRoutes } from './routes/auth'
import { chatRoutes } from './routes/chat'
import { chatEpochRoutes } from './routes/chatEpochs'
import { chatKeyRoutes } from './routes/chatKeys'
import { chatMessageRoutes } from './routes/chatMessages'
import { directorRoutes } from './routes/director'
import { eventListRoutes } from './routes/eventList'
import { eventRoutes } from './routes/events'
import { followRoutes } from './routes/follows'
import { guardianRoutes } from './routes/guardians'
import { healthRoutes } from './routes/health'
import { inviteRoutes } from './routes/invites'
import { lineupRoutes } from './routes/lineups'
import { type LiveRouteOptions, liveRoutes } from './routes/live'
import { logRoutes } from './routes/logs'
import { manageRoutes } from './routes/manage'
import { meRoutes } from './routes/me'
import { mediaRoutes } from './routes/media'
import { playerRoutes } from './routes/players'
import { scheduleRoutes } from './routes/schedule'
import { scoreboardRoutes } from './routes/scoreboard'
import { seasonRoutes } from './routes/seasons'
import { statsRoutes } from './routes/stats'
import { teamMemberRoutes } from './routes/teamMembers'
import { teamRoutes } from './routes/teams'
import { userRoutes } from './routes/users'
import { walkUpSongRoutes } from './routes/walkUpSongs'
import type { ScoreboardStore } from './scoreboard/scoreboardStore'

/**
 * The document says what the API promises; the routers are what it does. This
 * is the check that they are the same list.
 *
 * Nothing here calls a route — the routers are built against a database that
 * would throw if anybody touched it, which is the point: what is being read is
 * the shape of the router, not its behaviour.
 */

const db = {} as unknown as Kysely<Database>
const store = {} as unknown as ScoreboardStore
const provider = {} as unknown as Provider
const oauthRoutes = (): string[] =>
  routesOf(oauthInteractionRoutes(db, provider, 'https://example.test'))
    .filter(route => route.includes(' /api/v1/'))
    .map(route => route.replace(' /api/v1/', ' /'))
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
  }
}
const live: LiveRouteOptions = {
  live: {
    enabled: true,
    bindHost: '127.0.0.1',
    port: 1936,
    app: 'live',
    segmentSeconds: 4,
    freeDiskFloorGb: 10
  },
  sessionSecret: 'secret',
  host: '127.0.0.1'
}

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> }
}

/** Every `METHOD /path` a router answers, in the document's spelling. */
function routesOf(router: Router): string[] {
  // Express keeps its layers on the router without declaring them.
  const { stack } = router as unknown as { stack: RouteLayer[] }
  const out: string[] = []
  for (const layer of stack) {
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
  'GET /videos/{videoId}/stills/{file}',
  'GET /videos/{videoId}/hls/{file}',
  'GET /videos/{videoId}/highlights'
])

/**
 * The scoreboard's sockets. The server's upgrade handler answers them, not a
 * router, so no router lists them; the document describes them all the same.
 */
const UPGRADE_ONLY = new Set([
  'GET /scoreboard/{gameId}/socket',
  'GET /scoreboard/{gameId}/publish',
  'GET /scoreboard/{gameId}/dashboard'
])

describe('the API document', function () {
  it('describes every route the server answers', function () {
    const mounted = [
      ...oauthRoutes(),
      ...routesOf(healthRoutes(db, '0.0.0')),
      ...routesOf(authRoutes(db, { sendCode: async () => undefined })),
      ...routesOf(
        accountRoutes(db, { ...media, sendCode: async () => undefined })
      ),
      ...routesOf(seasonRoutes(db, media)),
      ...routesOf(eventListRoutes(db, media)),
      ...routesOf(teamRoutes(db, media)),
      ...routesOf(followRoutes(db, media)),
      ...routesOf(chatRoutes(db, media)),
      ...routesOf(chatKeyRoutes(db)),
      ...routesOf(chatEpochRoutes(db)),
      ...routesOf(chatMessageRoutes(db, media)),
      ...routesOf(scheduleRoutes(db)),
      ...routesOf(teamMemberRoutes(db, media)),
      ...routesOf(eventRoutes(db)),
      ...routesOf(lineupRoutes(db)),
      ...routesOf(logRoutes()),
      ...routesOf(adminRoutes()),
      ...routesOf(statsRoutes(db)),
      ...routesOf(mediaRoutes(db, media)),
      ...routesOf(liveRoutes(db, live)),
      ...routesOf(directorRoutes(db, live)),
      ...routesOf(inviteRoutes(db, { sendCode: async () => undefined })),
      ...routesOf(manageRoutes(db, { sendInvite: async () => undefined })),
      ...routesOf(guardianRoutes(db, { sendInvite: async () => undefined })),
      ...routesOf(meRoutes(db)),
      ...routesOf(userRoutes(db)),
      ...routesOf(walkUpSongRoutes(db)),
      ...routesOf(scoreboardRoutes(db, store))
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
      ...oauthRoutes(),
      ...routesOf(healthRoutes(db, '0.0.0')),
      ...routesOf(authRoutes(db, { sendCode: async () => undefined })),
      ...routesOf(
        accountRoutes(db, { ...media, sendCode: async () => undefined })
      ),
      ...routesOf(seasonRoutes(db, media)),
      ...routesOf(eventListRoutes(db, media)),
      ...routesOf(teamRoutes(db, media)),
      ...routesOf(followRoutes(db, media)),
      ...routesOf(chatRoutes(db, media)),
      ...routesOf(chatKeyRoutes(db)),
      ...routesOf(chatEpochRoutes(db)),
      ...routesOf(chatMessageRoutes(db, media)),
      ...routesOf(scheduleRoutes(db)),
      ...routesOf(teamMemberRoutes(db, media)),
      ...routesOf(eventRoutes(db)),
      ...routesOf(lineupRoutes(db)),
      ...routesOf(logRoutes()),
      ...routesOf(adminRoutes()),
      ...routesOf(statsRoutes(db)),
      ...routesOf(mediaRoutes(db, media)),
      ...routesOf(liveRoutes(db, live)),
      ...routesOf(directorRoutes(db, live)),
      ...routesOf(inviteRoutes(db, { sendCode: async () => undefined })),
      ...routesOf(manageRoutes(db, { sendInvite: async () => undefined })),
      ...routesOf(guardianRoutes(db, { sendInvite: async () => undefined })),
      ...routesOf(meRoutes(db)),
      ...routesOf(userRoutes(db)),
      ...routesOf(walkUpSongRoutes(db)),
      // Only the player routes the document describes: the reads of a
      // player's page are left out of it, as they always have been.
      ...routesOf(playerRoutes(db, media)),
      ...routesOf(scoreboardRoutes(db, store))
    ])

    const paths = openApiDocument('0.0.0').paths
    const promised: string[] = []
    for (const [path, entry] of Object.entries(paths)) {
      for (const method of Object.keys(entry as Record<string, unknown>)) {
        promised.push(`${method.toUpperCase()} ${path}`)
      }
    }

    const invented = promised
      .filter(route => !mounted.has(route))
      .filter(route => !UPGRADE_ONLY.has(route))
    expect(
      invented,
      `promised but not served: ${invented.join(', ')}`
    ).deep.equals([])
  })

  it('describes a player\u2019s settings, with the positions a coach may give', function () {
    const paths = openApiDocument('0.0.0').paths as Record<
      string,
      { put?: { description?: string; requestBody?: unknown } }
    >
    const settings = paths['/teams/{teamId}/players/{userId}/settings']?.put
    expect(settings?.description ?? '').includes('coach')
    expect(settings?.description ?? '').includes('404')
    expect(JSON.stringify(settings?.requestBody)).includes('"DH"')
  })

  it('describes the box-score stats field and the events play contract', function () {
    const paths = openApiDocument('0.0.0').paths as Record<
      string,
      {
        get?: {
          description?: string
          responses?: Record<string, { description?: string }>
        }
        post?: { description?: string }
      }
    >
    const box = paths['/games/{gameId}/box-score']?.get
    expect(box?.description ?? '').includes('`stats`')
    expect(box?.description ?? '').includes('incomplete')
    expect(box?.responses?.['200']?.description ?? '').includes('stats')

    const events = paths['/games/{gameId}/events']?.post
    const eventsDescription = events?.description ?? ''
    expect(eventsDescription).includes('matchup.pitcher')
    expect(eventsDescription).includes('incomplete')
    expect(eventsDescription).includes('game_player_stats')
  })

  it('describes the stored play as Gumbo, with its codes and extensions', function () {
    const document = openApiDocument('0.0.0')
    const schemas = (document.components as { schemas: Record<string, any> })
      .schemas
    const play = schemas.GumboPlay
    const runner = schemas.GumboRunner.properties
    const pitch = schemas.GumboPitchEvent.properties
    const action = schemas.GumboActionEvent.properties

    const sorted = (codes: ReadonlySet<string>): string[] => [...codes].sort()
    expect(play.properties.result.properties.eventType.enum).deep.equals(
      sorted(STORED_EVENT_TYPES)
    )
    expect(play.properties.result.properties.eventType.enum).includes.members([
      'final_score',
      'score_correction',
      'ts_manual_placement',
      'ts_batter_out',
      'ts_batting_order'
    ])
    expect(runner.details.properties.eventType.enum).deep.equals(
      sorted(STORED_EVENT_TYPES)
    )
    expect(action.details.properties.eventType.enum).deep.equals(
      sorted(STORED_EVENT_TYPES)
    )
    expect(runner.details.properties.movementReason.enum).deep.equals([
      null,
      ...sorted(MOVEMENT_REASONS)
    ])
    expect(Object.keys(runner.movement.properties)).deep.equals([
      'originBase',
      'start',
      'end',
      'outBase',
      'isOut',
      'outNumber'
    ])
    expect(runner.movement.properties.end.enum).deep.equals([
      null,
      '1B',
      '2B',
      '3B',
      'score'
    ])
    expect(pitch.details.properties.code.enum).deep.equals(sorted(PITCH_CODES))
    expect(pitch.hitData.properties.trajectory.enum).deep.equals(
      sorted(HIT_TRAJECTORIES)
    )
    expect(play.properties.about.properties.halfOuts.description).includes(
      'TeamStation extension'
    )
    expect(play.properties.teamStation.$ref).equals(
      '#/components/schemas/TeamStationRecord'
    )

    const paths = document.paths as Record<string, any>
    const post = paths['/games/{gameId}/events'].post
    const body = post.requestBody.content['application/json'].schema
    expect(body.properties.plays.items.$ref).equals(
      '#/components/schemas/GumboPlay'
    )
    expect(body.properties.currentPlay.oneOf[0].$ref).equals(
      '#/components/schemas/GumboCurrentPlay'
    )
    const read =
      paths['/games/{gameId}/events'].get.responses[200].content[
        'application/json'
      ].schema
    expect(read.properties.plays.items.properties.gumbo.$ref).equals(
      '#/components/schemas/GumboPlay'
    )

    // Every reference names a schema the document has.
    const refs = JSON.stringify(document).match(/#\/components\/schemas\/\w+/g)
    for (const ref of refs ?? [])
      expect(schemas, ref).to.have.property(ref.split('/').at(-1)!)
  })
})
