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
import { ROLE_FLAGS, ROLES } from '../common/roles'
import type { Database } from './db/database'
import type { MediaContext } from './media/mediaContext'
import { oauthInteractionRoutes } from './oauth/routes'
import { openApiDocument } from './openapi'
import { accountRoutes } from './routes/account'
import { adminRoutes } from './routes/admin'
import { authRoutes } from './routes/auth'
import { chatRoutes } from './routes/chat'
import { chatAttachmentRoutes } from './routes/chatAttachments'
import { chatEpochRoutes } from './routes/chatEpochs'
import { chatKeyRoutes } from './routes/chatKeys'
import { chatMessageRoutes } from './routes/chatMessages'
import { deviceEventControlRoutes } from './routes/deviceEventControl'
import { directorRoutes } from './routes/director'
import { eventInfoRoutes } from './routes/eventInfo'
import { eventListRoutes } from './routes/eventList'
import { eventRoutes } from './routes/events'
import { followRoutes } from './routes/follows'
import { gameApprovalRoutes } from './routes/gameApprovals'
import { groupRoutes } from './routes/groups'
import { guardianRoutes } from './routes/guardians'
import { healthRoutes } from './routes/health'
import { inviteRoutes } from './routes/invites'
import { lineupRoutes } from './routes/lineups'
import { type LiveRouteOptions, liveRoutes } from './routes/live'
import { locationRoutes } from './routes/location'
import { manageRoutes } from './routes/manage'
import { meRoutes } from './routes/me'
import { mediaRoutes } from './routes/media'
import { nodeAdministrationRoutes } from './routes/nodeAdministration'
import { notificationRoutes } from './routes/notifications'
import { onboardingRoutes } from './routes/onboarding'
import { peopleRoutes } from './routes/people'
import { pictureRoutes } from './routes/pictures'
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
      ...routesOf(eventInfoRoutes(db, media)),
      ...routesOf(eventListRoutes(db, media)),
      ...routesOf(teamRoutes(db, media)),
      ...routesOf(followRoutes(db, media)),
      ...routesOf(chatRoutes(db, media)),
      ...routesOf(chatKeyRoutes(db)),
      ...routesOf(chatEpochRoutes(db)),
      ...routesOf(chatMessageRoutes(db, media)),
      ...routesOf(
        chatAttachmentRoutes(db, { space: media.space, uploadsDir: '/tmp' })
      ),
      ...routesOf(scheduleRoutes(db)),
      ...routesOf(teamMemberRoutes(db, media)),
      ...routesOf(eventRoutes(db)),
      ...routesOf(lineupRoutes(db)),
      ...routesOf(adminRoutes()),
      ...routesOf(statsRoutes(db)),
      ...routesOf(mediaRoutes(db, media)),
      ...routesOf(liveRoutes(db, live)),
      ...routesOf(directorRoutes(db, live)),
      ...routesOf(inviteRoutes(db, { sendCode: async () => undefined })),
      ...routesOf(manageRoutes(db, { sendInvite: async () => undefined })),
      ...routesOf(peopleRoutes(db, media)),
      ...routesOf(guardianRoutes(db, { sendInvite: async () => undefined })),
      ...routesOf(meRoutes(db)),
      ...routesOf(deviceEventControlRoutes(db, { secret: '', issuer: '' })),
      ...routesOf(onboardingRoutes(db, media)),
      ...routesOf(pictureRoutes(db, media.space)),
      ...routesOf(locationRoutes()),
      ...routesOf(groupRoutes(db, media)),
      ...routesOf(gameApprovalRoutes(db)),
      ...routesOf(notificationRoutes(db)),
      ...routesOf(userRoutes(db)),
      ...routesOf(nodeAdministrationRoutes(db)),
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
      ...routesOf(eventInfoRoutes(db, media)),
      ...routesOf(eventListRoutes(db, media)),
      ...routesOf(teamRoutes(db, media)),
      ...routesOf(followRoutes(db, media)),
      ...routesOf(chatRoutes(db, media)),
      ...routesOf(chatKeyRoutes(db)),
      ...routesOf(chatEpochRoutes(db)),
      ...routesOf(chatMessageRoutes(db, media)),
      ...routesOf(
        chatAttachmentRoutes(db, { space: media.space, uploadsDir: '/tmp' })
      ),
      ...routesOf(scheduleRoutes(db)),
      ...routesOf(teamMemberRoutes(db, media)),
      ...routesOf(eventRoutes(db)),
      ...routesOf(lineupRoutes(db)),
      ...routesOf(adminRoutes()),
      ...routesOf(statsRoutes(db)),
      ...routesOf(mediaRoutes(db, media)),
      ...routesOf(liveRoutes(db, live)),
      ...routesOf(directorRoutes(db, live)),
      ...routesOf(inviteRoutes(db, { sendCode: async () => undefined })),
      ...routesOf(manageRoutes(db, { sendInvite: async () => undefined })),
      ...routesOf(peopleRoutes(db, media)),
      ...routesOf(guardianRoutes(db, { sendInvite: async () => undefined })),
      ...routesOf(meRoutes(db)),
      ...routesOf(deviceEventControlRoutes(db, { secret: '', issuer: '' })),
      ...routesOf(onboardingRoutes(db, media)),
      ...routesOf(pictureRoutes(db, media.space)),
      ...routesOf(locationRoutes()),
      ...routesOf(groupRoutes(db, media)),
      ...routesOf(gameApprovalRoutes(db)),
      ...routesOf(notificationRoutes(db)),
      ...routesOf(userRoutes(db)),
      ...routesOf(nodeAdministrationRoutes(db)),
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

  it('declares the team suggestions and the public team row fields', function () {
    const parameters = (
      openApiDocument('0.0.0').paths as Record<
        string,
        {
          get?: {
            parameters?: Array<{ name: string; description?: string }>
          }
        }
      >
    )['/teams']?.get?.parameters
    const named = (name: string): string =>
      parameters?.find(parameter => parameter.name === name)?.description ?? ''
    expect(named('relatedTeam')).includes('view=public')
    expect(named('relatedTeam')).includes('404')
    expect(named('relatedTeam')).includes('six months')
    expect(named('relatedSeason')).includes('404')
    expect(named('query')).includes('seasonNames')
    expect(named('query')).includes('staffNames')
  })

  it('lets a practice be created and kept without a title', function () {
    const paths = openApiDocument('0.0.0').paths as Record<string, any>
    const create =
      paths['/events'].post.requestBody.content['application/json'].schema
    expect(create.required).not.includes('title')
    expect(create.properties.title.description).includes('Practice')
    const update = JSON.stringify(paths['/events/{id}/info'].put)
    expect(update).includes('Title is required')
  })

  it('documents guardian invitations and requests beside the other relationship requests', function () {
    const post = (openApiDocument('0.0.0').paths as Record<string, any>)[
      '/relationship-requests'
    ].post
    const [relationship, guardian] =
      post.requestBody.content['application/json'].schema.oneOf
    expect(relationship.required).deep.equals([
      'kind',
      'sender',
      'idempotencyKey'
    ])
    expect(relationship.properties.kind.enum).not.includes('guardian')
    expect(guardian.required).deep.equals([
      'kind',
      'playerUserId',
      'guardian',
      'idempotencyKey'
    ])
    expect(guardian.properties.kind.enum).deep.equals(['guardian'])
    expect(
      guardian.properties.guardian.oneOf.map(
        (option: { required: string[] }) => option.required
      )
    ).deep.equals([['userId'], ['email']])
    expect(guardian.properties.sender.properties.kind.enum).deep.equals([
      'team'
    ])
    expect(guardian.properties.idempotencyKey).deep.equals({
      type: 'string',
      minLength: 8,
      maxLength: 120
    })
    expect(post.summary).includes('guardian invitation')
    expect(post.description).includes('A guardian request has no `sender`')
    expect(post.description).includes('429 `rateLimited`')
  })

  it('describes a roster entry\u2019s section, staff roles and inherited pill', function () {
    const document = openApiDocument('0.0.0')
    const schemas = (document.components as { schemas: Record<string, any> })
      .schemas
    const entry = schemas.RosterEntry
    expect(entry.required).to.include.members([
      'section',
      'staffRoles',
      'inheritedFrom'
    ])
    expect(entry.required).not.to.include('group')
    expect(entry.properties).not.to.have.property('group')
    expect(entry.properties.section.enum).deep.equals([
      'admin',
      'staff',
      'player',
      'family',
      'spectator',
      'follower'
    ])
    expect(entry.properties.staffRoles.items).deep.equals({
      $ref: '#/components/schemas/RoleFlag'
    })
    expect(
      entry.properties.inheritedFrom.oneOf[0].properties.level.enum
    ).deep.equals(['season', 'league'])
    // A spectator's pill names membership, which is not a role.
    expect(
      entry.properties.inheritedFrom.oneOf[0].properties.role.oneOf
    ).deep.equals([
      { $ref: '#/components/schemas/Role' },
      { type: 'string', enum: ['member'] }
    ])
    const paths = document.paths as Record<string, any>
    expect(
      paths['/teams/{teamId}/roster'].get.responses[200].content[
        'application/json'
      ].schema.items
    ).deep.equals({ $ref: '#/components/schemas/RosterEntry' })
    expect(
      paths['/teams/{teamId}/players/{userId}/settings'].put.responses[200]
        .content['application/json'].schema
    ).deep.equals({ $ref: '#/components/schemas/RosterEntry' })
  })

  it('lists every role flag, the assistant included, wherever roles are named', function () {
    const document = openApiDocument('0.0.0')
    const schemas = (document.components as { schemas: Record<string, any> })
      .schemas
    expect(schemas.Role.enum).deep.equals([...ROLES])
    expect(schemas.RoleFlag.enum).deep.equals([...ROLE_FLAGS])
    expect(schemas.Role.description).includes('`assistant`')
    const paths = document.paths as Record<string, any>
    const invite =
      paths['/manage/{scopeType}/{scopeId}/people'].post.requestBody.content[
        'application/json'
      ].schema
    expect(invite.properties.flags.items.enum).deep.equals([...ROLE_FLAGS])
    const personal =
      paths['/relationship-requests'].post.requestBody.content[
        'application/json'
      ].schema.oneOf[0]
    expect(personal.properties.flags.items.enum).deep.equals([...ROLE_FLAGS])
    expect(
      paths['/manage/{scopeType}/{scopeId}/people/{userId}/roles'].put
        .description
    ).includes('`assistant`')
    expect(
      paths['/teams/{teamId}/players/{userId}/settings'].put.description
    ).includes('assistant')
    expect(
      paths['/teams/{teamId}/players/{userId}/walk-up-song'].put.description
    ).includes('scorekeeper')
    expect(paths['/games/{gameId}'].get.description).includes(
      'songkeeper or scorekeeper'
    )
    expect(paths['/me/roles'].get.description).includes('`songkeeper`')
  })

  it('describes what a guardian may read and change', function () {
    const paths = openApiDocument('0.0.0').paths as Record<string, any>
    const hands = paths['/players/{userId}/settings'].put
    expect(hands.description).includes('guardian')
    expect(hands.description).includes('400')
    expect(hands.description).includes('404')
    expect(
      Object.keys(
        hands.requestBody.content['application/json'].schema.properties
      )
    ).deep.equals(['bats', 'throws'])
    expect(
      paths['/teams/{teamId}/players/{userId}/settings'].put.description
    ).includes('guardian')
    expect(
      paths['/teams/{teamId}/players/{userId}/walk-up-song'].put.description
    ).includes('guardian')
    const roles =
      paths['/me/roles'].get.responses[200].content['application/json'].schema
    expect(roles.required).deep.equals(['teams', 'guardianOf'])
    expect(roles.properties.guardianOf.type).equals('array')
    const users = paths['/users'].get
    const guardedBy = users.parameters.find(
      (parameter: { name: string }) => parameter.name === 'guardedBy'
    )
    expect(guardedBy.schema.enum).deep.equals(['me'])
    expect(users.description).includes('`guardedBy=me`')
    expect(users.description).includes('shortName')
  })

  it("says which of a player's teams they play on now", function () {
    const document = openApiDocument('0.0.0')
    const schemas = (document.components as { schemas: Record<string, any> })
      .schemas
    expect(schemas.PlayerTeam.required).to.include.members([
      'jersey',
      'positions',
      'current'
    ])
    expect(schemas.PlayerTeam.properties.current).deep.equals({
      type: 'boolean'
    })
    const paths = document.paths as Record<string, any>
    expect(
      paths['/players/{userId}'].get.responses[200].content['application/json']
        .schema.properties.teams.items
    ).deep.equals({ $ref: '#/components/schemas/PlayerTeam' })
  })

  it("narrows a player's highlights by the stats filter", function () {
    const paths = openApiDocument('0.0.0').paths as Record<string, any>
    const names = (route: string): string[] =>
      paths[route].get.parameters.map(
        (parameter: { name: string }) => parameter.name
      )
    expect(names('/players/{userId}/highlights')).deep.equals([
      'userId',
      'before',
      'limit',
      'seasonId',
      'teamId',
      'year'
    ])
    const filter = (route: string): unknown[] =>
      paths[route].get.parameters.filter((parameter: { name: string }) =>
        ['seasonId', 'teamId', 'year'].includes(parameter.name)
      )
    expect(filter('/players/{userId}/highlights')).deep.equals(
      filter('/players/{userId}/stats')
    )
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
