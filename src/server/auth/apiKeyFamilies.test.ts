import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { describe, it } from 'mocha'

import { apiRoutes, routesOf } from '../../test/routeTable'
import type { Database } from '../db/database'
import type { MediaContext } from '../media/mediaContext'
import { chatRoutes } from '../routes/chat'
import { chatAttachmentRoutes } from '../routes/chatAttachments'
import { chatEpochRoutes } from '../routes/chatEpochs'
import { chatKeyRoutes } from '../routes/chatKeys'
import { chatMessageRoutes } from '../routes/chatMessages'
import { followRoutes } from '../routes/follows'
import { guardianRoutes } from '../routes/guardians'
import { API_KEY_FAMILIES, KEYLESS, keyNeeds } from './apiKeyFamilies'

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
  }
}

/** Every route the server mounts under `/api/v1`, by shape. */
function mounted(): string[] {
  return [
    ...new Set([
      ...apiRoutes(),
      ...routesOf(followRoutes(db, media)),
      ...routesOf(
        guardianRoutes(db, {
          sendInvite: async () => undefined,
          publicUrl: 'http://127.0.0.1'
        })
      ),
      ...routesOf(chatRoutes(db, media)),
      ...routesOf(chatKeyRoutes(db)),
      ...routesOf(chatEpochRoutes(db)),
      ...routesOf(chatMessageRoutes(db, media)),
      ...routesOf(
        chatAttachmentRoutes(db, { space: media.space, uploadsDir: '/tmp' })
      ),
      'GET /openapi.json'
    ])
  ]
}

/** A route of the families as a mounted route would write it. */
function matchesMounted(entry: string, route: string): boolean {
  const [method, path] = entry.split(' ')
  const [mountedMethod, mountedPath] = route.split(' ')
  if (method !== mountedMethod) return false
  const want = path.split('/')
  const have = mountedPath.split('/')
  return (
    want.length === have.length &&
    want.every(
      (segment, i) =>
        segment === have[i] ||
        (/^\{[^}]+\}$/.test(have[i]) && !segment.startsWith('{')) ||
        (/^\{[^}]+\}$/.test(have[i]) && /^\{[^}]+\}$/.test(segment))
    )
  )
}

/** A concrete path for a route, with `x` for each parameter. */
const concrete = (path: string): string => path.replace(/\{[^}]+\}/g, 'x')

describe('what an API key may call', function () {
  const routes = mounted()

  it('names only routes the server mounts', function () {
    for (const [area, entries] of Object.entries(API_KEY_FAMILIES))
      for (const entry of entries)
        expect(
          routes.some(route => matchesMounted(entry, route)),
          `${area}: ${entry}`
        ).equals(true)
    for (const entry of KEYLESS) expect(routes, entry).includes(entry)
  })

  it('leaves out every area the issue keeps from a key', function () {
    const outside = [
      /^\w+ \/me\/account\/password/,
      /^DELETE \/me\/account$/,
      /^\w+ \/me\/account\/catalog-picture/,
      /^\w+ \/pictures/,
      /^\w+ \/me\/onboarding/,
      /^\w+ \/me\/follows/,
      /^\w+ \/teams\/\{teamId\}\/follow$/,
      /^\w+ \/me\/team-follows/,
      /^\w+ \/me\/notifications/,
      /^\w+ \/invites/,
      /^\w+ \/join\//,
      /^\w+ \/manage\//,
      /^\w+ \/(teams|seasons|leagues)\/\{id\}\/people/,
      /^\w+ \/venues/,
      /^\w+ \/locations?/,
      /^\w+ \/location-suggestions/,
      /^\w+ \/parent-(links|previews)/,
      /^\w+ \/relationship-requests/,
      /^\w+ \/games\/\{gameId\}\/live-streams/,
      /^\w+ \/live$/,
      /^\w+ \/videos\//,
      /^\w+ \/director\//,
      /^\w+ \/device-event-control/,
      /^\w+ \/node\//,
      /^\w+ \/users/,
      /walk-up-song/,
      /^\w+ \/games\/\{gameId\}\/narrations/,
      /^\w+ \/chat\//,
      /^\w+ \/admin\//,
      /^\w+ \/me\/tess/,
      /^\w+ \/oauth\//,
      /^\w+ \/auth\//,
      /^\w+ \/me\/api-keys/,
      /^\w+ \/me\/builds/
    ]
    const leaked = routes.filter(route => {
      if (!outside.some(rule => rule.test(route))) return false
      const [method, path] = route.split(' ')
      const needs = keyNeeds(method, concrete(path))
      return needs !== null
    })
    expect(leaked).deep.equals([])
  })

  it('asks read of a read and write of a change, in its own area', function () {
    expect(keyNeeds('GET', '/me/account')).equals('account:read')
    expect(keyNeeds('HEAD', '/me/account')).equals('account:read')
    expect(keyNeeds('PUT', '/me/account/name')).equals('account:write')
    expect(keyNeeds('GET', '/teams/tem_1/games')).equals('schedule:read')
    expect(keyNeeds('POST', '/teams/tem_1/games')).equals('schedule:write')
    // The scoring log and the calendar share a name, not a family.
    expect(keyNeeds('POST', '/games/gam_1/events')).equals('gameEvents:write')
    expect(keyNeeds('POST', '/events')).equals('schedule:write')
    expect(keyNeeds('GET', '/players/usr_1/name')).equals('gameEvents:read')
    expect(keyNeeds('GET', '/players/usr_1/highlights')).equals(null)
    expect(keyNeeds('PUT', '/groups/league/lea_1')).equals('league:write')
    expect(keyNeeds('PUT', '/groups/team/tem_1')).equals('team:write')
    expect(keyNeeds('PUT', '/groups/club/x')).equals(null)
    expect(keyNeeds('DELETE', '/leagues/lea_1/umpire-types/uty_1')).equals(
      'umpire:write'
    )
  })

  it('matches as Express does: any case, one trailing slash, one segment a parameter', function () {
    expect(keyNeeds('get', '/ME/Account/')).equals('account:read')
    expect(keyNeeds('GET', '/me/account//')).equals(null)
    expect(keyNeeds('GET', '/teams/a/b/games')).equals(null)
    expect(keyNeeds('GET', '/teams/search')).equals(null)
    expect(keyNeeds('GET', '/teams/tem_1')).equals('team:read')
    expect(keyNeeds('OPTIONS', '/me/account')).equals(null)
  })

  it('lets every key read health, the time and the API document', function () {
    expect(keyNeeds('GET', '/health')).equals('keyless')
    expect(keyNeeds('HEAD', '/time')).equals('keyless')
    expect(keyNeeds('GET', '/openapi.json')).equals('keyless')
    expect(keyNeeds('POST', '/health')).equals(null)
  })
})
