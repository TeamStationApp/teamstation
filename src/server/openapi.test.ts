import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { describe, it } from 'mocha'
import type Provider from 'oidc-provider'

import {
  HIT_TRAJECTORIES,
  MOVEMENT_REASONS,
  PITCH_CODES,
  STORED_EVENT_TYPES
} from '../common/gumbo/reference'
import { idPrefixes, makeId } from '../common/ids'
import { ROLE_FLAGS, ROLES } from '../common/roles'
import { PITCH_TYPE_CODES } from '../common/scoring/pitchType'
import { routesOf } from '../test/routeTable'
import type { Database } from './db/database'
import type { MediaContext } from './media/mediaContext'
import { oauthInteractionRoutes } from './oauth/routes'
import { analyticsRoutes } from './observability/routes'
import { openApiDocument } from './openapi'
import { accountRoutes } from './routes/account'
import { adminRoutes } from './routes/admin'
import { apiKeyRoutes } from './routes/apiKeys'
import { authRoutes } from './routes/auth'
import { chatRoutes } from './routes/chat'
import { chatAttachmentRoutes } from './routes/chatAttachments'
import { chatEpochRoutes } from './routes/chatEpochs'
import { chatKeyRoutes } from './routes/chatKeys'
import { chatMessageRoutes } from './routes/chatMessages'
import { deviceEventControlRoutes } from './routes/deviceEventControl'
import { directorRoutes } from './routes/director'
import { directorUploadRoutes } from './routes/directorUploads'
import { eventInfoRoutes } from './routes/eventInfo'
import { eventListRoutes } from './routes/eventList'
import { eventRoutes } from './routes/events'
import { followRoutes } from './routes/follows'
import { gameApprovalRoutes } from './routes/gameApprovals'
import { gamePlanRoutes } from './routes/gamePlans'
import { graphqlRoutes } from './routes/graphql'
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
import { narrationRoutes } from './routes/narrations'
import { nodeAdministrationRoutes } from './routes/nodeAdministration'
import { notificationRoutes } from './routes/notifications'
import { onboardingRoutes } from './routes/onboarding'
import { peopleRoutes } from './routes/people'
import { pictureRoutes } from './routes/pictures'
import { playerRoutes } from './routes/players'
import { pushRoutes } from './routes/push'
import { scheduleRoutes } from './routes/schedule'
import { schedulePreviewRoutes } from './routes/schedulePreviews'
import { schedulingSetupRoutes } from './routes/schedulingSetup'
import { scoreboardRoutes } from './routes/scoreboard'
import { seasonRoutes } from './routes/seasons'
import { statsRoutes } from './routes/stats'
import { teamMemberRoutes } from './routes/teamMembers'
import { teamRoutes } from './routes/teams'
import { tessRoutes } from './routes/tess'
import { timeRoutes } from './routes/time'
import { umpireRoutes } from './routes/umpires'
import { userRoutes } from './routes/users'
import { venueRoutes } from './routes/venues'
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
  host: '127.0.0.1',
  space: media.space,
  mediaRoot: media.mediaRoot,
  uploadsDir: '/tmp'
}

const uploads = {
  uploadsDir: '/tmp',
  mediaRoot: '/tmp',
  ffmpegPath: '/usr/bin/ffmpeg'
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
 * The scoreboard's and search's sockets. The server's upgrade handler
 * answers them, not a router, so no router lists them; the document
 * describes them all the same.
 */
const UPGRADE_ONLY = new Set([
  'GET /scoreboard/{gameId}/socket',
  'GET /scoreboard/{gameId}/publish',
  'GET /scoreboard/{gameId}/dashboard',
  'GET /search'
])

describe('the API document', function () {
  it('documents the guarded development password login and account confirmation', () => {
    const { post: op } = openApiDocument('0.0.0').paths[
      '/auth/password/link'
    ] as { post: any }
    const body = op.requestBody.content['application/json'].schema
    expect(body.required).deep.equals(['email', 'clientHash'])
    expect(body.properties.confirmation.required).deep.equals([
      'currentId',
      'targetId'
    ])
    const [prompt, stale] =
      op.responses[409].content['application/json'].schema.oneOf
    const details = prompt.properties.details
    expect(details.required).deep.equals([
      'reason',
      'confirmation',
      'currentLabel',
      'targetLabel'
    ])
    expect(details.properties.reason.const).equals('confirmAccountSwitch')
    expect(details.properties.confirmation).deep.equals(
      body.properties.confirmation
    )
    expect(stale.not.required).deep.equals(['details'])
    expect(Object.keys(op.responses)).includes.members([
      '200',
      '401',
      '404',
      '409',
      '429'
    ])
  })

  it('declares nullable replay pitcher hit batters and strikes', function () {
    const schemas = openApiDocument('0.0.0').components.schemas as Record<
      string,
      any
    >
    for (const side of ['away', 'home']) {
      const pitching =
        schemas.HistoricalBox.properties[side].properties.pitching.items
      for (const field of ['hbp', 'strikes', 'pc']) {
        expect(pitching.required).includes(field)
        expect(pitching.properties[field]).deep.equals({
          type: ['integer', 'null']
        })
      }
    }
  })
  it('describes every route the server answers', function () {
    const mounted = [
      ...oauthRoutes(),
      ...routesOf(healthRoutes(db, '0.0.0')),
      ...routesOf(timeRoutes()),
      ...routesOf(authRoutes(db, { sendCode: async () => undefined })),
      ...routesOf(
        accountRoutes(db, { ...media, sendCode: async () => undefined })
      ),
      ...routesOf(apiKeyRoutes(db, { sessionSecret: 'secret' })),
      ...routesOf(pushRoutes(db, { webPushKey: null })),
      ...routesOf(graphqlRoutes({ db, origin: () => 'http://127.0.0.1' })),
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
      ...routesOf(gamePlanRoutes(db)),
      ...routesOf(narrationRoutes(db, null)),
      ...routesOf(adminRoutes()),
      ...routesOf(analyticsRoutes(db)),
      ...routesOf(statsRoutes(db)),
      ...routesOf(mediaRoutes(db, media)),
      ...routesOf(liveRoutes(db, live)),
      ...routesOf(directorRoutes(db, live)),
      ...routesOf(directorUploadRoutes(db, uploads)),
      ...routesOf(inviteRoutes(db, { sendCode: async () => undefined })),
      ...routesOf(manageRoutes(db, { sendInvite: async () => undefined })),
      ...routesOf(peopleRoutes(db, media)),
      ...routesOf(guardianRoutes(db, { sendInvite: async () => undefined })),
      ...routesOf(meRoutes(db, undefined, media)),
      ...routesOf(deviceEventControlRoutes(db, { secret: '', issuer: '' })),
      ...routesOf(onboardingRoutes(db, media)),
      ...routesOf(pictureRoutes(db, media.space)),
      ...routesOf(locationRoutes()),
      ...routesOf(groupRoutes(db, media)),
      ...routesOf(gameApprovalRoutes(db)),
      ...routesOf(umpireRoutes(db)),
      ...routesOf(notificationRoutes(db)),
      ...routesOf(userRoutes(db)),
      ...routesOf(nodeAdministrationRoutes(db)),
      ...routesOf(walkUpSongRoutes(db)),
      ...routesOf(venueRoutes(db, media)),
      ...routesOf(schedulingSetupRoutes(db)),
      ...routesOf(schedulePreviewRoutes(db)),
      ...routesOf(scoreboardRoutes(db, store)),
      ...routesOf(tessRoutes(db, { settings: null, origin: () => '' }))
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
      ...routesOf(timeRoutes()),
      ...routesOf(authRoutes(db, { sendCode: async () => undefined })),
      ...routesOf(
        accountRoutes(db, { ...media, sendCode: async () => undefined })
      ),
      ...routesOf(apiKeyRoutes(db, { sessionSecret: 'secret' })),
      ...routesOf(pushRoutes(db, { webPushKey: null })),
      ...routesOf(graphqlRoutes({ db, origin: () => 'http://127.0.0.1' })),
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
      ...routesOf(gamePlanRoutes(db)),
      ...routesOf(narrationRoutes(db, null)),
      ...routesOf(adminRoutes()),
      ...routesOf(analyticsRoutes(db)),
      ...routesOf(statsRoutes(db)),
      ...routesOf(mediaRoutes(db, media)),
      ...routesOf(liveRoutes(db, live)),
      ...routesOf(directorRoutes(db, live)),
      ...routesOf(directorUploadRoutes(db, uploads)),
      ...routesOf(inviteRoutes(db, { sendCode: async () => undefined })),
      ...routesOf(manageRoutes(db, { sendInvite: async () => undefined })),
      ...routesOf(peopleRoutes(db, media)),
      ...routesOf(guardianRoutes(db, { sendInvite: async () => undefined })),
      ...routesOf(meRoutes(db, undefined, media)),
      ...routesOf(deviceEventControlRoutes(db, { secret: '', issuer: '' })),
      ...routesOf(onboardingRoutes(db, media)),
      ...routesOf(pictureRoutes(db, media.space)),
      ...routesOf(locationRoutes()),
      ...routesOf(groupRoutes(db, media)),
      ...routesOf(gameApprovalRoutes(db)),
      ...routesOf(umpireRoutes(db)),
      ...routesOf(notificationRoutes(db)),
      ...routesOf(userRoutes(db)),
      ...routesOf(nodeAdministrationRoutes(db)),
      ...routesOf(walkUpSongRoutes(db)),
      ...routesOf(venueRoutes(db, media)),
      ...routesOf(schedulingSetupRoutes(db)),
      ...routesOf(schedulePreviewRoutes(db)),
      // Only the player routes the document describes: the reads of a
      // player's page are left out of it, as they always have been.
      ...routesOf(playerRoutes(db, media)),
      ...routesOf(scoreboardRoutes(db, store)),
      ...routesOf(tessRoutes(db, { settings: null, origin: () => '' }))
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

  it('describes the search socket, its frames and its close codes', function () {
    const paths = openApiDocument('0.0.0').paths as Record<
      string,
      { get?: { description?: string; responses?: Record<string, unknown> } }
    >
    const socket = paths['/search']?.get
    expect(Object.keys(socket?.responses ?? {})).includes('101')
    for (const phrase of ["stage: 'jev'", 'latest', '4401', 'Origin', '4096'])
      expect(socket?.description ?? '').includes(phrase)
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

  it('documents optional authentication and the public game projection', () => {
    const paths = openApiDocument('0.0.0').paths as Record<string, any>
    const game = paths['/games/{gameId}'].get
    expect(game.security).deep.equals([{}, { bearer: [] }])
    for (const text of [
      'anonymous callers',
      'Private notes',
      'detailed statistics still require team membership'
    ])
      expect(game.description).includes(text)
  })

  it('declares each parameter of an operation once', function () {
    const paths = openApiDocument('0.0.0').paths as Record<string, any>
    const twice: string[] = []
    for (const [route, operations] of Object.entries(paths))
      for (const [method, operation] of Object.entries(
        operations as Record<string, { parameters?: unknown[] }>
      )) {
        const seen = new Set<string>()
        for (const parameter of (operation.parameters ?? []) as Array<{
          name: string
          in: string
        }>) {
          const key = `${parameter.in}:${parameter.name}`
          if (seen.has(key)) twice.push(`${method} ${route} ${key}`)
          seen.add(key)
        }
      }
    expect(twice).deep.equals([])
  })

  it('says who may read public games, and what a public list takes', function () {
    const paths = openApiDocument('0.0.0').paths as Record<string, any>
    const names = (route: string): string[] =>
      paths[route].get.parameters.map(
        (parameter: { name: string }) => parameter.name
      )
    for (const route of [
      '/teams/{teamId}/games',
      '/seasons/{seasonId}/games'
    ]) {
      expect(paths[route].get.security).deep.equals([{}, { bearer: [] }])
      expect(names(route)).includes.members([
        'when',
        'order',
        'limit',
        'paged',
        'cursor',
        'hasVideo',
        'public'
      ])
    }
    expect(names('/seasons/{seasonId}/games')).not.include('around')
    expect(names('/leagues/{leagueId}/umpire-schedule')).includes.members([
      'paged',
      'cursor',
      'around',
      'limit'
    ])
  })

  it('documents the umpire schedule’s sort, the league default and the season order', function () {
    const paths = openApiDocument('0.0.0').paths as Record<string, any>
    const scheduleRead = paths['/leagues/{leagueId}/umpire-schedule'].get
    const sort = scheduleRead.parameters.find(
      (parameter: { name: string }) => parameter.name === 'sort'
    )
    expect(sort.in).equals('query')
    for (const words of [
      'seasonPriority',
      'certification',
      '`none`',
      'date,season'
    ])
      expect(sort.description).includes(words)
    expect(
      scheduleRead.parameters.find(
        (parameter: { name: string }) => parameter.name === 'cursor'
      ).description
    ).includes('carries the sort')
    expect(scheduleRead.responses[200].description).includes('settings.sort')
    const settings = paths['/leagues/{leagueId}/umpire-settings']
    const saved =
      settings.put.requestBody.content['application/json'].schema.properties
        .sort
    expect(saved.type).deep.equals(['array', 'null'])
    expect(saved.maxItems).equals(2)
    expect(saved.items.enum).includes.members(['-date', 'seasonPriority'])
    expect(saved.description).includes('`[]` is the empty sort')
    expect(settings.get.summary).includes('default sort')
    const priority = paths['/leagues/{leagueId}/umpire-season-priority']
    expect(Object.keys(priority)).deep.equals(['put'])
    expect(
      priority.put.requestBody.content['application/json'].schema
    ).deep.include({ required: ['seasonIds'] })
    expect(priority.put.security).deep.equals([{ bearer: [] }])
    expect(priority.put.description).includes('positions 1…N')
    expect(
      paths['/leagues/{leagueId}/umpire-requirements'].get.description
    ).includes('`priority`')
  })

  it('documents an admin’s own Umpire Management Notifications, a notice’s game as `around`, and League management', function () {
    const paths = openApiDocument('0.0.0').paths as Record<string, any>
    const notices = paths['/leagues/{leagueId}/umpire-notifications']
    expect(Object.keys(notices).sort()).deep.equals(['get', 'put'])
    const answer = notices.get.responses[200].content['application/json'].schema
    expect(answer.required).deep.equals([
      'missingSlots',
      'daysBefore',
      'signUps',
      'withdrawals'
    ])
    expect(answer.properties.daysBefore).deep.include({
      type: 'integer',
      minimum: 1,
      maximum: 30
    })
    expect(answer.properties.missingSlots.description).includes('10:00')
    // The window is counted as `digestGames` counts it, and docs/api.md says.
    expect(answer.properties.daysBefore.description).includes(
      'counted in each game’s own zone (`games.timezone`), as the umpire schedule dates it'
    )
    expect(answer.properties.daysBefore.description).not.includes('season')
    expect(notices.get.description).includes('`leagueManagement`')
    expect(notices.put.security).deep.equals([{ bearer: [] }])
    expect(
      notices.put.requestBody.content['application/json'].schema.required
    ).equals(undefined)
    const around = paths[
      '/leagues/{leagueId}/umpire-schedule'
    ].get.parameters.find(
      (parameter: { name: string }) => parameter.name === 'around'
    )
    expect(around.description).includes('A game id opens it on that game')
    expect(new RegExp(around.schema.pattern).test('gam_one')).equals(true)
    expect(new RegExp(around.schema.pattern).test('next')).equals(true)
    expect(new RegExp(around.schema.pattern).test('bogus')).equals(false)
    // The game prefix comes from `idPrefixes`, as the server checks it.
    expect(around.schema.pattern).equals(
      `^(next|${idPrefixes.game}_[A-Za-z0-9_-]{1,64})$`
    )
    expect(new RegExp(around.schema.pattern).test(makeId('game'))).equals(true)
    expect(new RegExp(around.schema.pattern).test(makeId('league'))).equals(
      false
    )
    const registration = paths['/me/push-registrations'].post
    expect(
      registration.requestBody.content['application/json'].schema.properties
        .leagueManagement
    ).deep.include({ type: 'boolean', default: true })
    expect(registration.description).includes('League management notices')
    const patched = paths['/me/push-registrations/{id}'].patch
    expect(
      patched.responses[200].content['application/json'].schema.required
    ).includes('leagueManagement')
    const inbox = paths['/me/notifications'].get.description
    for (const words of [
      'umpireMissingSlots',
      'umpireSignUp',
      'umpireWithdraw'
    ])
      expect(inbox).includes(words)
  })

  it('documents umpire availability: saving your own, querying the list by it, and an umpire’s commitments', function () {
    const document = openApiDocument('0.0.0') as any
    const paths = document.paths as Record<string, any>
    const mine = paths['/leagues/{leagueId}/me/umpire-availability']
    expect(Object.keys(mine).sort()).deep.equals(['get', 'put'])
    const availability =
      mine.put.requestBody.content['application/json'].schema.properties
        .availability
    expect(availability.type).deep.equals(['object', 'null'])
    expect(availability.required).deep.equals([
      'levels',
      'days',
      'from',
      'to',
      'timezone'
    ])
    expect(availability.description).includes('0 is Monday')
    const list = paths['/leagues/{leagueId}/umpires'].get
    const parameters = new Map(
      list.parameters.map((parameter: { name: string }) => [
        parameter.name,
        parameter
      ])
    )
    expect([...parameters.keys()]).deep.equals([
      'leagueId',
      'availableAt',
      'durationMinutes',
      'day',
      'time',
      'level',
      'strict'
    ])
    expect((parameters.get('day') as any).description).includes('0 is Monday')
    // day and time are wall-clock in each umpire's zone; a game is availableAt.
    for (const name of ['day', 'time'])
      expect((parameters.get(name) as any).description).match(
        /own saved zone.*use `availableAt`/
      )
    expect(list.description).includes('For a game, pass `availableAt`')
    expect(list.description).includes('umpireAvailability')
    expect(list.description).includes('unless `strict`')
    expect(list.description).includes('on the start')
    // PUT answers the list in GET's shape.
    expect(
      paths['/leagues/{leagueId}/umpires'].put.responses[200].description
    ).includes('umpireAvailability')
    const commitments =
      paths['/leagues/{leagueId}/umpires/{userId}/commitments'].get
    expect(
      commitments.parameters.map(
        (parameter: { name: string }) => parameter.name
      )
    ).deep.equals(['leagueId', 'userId', 'from', 'to'])
    expect(commitments.description).includes('31 days')
    const profile = document.components.schemas.PersonProfile
    expect(profile.properties.umpireAvailability.type).deep.equals([
      'object',
      'null'
    ])
    expect(profile.required).not.includes('umpireAvailability')
    expect(paths['/leagues/{id}/people/{userId}'].get.description).includes(
      'umpireAvailability'
    )
  })

  it('lists every role flag, the assistant included, wherever roles are named', function () {
    const document = openApiDocument('0.0.0')
    const schemas = (document.components as { schemas: Record<string, any> })
      .schemas
    const section = schemas.PersonProfile.properties.sections.items
    expect(section.required).not.includes('headCoach')
    const designation = section.properties.headCoach
    expect(designation.required).deep.equals(['userId', 'name'])
    expect(designation.properties.userId).deep.equals(
      schemas.PersonProfile.properties.person.properties.userId
    )
    expect(designation.properties.name).deep.equals({ type: 'string' })
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

  it("describes a player's stats split into rows, last in the answer", function () {
    const paths = openApiDocument('0.0.0').paths as Record<string, any>
    const description: string = paths['/players/{userId}/stats'].get.description
    expect(description).includes('`splits`, last in the answer')
    expect(description).includes('`by` `team` for a career')
    expect(description).includes('`by` `game` under a season, team or year')
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

  it('describes when a lineup change was made, and the later one winning (U44)', function () {
    const paths = openApiDocument('0.0.0').paths as Record<string, any>
    const body =
      paths['/games/{gameId}/lineups'].post.requestBody.content[
        'application/json'
      ].schema
    expect(body.properties.changedAt).deep.include({
      type: 'string',
      format: 'date-time'
    })
    expect(body.required ?? []).not.includes('changedAt')
    expect(body.properties.changedAt.description).includes(
      '`details: { stale: true, newer: true }`'
    )
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
    // The kind of pitch and where the scorer said it went.
    expect(pitch.details.properties.type.properties.code.enum).deep.equals(
      PITCH_TYPE_CODES
    )
    expect(pitch.pitchData.properties.location.required).deep.equals([
      'height',
      'side',
      'inZone'
    ])
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

  it('describes the node settings once, a speed hold above 0, for reading and replacing them', function () {
    const path = (
      openApiDocument('0.0.0').paths as Record<string, Record<string, any>>
    )['/node/settings']
    const read = path.get.responses[200].content['application/json'].schema
    const sent = path.put.requestBody.content['application/json'].schema
    const answered = path.put.responses[200].content['application/json'].schema
    expect(sent).equals(read)
    expect(answered).equals(read)
    expect(read.properties.scoreboard.properties.speedHoldSec).deep.include({
      exclusiveMinimum: 0,
      maximum: 600
    })
    expect(
      read.properties.scoreboard.properties.speedHoldSec
    ).not.have.property('minimum')
    // A play type's key as the server takes it (`asLeadMap`).
    const leads = read.properties.highlights.properties.leadSecByEventType
    const pattern = new RegExp(leads.propertyNames.pattern)
    expect(pattern.test('home_run')).equals(true)
    expect(pattern.test('Home-Run')).equals(false)
  })

  it('says only whether a Jev key is set, and documents the key routes for node administrators', function () {
    const paths = openApiDocument('0.0.0').paths as Record<
      string,
      Record<string, any>
    >
    const read =
      paths['/node/settings'].get.responses[200].content['application/json']
        .schema
    expect(read.properties.jev).deep.include({ required: ['configured'] })
    expect(read.properties.jev.properties).deep.equals({
      configured: { type: 'boolean' }
    })
    const key = paths['/node/jev-key']
    expect(Object.keys(key).sort()).deep.equals(['delete', 'put'])
    const body = key.put.requestBody.content['application/json'].schema
    expect(body.required).deep.equals(['apiKey'])
    expect(
      new RegExp(body.properties.apiKey.pattern).test(' ts-key_1 ')
    ).equals(true)
    expect(new RegExp(body.properties.apiKey.pattern).test('two words')).equals(
      false
    )
    for (const method of ['put', 'delete']) {
      expect(key[method].responses).to.have.property('403')
      expect(
        key[method].responses[200].content['application/json'].schema.properties
      ).deep.equals({ configured: { type: 'boolean' } })
    }
    // The key is never in an answer.
    expect(JSON.stringify(read)).not.contains('apiKey')
  })
})
