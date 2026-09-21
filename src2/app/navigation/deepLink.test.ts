import { expect } from 'chai'

import { routeOfUrl } from './deepLink'

describe('routeOfUrl', function () {
  it('reads the address people actually paste', function () {
    expect(routeOfUrl('https://gamestation.co/games/g1?t=734')).deep.equals({
      name: 'game',
      gameId: 'g1',
      tab: 'watch',
      videoId: undefined,
      at: 734
    })
  })

  it('reads the app’s own scheme as the same place', function () {
    // No authority between the slashes, so `games` is a path segment and not a
    // host. React Native's own `URL` reads it as a host and loses the path,
    // which is why nothing here uses it.
    expect(routeOfUrl('gamestation://games/g1?t=734')).deep.equals(
      routeOfUrl('https://gamestation.co/games/g1?t=734')
    )
  })

  it('keeps the query on a scheme link', function () {
    expect(
      routeOfUrl('gamestation://players/u1?tab=stats&season=s1')
    ).deep.equals({
      name: 'player',
      userId: 'u1',
      tab: 'stats',
      seasonId: 's1',
      teamId: undefined,
      year: undefined
    })
  })

  it('takes a sign-in link out of the mail', function () {
    expect(
      routeOfUrl('https://gamestation.co/signin/tok123?r=req9')
    ).deep.equals({ name: 'signInLink', token: 'tok123', requestId: 'req9' })
  })

  it('takes an invite link in either form', function () {
    expect(routeOfUrl('https://gamestation.co/i/demo2026')).deep.equals({
      name: 'join',
      code: 'demo2026'
    })
    expect(routeOfUrl('gamestation://i/demo2026')).deep.equals({
      name: 'join',
      code: 'demo2026'
    })
  })

  it('reads a bare host as home', function () {
    expect(routeOfUrl('https://gamestation.co')).deep.equals({ name: 'home' })
    expect(routeOfUrl('https://gamestation.co/')).deep.equals({ name: 'home' })
  })

  it('drops a fragment, which addresses nothing here', function () {
    expect(
      routeOfUrl('https://gamestation.co/videos?when=all#top')
    ).deep.equals({ name: 'videos', when: 'all' })
  })

  it('takes a bare path', function () {
    expect(routeOfUrl('/teams/t1?tab=roster')).deep.equals({
      name: 'team',
      teamId: 't1',
      tab: 'roster'
    })
  })
})
