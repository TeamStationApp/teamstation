import type { Router } from 'express'
import type { Kysely } from 'kysely'
import type Provider from 'oidc-provider'

import type { Database } from '../server/db/database'
import type { MediaContext } from '../server/media/mediaContext'
import { oauthInteractionRoutes } from '../server/oauth/routes'
import { analyticsRoutes } from '../server/observability/routes'
import { accountRoutes } from '../server/routes/account'
import { adminRoutes } from '../server/routes/admin'
import { apiKeyRoutes } from '../server/routes/apiKeys'
import { authRoutes } from '../server/routes/auth'
import { deviceEventControlRoutes } from '../server/routes/deviceEventControl'
import { directorRoutes } from '../server/routes/director'
import { directorUploadRoutes } from '../server/routes/directorUploads'
import { eventInfoRoutes } from '../server/routes/eventInfo'
import { eventListRoutes } from '../server/routes/eventList'
import { eventRoutes } from '../server/routes/events'
import { gameApprovalRoutes } from '../server/routes/gameApprovals'
import { graphqlRoutes } from '../server/routes/graphql'
import { groupRoutes } from '../server/routes/groups'
import { healthRoutes } from '../server/routes/health'
import { inviteRoutes } from '../server/routes/invites'
import { lineupRoutes } from '../server/routes/lineups'
import { liveRoutes } from '../server/routes/live'
import { locationRoutes } from '../server/routes/location'
import { manageRoutes } from '../server/routes/manage'
import { meRoutes } from '../server/routes/me'
import { mediaRoutes } from '../server/routes/media'
import { narrationRoutes } from '../server/routes/narrations'
import { nodeAdministrationRoutes } from '../server/routes/nodeAdministration'
import { notificationRoutes } from '../server/routes/notifications'
import { onboardingRoutes } from '../server/routes/onboarding'
import { peopleRoutes } from '../server/routes/people'
import { pictureRoutes } from '../server/routes/pictures'
import { playerRoutes } from '../server/routes/players'
import { scheduleRoutes } from '../server/routes/schedule'
import { schedulePreviewRoutes } from '../server/routes/schedulePreviews'
import { schedulingSetupRoutes } from '../server/routes/schedulingSetup'
import { scoreboardRoutes } from '../server/routes/scoreboard'
import { seasonRoutes } from '../server/routes/seasons'
import { statsRoutes } from '../server/routes/stats'
import { teamMemberRoutes } from '../server/routes/teamMembers'
import { teamRoutes } from '../server/routes/teams'
import { tessRoutes } from '../server/routes/tess'
import { timeRoutes } from '../server/routes/time'
import { umpireRoutes } from '../server/routes/umpires'
import { userRoutes } from '../server/routes/users'
import { venueRoutes } from '../server/routes/venues'
import { walkUpSongRoutes } from '../server/routes/walkUpSongs'
import type { ScoreboardStore } from '../server/scoreboard/scoreboardStore'

interface RouteLayer {
  route?: { path: string; methods: Record<string, boolean> }
}

/**
 * Every `METHOD /path` a router answers, in the OpenAPI document's spelling
 * (`{gameId}` where Express writes `:gameId`). Read from the router's own
 * layers, so nothing is called: a router built against a database that would
 * throw if touched lists its routes all the same.
 */
export function routesOf(router: Router): string[] {
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
 * Every route the server mounts under `/api/v1`, from each router `runWorker`
 * mounts there, built against nothing: what the server answers, by shape.
 */
export function apiRoutes(): string[] {
  const db = {} as unknown as Kysely<Database>
  const store = {} as unknown as ScoreboardStore
  const provider = {} as unknown as Provider
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
  const live = {
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
    mediaRoot: media.mediaRoot
  }
  const sendCode = async (): Promise<void> => undefined
  return [
    ...routesOf(oauthInteractionRoutes(db, provider, 'https://example.test'))
      .filter(route => route.includes(' /api/v1/'))
      .map(route => route.replace(' /api/v1/', ' /')),
    ...routesOf(healthRoutes(db, '0.0.0')),
    ...routesOf(timeRoutes()),
    ...routesOf(authRoutes(db, { sendCode })),
    ...routesOf(accountRoutes(db, { ...media, sendCode })),
    ...routesOf(apiKeyRoutes(db, { sessionSecret: 'secret' })),
    ...routesOf(graphqlRoutes({ db, origin: () => 'http://127.0.0.1' })),
    ...routesOf(seasonRoutes(db, media)),
    ...routesOf(eventInfoRoutes(db, media)),
    ...routesOf(eventListRoutes(db, media)),
    ...routesOf(teamRoutes(db, media)),
    ...routesOf(scheduleRoutes(db)),
    ...routesOf(teamMemberRoutes(db, media)),
    ...routesOf(eventRoutes(db)),
    ...routesOf(lineupRoutes(db)),
    ...routesOf(narrationRoutes(db, null)),
    ...routesOf(adminRoutes()),
    ...routesOf(analyticsRoutes(db)),
    ...routesOf(statsRoutes(db)),
    ...routesOf(mediaRoutes(db, media)),
    ...routesOf(liveRoutes(db, live)),
    ...routesOf(directorRoutes(db, live)),
    ...routesOf(
      directorUploadRoutes(db, {
        uploadsDir: '/tmp',
        mediaRoot: '/tmp',
        ffmpegPath: '/usr/bin/ffmpeg'
      })
    ),
    ...routesOf(inviteRoutes(db, { sendCode })),
    ...routesOf(manageRoutes(db, { sendInvite: async () => undefined })),
    ...routesOf(peopleRoutes(db, media)),
    ...routesOf(meRoutes(db)),
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
    ...routesOf(playerRoutes(db, media)),
    ...routesOf(scoreboardRoutes(db, store)),
    ...routesOf(tessRoutes(db, { settings: null, origin: () => '' }))
  ]
}
