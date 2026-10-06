import { expect } from 'chai'
import { describe, it } from 'mocha'

import {
  parseDevRoute,
  parseRoute,
  type Route,
  routePath,
  safeNext
} from './routes'

/** Every route survives being written down and read back. */
const roundTrip = (route: Route): Route => {
  const [pathname, search] = routePath(route).split('?')
  return parseRoute(pathname ?? '/', search ?? '')
}

describe('addresses', function () {
  it('preserves bounded OAuth interaction and native approval paths', () => {
    const handle = 'a'.repeat(43)
    for (const route of [
      { name: 'oauthApprove', uid: 'request-1' },
      { name: 'oauthNative', handle }
    ] as const) {
      expect(parseRoute(routePath(route))).deep.equals(route)
    }
    for (const path of [
      '/oauth/unknown/id',
      '/oauth/approve',
      '/oauth/approve/a/b',
      '/oauth/native-approval/short',
      '/oauth/approve/%2f'
    ])
      expect(parseRoute(path)).deep.equals({ name: 'home' })
  })
  it('reads the home screen from the root', function () {
    expect(parseRoute('/')).deep.equals({ name: 'home' })
    expect(parseRoute('')).deep.equals({ name: 'home' })
  })

  it('reads and writes the Score Game section, and leaves the scorer alone', function () {
    expect(parseRoute('/games/g1/score-game')).deep.equals({
      name: 'game',
      gameId: 'g1',
      tab: 'score'
    })
    expect(routePath({ name: 'game', gameId: 'g1', tab: 'score' })).equals(
      '/games/g1/score-game'
    )
    expect(roundTrip({ name: 'game', gameId: 'g1', tab: 'score' })).deep.equals(
      {
        name: 'game',
        gameId: 'g1',
        tab: 'score'
      }
    )
    expect(parseRoute('/games/g1/score')).deep.equals({
      name: 'scoreGame',
      gameId: 'g1'
    })
    expect(routePath({ name: 'scoreGame', gameId: 'g1' })).equals(
      '/games/g1/score'
    )
  })

  it('reads and writes a game scoreboard override dashboard', function () {
    expect(parseRoute('/games/g1/scoreboard-override')).deep.equals({
      name: 'scoreboardOverride',
      gameId: 'g1'
    })
    expect(routePath({ name: 'scoreboardOverride', gameId: 'g1' })).equals(
      '/games/g1/scoreboard-override'
    )
    expect(roundTrip({ name: 'scoreboardOverride', gameId: 'g1' })).deep.equals(
      { name: 'scoreboardOverride', gameId: 'g1' }
    )
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

  it('reads and writes DJ Game at /games/<id>/dj (U28)', function () {
    expect(parseRoute('/games/g1/dj')).deep.equals({
      name: 'djGame',
      gameId: 'g1'
    })
    expect(routePath({ name: 'djGame', gameId: 'g1' })).equals('/games/g1/dj')
  })

  it('round-trips every kind of screen', function () {
    const routes: Route[] = [
      { name: 'scoreGame', gameId: 'g1' },
      { name: 'djGame', gameId: 'g1' },
      { name: 'home' },
      { name: 'videos', when: 'past' },
      { name: 'videos', when: 'all' },
      { name: 'schedule', when: 'past' },
      { name: 'schedule', when: 'upcoming' },
      { name: 'account' },
      { name: 'team', teamId: 'tea_1', tab: 'stats' },
      { name: 'followTeam' },
      { name: 'season', seasonId: 'sea_1', tab: 'standings', when: 'all' },
      { name: 'league', leagueId: 'lea_1' },
      { name: 'join', code: 'demo2026' }
    ]
    for (const route of routes) {
      expect(roundTrip(route), routePath(route)).deep.equals(route)
    }
  })

  it('reads and writes the follow screen at /teams/follow', function () {
    expect(parseRoute('/teams/follow')).deep.equals({ name: 'followTeam' })
    expect(routePath({ name: 'followTeam' })).equals('/teams/follow')
  })

  it('reads and writes Chat devices and linking at /chat/devices and /chat/link', function () {
    expect(parseRoute('/chat/devices')).deep.equals({ name: 'chatDevices' })
    expect(parseRoute('/chat/link')).deep.equals({ name: 'chatLink' })
    expect(routePath({ name: 'chatDevices' })).equals('/chat/devices')
    expect(routePath({ name: 'chatLink' })).equals('/chat/link')
    expect(roundTrip({ name: 'chatDevices' })).deep.equals({
      name: 'chatDevices'
    })
    expect(roundTrip({ name: 'chatLink' })).deep.equals({ name: 'chatLink' })
    expect(parseRoute('/chat/devices/more')).deep.equals({ name: 'home' })
  })

  it('reads and writes the chat list, a chat, its members and a new DM', function () {
    expect(parseRoute('/chat')).deep.equals({ name: 'chat' })
    expect(parseRoute('/chat/new')).deep.equals({ name: 'chatNew' })
    expect(parseRoute('/chat/cnv_abc')).deep.equals({
      name: 'conversation',
      conversationId: 'cnv_abc'
    })
    expect(parseRoute('/chat/cnv_abc/members')).deep.equals({
      name: 'chatMembers',
      conversationId: 'cnv_abc'
    })
    for (const route of [
      { name: 'chat' as const },
      { name: 'chatNew' as const },
      { name: 'conversation' as const, conversationId: 'cnv_abc' },
      { name: 'chatMembers' as const, conversationId: 'cnv_abc' }
    ]) {
      expect(roundTrip(route)).deep.equals(route)
    }
    expect(routePath({ name: 'chatMembers', conversationId: 'cnv_x' })).equals(
      '/chat/cnv_x/members'
    )
    // Nothing else under a chat, and no members of the fixed addresses.
    expect(parseRoute('/chat/cnv_abc/other')).deep.equals({ name: 'home' })
    expect(parseRoute('/chat/new/members')).deep.equals({ name: 'home' })
    expect(parseRoute('/chat/devices/members')).deep.equals({ name: 'home' })
    expect(parseRoute('/chat/cnv_abc/members/x')).deep.equals({ name: 'home' })
  })

  it('reads and writes the reported messages at /admin/chat/reports', function () {
    expect(parseRoute('/admin/chat/reports')).deep.equals({
      name: 'chatReports'
    })
    expect(routePath({ name: 'chatReports' })).equals('/admin/chat/reports')
    expect(roundTrip({ name: 'chatReports' })).deep.equals({
      name: 'chatReports'
    })
    for (const other of [
      '/admin',
      '/admin/chat',
      '/admin/chat/other',
      '/admin/other/reports',
      '/admin/chat/reports/x'
    ]) {
      expect(parseRoute(other), other).deep.equals({ name: 'home' })
    }
  })

  it('has no chat bench outside a phone build made for it', function () {
    // The web and the tests read `chatBench.ts`, which has no bench.
    expect(parseRoute('/dev/chat-bench')).deep.equals({ name: 'home' })
    expect(parseRoute('/dev')).deep.equals({ name: 'home' })
    expect(routePath({ name: 'chatBench' })).equals('/')
  })

  it('reads the bench’s address where the build has one', function () {
    const path = '/dev/chat-bench'
    expect(parseDevRoute(['dev', 'chat-bench'], path)).deep.equals({
      name: 'chatBench'
    })
    expect(parseDevRoute(['dev', 'chat-bench'], undefined)).deep.equals({
      name: 'home'
    })
    expect(parseDevRoute(['dev', 'chat-bench', 'x'], path)).deep.equals({
      name: 'home'
    })
    expect(parseDevRoute(['dev', 'other'], path)).deep.equals({
      name: 'home'
    })
  })

  it('reads an invite link at the address PeerTube used', function () {
    // These links are already out there — `app.teamstation.app/i/demo2026` is
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

  it('opens a schedule on what is coming', function () {
    expect(parseRoute('/schedule')).deep.equals({
      name: 'schedule',
      when: 'upcoming'
    })
    expect(routePath({ name: 'schedule', when: 'upcoming' })).equals(
      '/schedule'
    )
    expect(routePath({ name: 'schedule', when: 'past' })).equals(
      '/schedule?when=past'
    )
    expect(routePath({ name: 'schedule', when: 'all' })).equals(
      '/schedule?when=all'
    )
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
    expect(parseRoute('/schedule', 'when=sideways')).deep.equals({
      name: 'schedule',
      when: 'upcoming'
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

  it('carries the team it was opened for to Settings, and reads it back', function () {
    expect(parseRoute('/players/u1', 'tab=settings&onTeam=t1')).deep.equals({
      name: 'player',
      userId: 'u1',
      tab: 'settings',
      onTeam: 't1'
    })
    expect(
      routePath({ name: 'player', userId: 'u1', tab: 'settings', onTeam: 't1' })
    ).equals('/players/u1?tab=settings&onTeam=t1')
  })

  // `onTeam` is the team the page was opened for; `team` is what the Stats
  // filter narrows to. Two things, side by side, and neither moves the other.
  it('keeps the team it was opened for beside the Stats filter', function () {
    const route = {
      name: 'player' as const,
      userId: 'u1',
      tab: 'stats' as const,
      seasonId: undefined,
      teamId: 'tem_3',
      year: undefined,
      onTeam: 't1'
    }
    const path = routePath(route)
    expect(path).equals('/players/u1?tab=stats&team=tem_3&onTeam=t1')
    const [head, search] = path.split('?')
    expect(parseRoute(head, search)).deep.equals(route)
    // And on Videos, which has no filter, it is still written.
    expect(routePath({ name: 'player', userId: 'u1', onTeam: 't1' })).equals(
      '/players/u1?onTeam=t1'
    )
    expect(parseRoute('/players/u1', 'onTeam=t1')).deep.equals({
      name: 'player',
      userId: 'u1',
      onTeam: 't1'
    })
  })

  it('carries the team it was opened for to Walk-up, and reads it back', function () {
    expect(parseRoute('/players/u1', 'tab=walkup&onTeam=t1')).deep.equals({
      name: 'player',
      userId: 'u1',
      tab: 'walkup',
      onTeam: 't1'
    })
    expect(
      routePath({ name: 'player', userId: 'u1', tab: 'walkup', onTeam: 't1' })
    ).equals('/players/u1?tab=walkup&onTeam=t1')
  })

  it('opens Videos for Walk-up with no team whose song it would be', function () {
    expect(parseRoute('/players/u1', 'tab=walkup')).deep.equals({
      name: 'player',
      userId: 'u1'
    })
    expect(routePath({ name: 'player', userId: 'u1', tab: 'walkup' })).equals(
      '/players/u1'
    )
  })

  it('opens Videos for Settings with no team to edit the player on', function () {
    expect(parseRoute('/players/u1', 'tab=settings')).deep.equals({
      name: 'player',
      userId: 'u1'
    })
    expect(routePath({ name: 'player', userId: 'u1', tab: 'settings' })).equals(
      '/players/u1'
    )
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
