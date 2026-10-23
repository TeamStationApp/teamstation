import { expect } from 'chai'
import { describe, it } from 'mocha'

import { apiRoutes } from '../../test/routeTable'
import {
  ALLOWED_GAME_WRITES,
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
        '/dictation'
      ])
        expect(refused(method, path), `${method} ${path}`).equals(true)
    expect(refusalOf('DELETE', '/me/account')).includes('account')
    expect(refusalOf('PUT', '/me/account/password')).not.equals(null)
    // Near misses are not those routes.
    expect(refused('GET', '/me/roles')).equals(false)
    expect(refused('GET', '/authors')).equals(false)
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
})
