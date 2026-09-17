import { expect } from 'chai'
import { describe, it } from 'mocha'

import { parseRoute, type Route, routePath, safeNext } from './routes'

/** Every route survives being written down and read back. */
const roundTrip = (route: Route): Route => {
  const [pathname, search] = routePath(route).split('?')
  return parseRoute(pathname ?? '/', search ?? '')
}

describe('addresses', function () {
  it('reads the home screen from the root', function () {
    expect(parseRoute('/')).deep.equals({ name: 'home' })
    expect(parseRoute('')).deep.equals({ name: 'home' })
  })

  it('carries a game, its video and the moment in it', function () {
    expect(parseRoute('/games/gam_1', 'video=vid_2&t=734')).deep.equals({
      name: 'game',
      gameId: 'gam_1',
      tab: 'watch',
      videoId: 'vid_2',
      at: 734
    })
  })

  it('writes that address back exactly', function () {
    expect(
      routePath({
        name: 'game',
        gameId: 'gam_1',
        tab: 'watch',
        videoId: 'vid_2',
        at: 734
      })
    ).equals('/games/gam_1?video=vid_2&t=734')
  })

  it('round-trips every kind of screen', function () {
    const routes: Route[] = [
      { name: 'home' },
      { name: 'videos', when: 'past' },
      { name: 'videos', when: 'all' },
      { name: 'schedule', when: 'upcoming' },
      { name: 'account' },
      { name: 'season', seasonId: 'sea_1' },
      { name: 'league', leagueId: 'lea_1' }
    ]
    for (const route of routes) {
      expect(roundTrip(route), routePath(route)).deep.equals(route)
    }
  })

  it('falls back to the home screen rather than a blank page', function () {
    expect(parseRoute('/nonsense')).deep.equals({ name: 'home' })
    expect(parseRoute('/teams')).deep.equals({ name: 'home' })
  })

  it('ignores a filter it does not recognise', function () {
    expect(parseRoute('/videos', 'when=sideways')).deep.equals({
      name: 'videos',
      when: 'past'
    })
  })
})

describe('where sign-in sends you afterwards', function () {
  it('accepts a path on this site', function () {
    expect(safeNext('/games/gam_1')).equals('/games/gam_1')
  })

  it('refuses another site', function () {
    // `//evil.example` is a protocol-relative URL: without this, somebody who
    // has just typed their password is sent somewhere else entirely.
    expect(safeNext('//evil.example')).equals(undefined)
    expect(safeNext('https://evil.example')).equals(undefined)
    expect(safeNext('javascript:alert(1)')).equals(undefined)
    expect(safeNext('/\\evil.example')).equals(undefined)
  })

  it('refuses nothing at all', function () {
    expect(safeNext(null)).equals(undefined)
    expect(safeNext('')).equals(undefined)
  })
})
