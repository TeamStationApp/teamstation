import { readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { apiRoutes } from '../../test/routeTable'
import {
  ALLOWED_GAME_WRITES,
  ALLOWED_PERSON_ROUTES,
  type ApiMethod,
  apiPathOf,
  checkApiRequest,
  refusalOf
} from './denyList'

const refused = (method: ApiMethod, path: string): boolean =>
  typeof checkApiRequest(method, path) === 'string'

describe("Tess's deny list", function () {
  it('refuses every live-scoring and live-video write, and allows reading them', function () {
    for (const [method, path] of [
      ['POST', '/games/gam_1/events'],
      ['PATCH', '/games/gam_1/events'],
      ['POST', '/games/gam_1/lineups'],
      ['PUT', '/games/gam_1/unroster'],
      ['POST', '/games/gam_1/guest-players'],
      ['POST', '/games/gam_1/swap-sides'],
      ['POST', '/games/gam_1/live-streams'],
      ['PATCH', '/games/gam_1/live-streams/str_1'],
      ['POST', '/games/gam_1/live-streams/str_1/end'],
      ['DELETE', '/games/gam_1/live-streams/str_1'],
      ['POST', '/director/events/gam_1/claim'],
      ['PUT', '/director/uploads/upl_1/parts/0'],
      ['DELETE', '/director/uploads/upl_1'],
      // However Express would still match it.
      ['POST', '/Games/gam_1/Events/'],
      ['POST', '/api/v1/games/gam_1/events'],
      ['POST', '/games/gam_1/%65vents']
    ] as const)
      expect(refused(method, path), `${method} ${path}`).equals(true)
    expect(refused('GET', '/games/gam_1/events')).equals(false)
    expect(refused('GET', '/games/gam_1/lineups')).equals(false)
    expect(refused('GET', '/games/gam_1/live-streams')).equals(false)
    expect(refusalOf('POST', '/games/gam_1/events')).includes('scoring')
  })

  it('refuses the account, sign-in, OAuth, dictation and Tess routes for every method', function () {
    for (const method of ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] as const)
      for (const path of [
        '/me/account',
        '/me/account/password',
        '/me/account/emails/primary',
        '/me/account/name',
        '/auth/logout',
        '/auth',
        '/oauth/approvals/abc',
        '/me/tess',
        '/me/tess/changes/abc/confirm',
        '/dictation',
        '/me/onboarding',
        '/me/onboarding/name',
        '/me/builds',
        '/device-event-control/key'
      ])
        expect(refused(method, path), `${method} ${path}`).equals(true)
    expect(refusalOf('DELETE', '/me/account')).includes('account')
    expect(refusalOf('PUT', '/me/account/password')).not.equals(null)
    expect(refusalOf('GET', '/device-event-control/key')).includes('device key')
    // Near misses are not those routes.
    expect(refused('GET', '/me/roles')).equals(false)
    expect(refused('GET', '/authors')).equals(false)
    expect(refused('GET', '/me/buildsx')).equals(false)
  })

  it('refuses a path outside /api/v1, a URL, .. and other tricks', function () {
    for (const path of [
      'teams',
      '//example.test/api/v1/teams',
      'https://example.test/api/v1/teams',
      'javascript:alert(1)',
      '/teams/../me/account',
      '/teams/%2e%2e/me/account',
      '/teams/t1/..',
      '/teams\\t1',
      '/teams//t1',
      '/teams/t1%2fgames',
      '/teams/%E0%A4%A',
      '/teams/\u0000',
      '/redirect?to=https://example.test'
    ]) {
      const checked = apiPathOf(path)
      expect(typeof checked, path).equals(
        path.startsWith('/redirect') ? 'object' : 'string'
      )
    }
    expect(refusalOf('GET', '/teams/%E0%A4%A')).includes('encoded')
  })

  it('refuses a dot segment, which the URL would drop to reach a denied route', function () {
    // What the loopback's URL makes of each: a route the list denies.
    for (const [method, path, reached] of [
      ['DELETE', '/me/./account', '/api/v1/me/account'],
      ['DELETE', '/me/%2e/account', '/api/v1/me/account'],
      ['DELETE', '/me/%2E/account', '/api/v1/me/account'],
      ['POST', '/games/g1/./events', '/api/v1/games/g1/events'],
      ['POST', '/games/g1/%2E/events', '/api/v1/games/g1/events'],
      [
        'POST',
        '/./director/events/g1/claim',
        '/api/v1/director/events/g1/claim'
      ],
      ['POST', '/./auth/logout', '/api/v1/auth/logout'],
      ['GET', '/./oauth/approvals/abc', '/api/v1/oauth/approvals/abc'],
      ['GET', '/me/account/.', '/api/v1/me/account/'],
      ['GET', '/api/v1/./me/tess', '/api/v1/me/tess']
    ] as const) {
      expect(
        new URL(`/api/v1${path.replace(/^\/api\/v1/, '')}`, 'http://127.0.0.1')
          .pathname,
        path
      ).equals(reached)
      expect(refused(method, path), `${method} ${path}`).equals(true)
      expect(apiPathOf(path), path).equals('That path is not allowed')
    }
    // A dot inside a segment is only a name.
    expect(refused('GET', '/teams/t.1/games')).equals(false)
    expect(refused('GET', '/teams/.well')).equals(false)
  })

  it('allows ordinary reads and writes: schedule a game, edit a roster, change a setting', function () {
    expect(checkApiRequest('POST', '/teams/tem_1/games')).deep.equals({
      path: '/teams/tem_1/games',
      search: ''
    })
    expect(
      checkApiRequest('GET', '/api/v1/teams?season=sea_1#top')
    ).deep.equals({ path: '/teams', search: '?season=sea_1' })
    expect(checkApiRequest('GET', '/api/v1')).deep.equals({
      path: '/',
      search: ''
    })
    expect(refused('POST', '/teams/tem_1/players')).equals(false)
    expect(refused('PUT', '/teams/tem_1/players/usr_1/settings')).equals(false)
    expect(refused('PUT', '/leagues/lea_1/umpire-settings')).equals(false)
    expect(refused('PUT', '/games/gam_1/field')).equals(false)
  })

  it('denies or explicitly allows every mounted write route under a game', function () {
    const writes = [...new Set(apiRoutes())].filter(
      route => !route.startsWith('GET ') && / \/games\/\{[^}]+\}\//.test(route)
    )
    expect(writes.length).greaterThan(10)
    const unsorted = writes.filter(route => {
      const [method, path] = route.split(' ')
      const denied =
        refusalOf(method as ApiMethod, path.replace(/\{[^}]+\}/g, 'x')) != null
      return !denied && !ALLOWED_GAME_WRITES.includes(route)
    })
    expect(
      unsorted,
      `neither denied nor allowed in denyList.ts: ${unsorted.join(', ')}`
    ).deep.equals([])
    // And nothing listed as allowed is a route that has gone.
    for (const allowed of ALLOWED_GAME_WRITES)
      expect(writes, allowed).includes(allowed)
  })

  it('denies or explicitly allows every mounted route for the person alone', function () {
    const gated = personRoutes()
    // The routes this guards today, so a scan that finds nothing fails.
    for (const known of [
      'GET /device-event-control/key',
      'GET /me/builds',
      'GET /me/account',
      'DELETE /me/account',
      'PUT /me/account/catalog-picture',
      'GET /me/onboarding',
      'PUT /me/onboarding/name',
      'GET /locations'
    ])
      expect(gated, known).includes(known)
    const mounted = new Set(apiRoutes())
    const unsorted = gated.filter(route => {
      expect(mounted.has(route), `${route} is mounted`).equals(true)
      const [method, path] = route.split(' ')
      const denied =
        refusalOf(method as ApiMethod, path.replace(/\{[^}]+\}/g, 'x')) != null
      return !denied && !ALLOWED_PERSON_ROUTES.includes(route)
    })
    expect(
      unsorted,
      `neither denied nor allowed in denyList.ts: ${unsorted.join(', ')}`
    ).deep.equals([])
    for (const allowed of ALLOWED_PERSON_ROUTES)
      expect(gated, allowed).includes(allowed)
  })

  it('leaves no check for the person alone that a request of Tess’s would pass', function () {
    // A check written against `apiTokenId` alone lets Tess through as the
    // person; `isMachine` refuses both. These are the checks that are
    // meant to let her through.
    const meant: Record<string, string> = {
      // `isMachine` itself.
      'auth/sessions.ts': 'isMachine',
      // Managing organizations: Tess's confirmed changes need it.
      'groups/rights.ts': 'currentActor',
      'groups/publicSummary.ts': 'canManage, as currentActor',
      'schedule/pendingProjection.ts': 'pending games, as currentActor',
      // `/auth/me`, which the deny list keeps from her.
      'routes/auth.ts': 'viaApiToken'
    }
    const found = serverSources()
      .filter(({ text }) => /apiTokenId\s*[!=]=/.test(text))
      .map(({ file }) => file)
    expect(found.sort()).deep.equals(Object.keys(meant).sort())
  })
})

/** Every non-test TypeScript file of the server, by its path below it. */
function serverSources(): Array<{ file: string; text: string }> {
  const root = join(__dirname, '..')
  const out: Array<{ file: string; text: string }> = []
  const walk = (dir: string): void => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const file = dir === '' ? entry.name : `${dir}/${entry.name}`
      if (entry.isDirectory()) walk(file)
      else if (
        file.endsWith('.ts') &&
        !/\.(test|spec|e2e|integration)\.ts$/.test(file)
      )
        out.push({ file, text: readFileSync(join(root, file), 'utf8') })
    }
  }
  walk('')
  return out
}

/**
 * The API routes whose handler asks whether the caller is the person
 * themselves (`activeHuman`, `isMachine`), directly or through a helper of
 * the same file, read from the routers' source: `METHOD /path` as
 * `apiRoutes` writes them.
 */
function personRoutes(): string[] {
  const gate = /\b(activeHuman|isMachine)\(/
  const out: string[] = []
  for (const { file, text } of serverSources()) {
    if (!/^(routes|oauth)\/[^/]+\.ts$/.test(file)) continue
    // The file's own helpers that ask, besides its router.
    const helpers = text
      .split(/\n(?=(?:export )?(?:async )?function |const )/)
      .filter(chunk => !chunk.includes('Router()') && gate.test(chunk))
      .flatMap(chunk => {
        const name = /^(?:export )?(?:async )?(?:function|const) (\w+)/.exec(
          chunk
        )?.[1]
        return name == null ? [] : [name]
      })
    const asks = new RegExp(
      `\\b(${['activeHuman', 'isMachine', ...helpers].join('|')})\\(`
    )
    const calls = [
      ...text.matchAll(/router\.(get|post|put|patch|delete|use)\(\s*'([^']+)'/g)
    ]
    calls.forEach((call, at) => {
      if (call[1] === 'use') return
      const block = text.slice(call.index, calls[at + 1]?.index ?? text.length)
      if (!asks.test(block)) return
      // The OAuth router also answers outside the API, where Tess is not.
      if (file.startsWith('oauth/') && !call[2].startsWith('/api/v1/')) return
      const path = call[2]
        .replace(/^\/api\/v1(?=\/)/, '')
        .replace(/:([A-Za-z0-9_]+)/g, '{$1}')
      out.push(`${call[1].toUpperCase()} ${path}`)
    })
  }
  return out
}
