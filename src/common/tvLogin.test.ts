import { parseRoute, routePath } from '../app/navigation/routes'
import { expect } from 'chai'
import {
  defaultTvAppOrigin,
  isTvServerOrigin,
  tvBrowserUrl,
  tvLinkOfUrl,
  tvTokenOfUrl
} from './tvLogin'

describe('TV link identity', () => {
  const origin = 'https://develop.teamstation.app'
  const token = 'a'.repeat(43)
  it('round trips the issuer through web sign-in return and browser-only destinations', () => {
    const route = {
      name: 'teamStationTv' as const,
      token,
      server: 'https://develop5.teamstation.app'
    }
    const [path, query] = routePath(route).split('?')
    expect(parseRoute(path, query)).deep.equals(route)
    expect(parseRoute('/account/tv', `token=${token}`)).deep.equals({
      name: 'teamStationTv',
      token
    })
    expect(parseRoute('/tv-login', `token=${token}&server=bad`)).deep.equals({
      name: 'teamStationTv'
    })
    expect(
      parseRoute('/tv-login', `token=${token}&token=${token}`)
    ).deep.equals({ name: 'teamStationTv' })
  })

  it('retains the issuer and rejects ambiguous or malformed credentials', () => {
    const link = `${origin}/tv-login?token=${token}&server=https%3A%2F%2Fdevelop5.teamstation.app`
    expect(tvLinkOfUrl(link, origin)).deep.equals({
      token,
      server: 'https://develop5.teamstation.app'
    })
    expect(tvTokenOfUrl(link, origin)).equals(token)
    expect(
      tvLinkOfUrl(`${origin}/tv-login?token=${token}`, origin)
    ).deep.equals({ token })
    for (const bad of [
      'bad',
      link.replace('https:', 'http:'),
      link.replace('/tv-login', '/other'),
      link + '&token=x',
      link + '&server=x',
      link.replace('https%3A%2F%2Fdevelop5.teamstation.app', 'bad'),
      link.replace(token, 'x')
    ])
      expect(tvLinkOfUrl(bad, origin)).equals(null)
    expect(tvLinkOfUrl(link, 'https://other.example.test')).equals(null)
  })
  it('distinguishes public browser destinations from app links', () => {
    expect(tvBrowserUrl('https://develop5.teamstation.app', token)).equals(
      `https://develop5.teamstation.app/account/tv?token=${token}`
    )
    expect(tvBrowserUrl('https://evil.example.test', token)).equals(undefined)
    for (const origin of [
      'https://example.test',
      'http://localhost:1234',
      'http://127.0.0.1:1234',
      'http://[::1]:1234'
    ])
      expect(isTvServerOrigin(origin)).equals(true)
    for (const origin of [
      'bad',
      'https://example.test/path',
      'http://example.test',
      'https://user@example.test'
    ])
      expect(isTvServerOrigin(origin)).equals(false)
  })
  it('selects a shared develop host for every development issuer', () => {
    for (const server of [
      'https://develop.teamstation.app',
      ...Array.from(
        { length: 8 },
        (_, i) => `https://develop${i + 1}.teamstation.app`
      )
    ])
      expect(defaultTvAppOrigin(server)).equals(origin)
    expect(defaultTvAppOrigin('https://web.teamstation.app')).equals(
      'https://app.teamstation.app'
    )
    expect(defaultTvAppOrigin(undefined)).equals('https://app.teamstation.app')
    expect(defaultTvAppOrigin(undefined, ['https://tv.example.test'])).equals(
      'https://tv.example.test'
    )
    expect(
      defaultTvAppOrigin(undefined, ['https://app.teamstation.app'])
    ).equals('https://app.teamstation.app')
  })
})
