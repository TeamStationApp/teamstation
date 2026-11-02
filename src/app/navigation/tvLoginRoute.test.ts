import { expect } from 'chai'
import { describe, it } from 'mocha'

import { routeOfUrl } from './deepLink'
import { parseRoute, routePath } from './routes'

describe('TeamStation TV routes', () => {
  const token = 'a'.repeat(43)
  it('round trips account and validated QR routes', () => {
    for (const route of [
      { name: 'teamStationTv' } as const,
      { name: 'teamStationTv', token } as const
    ]) {
      const [path, query] = routePath(route).split('?')
      expect(parseRoute(path, query)).deep.equals(route)
    }
    expect(parseRoute('/tv-login', 'token=invalid')).deep.equals({
      name: 'teamStationTv'
    })
  })
  it('never inspects a credential from a foreign host or a non-HTTPS camera link', () => {
    const origin = 'https://app.example.test'
    expect(
      routeOfUrl(`${origin}/tv-login?token=${token}`, { appOrigin: origin })
    ).deep.equals({ name: 'teamStationTv', token })
    for (const url of [
      `https://evil.example.test/tv-login?token=${token}`,
      `http://app.example.test/tv-login?token=${token}`,
      `teamstation://tv-login?token=${token}`
    ]) {
      expect(routeOfUrl(url, { appOrigin: origin })).deep.equals({
        name: 'teamStationTv'
      })
    }
    expect(
      routeOfUrl(`https://app.teamstation.app/tv-login?token=${token}`)
    ).deep.equals({ name: 'teamStationTv', token })
  })
})
