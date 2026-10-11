import { expect } from 'chai'

import { routeOfUrl } from './deepLink'

describe('routeOfUrl', function () {
  it('reads the address people actually paste', function () {
    expect(
      routeOfUrl('https://app.teamstation.app/games/g1?t=734')
    ).deep.equals({
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
    expect(routeOfUrl('teamstation://games/g1?t=734')).deep.equals(
      routeOfUrl('https://app.teamstation.app/games/g1?t=734')
    )
  })

  it('keeps the query on a scheme link', function () {
    expect(
      routeOfUrl('teamstation://players/u1?tab=stats&season=s1')
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
    expect(routeOfUrl('https://app.teamstation.app/signin/tok123')).deep.equals(
      { name: 'signInLink', token: 'tok123' }
    )
    // Links mailed before the request id was dropped still open.
    expect(
      routeOfUrl('https://app.teamstation.app/signin/tok123?r=req9')
    ).deep.equals({ name: 'signInLink', token: 'tok123' })
  })

  it('keeps the server an app link names, and takes it only from the app’s own host', function () {
    const link =
      'https://app1.example.test/signin/T?server=https%3A%2F%2Fseat.example.test'
    expect(
      routeOfUrl(link, { appOrigin: 'https://app1.example.test' })
    ).deep.equals({
      name: 'signInLink',
      token: 'T',
      server: 'https://seat.example.test'
    })
    expect(
      routeOfUrl('https://APP1.example.test/signin/T', {
        appOrigin: 'https://app1.example.test'
      })
    ).deep.equals({ name: 'signInLink', token: 'T' })
    // Another host's sign-in link is not this app's to spend.
    expect(
      routeOfUrl('https://other.example.test/signin/T', {
        appOrigin: 'https://app1.example.test'
      })
    ).deep.equals({ name: 'signIn' })
    // Other paths, and the app's own scheme, are read as they always were.
    expect(
      routeOfUrl('https://other.example.test/games/g1', {
        appOrigin: 'https://app1.example.test'
      }).name
    ).equals('game')
    expect(
      routeOfUrl('teamstation://signin/T', {
        appOrigin: 'https://app1.example.test'
      })
    ).deep.equals({ name: 'signInLink', token: 'T' })
  })

  it('takes an invite link in either form', function () {
    expect(routeOfUrl('https://app.teamstation.app/i/demo2026')).deep.equals({
      name: 'join',
      code: 'demo2026'
    })
    expect(routeOfUrl('teamstation://i/demo2026')).deep.equals({
      name: 'join',
      code: 'demo2026'
    })
  })

  it('reads a bare host as home', function () {
    expect(routeOfUrl('https://app.teamstation.app')).deep.equals({
      name: 'home'
    })
    expect(routeOfUrl('https://app.teamstation.app/')).deep.equals({
      name: 'home'
    })
  })

  it('drops a fragment, which addresses nothing here', function () {
    expect(
      routeOfUrl('https://app.teamstation.app/videos?when=all#top')
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
