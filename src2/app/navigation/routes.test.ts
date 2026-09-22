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

  it('carries the angles showing at once, in the order they are laid out', function () {
    expect(
      parseRoute('/games/gam_1', 'angles=a,b,c,d&audio=b&zoom=c')
    ).deep.equals({
      name: 'game',
      gameId: 'gam_1',
      tab: 'watch',
      videoId: undefined,
      at: undefined,
      angles: ['a', 'b', 'c', 'd'],
      audio: 'b',
      zoom: 'c'
    })
  })

  it('writes an arrangement back as a link somebody can send', function () {
    expect(
      routePath({
        name: 'game',
        gameId: 'gam_1',
        angles: ['a', 'b', 'c', 'd'],
        audio: 'b',
        zoom: 'c'
      })
    ).equals('/games/gam_1?angles=a%2Cb%2Cc%2Cd&audio=b&zoom=c')
  })

  it('never draws more than four, whatever the address asks for', function () {
    const route = parseRoute('/games/gam_1', 'angles=a,b,c,d,e,f')
    expect(route.name === 'game' ? route.angles : []).deep.equals([
      'a',
      'b',
      'c',
      'd'
    ])
  })

  it('drops empty entries rather than opening a tile with no video', function () {
    const route = parseRoute('/games/gam_1', 'angles=a,,b,')
    expect(route.name === 'game' ? route.angles : []).deep.equals(['a', 'b'])
  })

  it('ignores a sound or a zoom with no angles to apply them to', function () {
    expect(parseRoute('/games/gam_1', 'audio=b&zoom=c')).deep.equals({
      name: 'game',
      gameId: 'gam_1',
      tab: 'watch',
      videoId: undefined,
      at: undefined
    })
  })

  it('round-trips every kind of screen', function () {
    const routes: Route[] = [
      { name: 'field' },
      { name: 'home' },
      { name: 'videos', when: 'past' },
      { name: 'videos', when: 'all' },
      { name: 'schedule', when: 'past' },
      { name: 'schedule', when: 'upcoming' },
      { name: 'account' },
      { name: 'team', teamId: 'tea_1', tab: 'stats' },
      { name: 'season', seasonId: 'sea_1', tab: 'standings', when: 'all' },
      { name: 'league', leagueId: 'lea_1' },
      { name: 'join', code: 'demo2026' }
    ]
    for (const route of routes) {
      expect(roundTrip(route), routePath(route)).deep.equals(route)
    }
  })

  it('reads an invite link at the address PeerTube used', function () {
    // These links are already out there — `tube.gamestation.co/i/demo2026` is
    // in mailboxes and on a team sheet — so the path is not ours to change.
    expect(parseRoute('/i/demo2026')).deep.equals({
      name: 'join',
      code: 'demo2026'
    })
    expect(routePath({ name: 'join', code: 'demo2026' })).equals('/i/demo2026')
    // PeerTube's longer form is read as well, because its own sign-in and
    // registration screens sent people through it.
    expect(parseRoute('/c/invite/demo2026')).deep.equals({
      name: 'join',
      code: 'demo2026'
    })
    expect(parseRoute('/video-channels/invite/demo2026')).deep.equals({
      name: 'join',
      code: 'demo2026'
    })
    // And a bare `/i` is not an invitation to anything.
    expect(parseRoute('/i')).deep.equals({ name: 'home' })
  })

  it('keeps the section a team or season link asked for', function () {
    expect(parseRoute('/teams/tea_1', '?tab=stats')).deep.equals({
      name: 'team',
      teamId: 'tea_1',
      tab: 'stats'
    })
    expect(parseRoute('/seasons/sea_1', '?tab=standings')).deep.equals({
      name: 'season',
      seasonId: 'sea_1',
      tab: 'standings',
      when: undefined
    })
    expect(
      parseRoute('/seasons/sea_1', '?tab=schedule&when=upcoming')
    ).deep.equals({
      name: 'season',
      seasonId: 'sea_1',
      tab: 'schedule',
      when: 'upcoming'
    })
    expect(
      routePath({ name: 'season', seasonId: 'sea_1', tab: 'teams' })
    ).equals('/seasons/sea_1?tab=teams')
  })

  it('carries the half of a game screen that is showing', function () {
    // The pill and the home card's button reach the same place, so they must
    // leave the same address behind: one of them wrote it and the other did
    // not, and a box score opened by pill could not be linked or reloaded.
    expect(
      routePath({ name: 'game', gameId: 'gam_1', tab: 'boxScore' })
    ).equals('/games/gam_1?tab=boxScore')
    expect(routePath({ name: 'game', gameId: 'gam_1', tab: 'watch' })).equals(
      '/games/gam_1'
    )
    expect(parseRoute('/games/gam_1', '?tab=boxScore')).deep.equals({
      name: 'game',
      gameId: 'gam_1',
      tab: 'boxScore',
      videoId: undefined,
      at: undefined
    })
  })

  it('falls back to the home screen rather than a blank page', function () {
    expect(parseRoute('/nonsense')).deep.equals({ name: 'home' })
    expect(parseRoute('/teams')).deep.equals({ name: 'home' })
  })

  it('opens a schedule on what has happened, like the videos list', function () {
    expect(parseRoute('/schedule')).deep.equals({
      name: 'schedule',
      when: 'past'
    })
  })

  it('keeps a filter that was asked for', function () {
    expect(parseRoute('/schedule', 'when=upcoming')).deep.equals({
      name: 'schedule',
      when: 'upcoming'
    })
    expect(parseRoute('/videos', 'when=all')).deep.equals({
      name: 'videos',
      when: 'all'
    })
  })

  it('ignores a filter it does not recognise', function () {
    expect(parseRoute('/videos', 'when=sideways')).deep.equals({
      name: 'videos',
      when: 'past'
    })
  })
})

describe('a player', function () {
  it('opens on Videos, with nothing else on the address', function () {
    expect(parseRoute('/players/1')).deep.equals({
      name: 'player',
      userId: '1'
    })
    expect(routePath({ name: 'player', userId: '1' })).equals('/players/1')
    expect(routePath({ name: 'player', userId: '1', tab: 'videos' })).equals(
      '/players/1'
    )
  })

  it('carries what the stats are narrowed to, and reads it back', function () {
    const route = {
      name: 'player' as const,
      userId: '1',
      tab: 'stats' as const,
      seasonId: 'sea_2',
      teamId: 'tem_3',
      year: 2026
    }
    const path = routePath(route)
    expect(path).equals(
      '/players/1?tab=stats&season=sea_2&team=tem_3&year=2026'
    )
    const [head, search] = path.split('?')
    expect(parseRoute(head, search)).deep.equals(route)
  })

  // The filter belongs to the Stats tab alone, so a narrowing on a Videos
  // address is a setting no screen honours. Dropped rather than carried.
  it('drops a filter from the tab that has none', function () {
    expect(parseRoute('/players/1', 'season=sea_2&team=tem_3')).deep.equals({
      name: 'player',
      userId: '1'
    })
  })

  it('ignores a year that is not one', function () {
    expect(parseRoute('/players/1', 'tab=stats&year=soon')).deep.equals({
      name: 'player',
      userId: '1',
      tab: 'stats',
      seasonId: undefined,
      teamId: undefined,
      year: undefined
    })
  })

  it('falls back to home without an id', function () {
    expect(parseRoute('/players')).deep.equals({ name: 'home' })
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
