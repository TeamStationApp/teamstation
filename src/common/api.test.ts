import { expect } from 'chai'
import { describe, it } from 'mocha'

import { testPasswordParameters } from '../test/passwordFixtures'
import { TeamStationClient } from './api'
import { HttpError } from './errors'
import { asGumboPlay } from './gumboPlay'
import { halfOutcomes, lineScore } from './scoring/linescore'

interface Call {
  url: string
  method: string
  headers: Record<string, string>
  body: string | undefined
}

/** A stand-in for `fetch` that records what it was asked and answers to order. */
function stubFetch(
  status: number,
  body: unknown,
  calls: Call[] = []
): { fetch: typeof fetch; calls: Call[] } {
  const fake = async (
    url: unknown,
    init?: { method?: string; headers?: unknown; body?: string }
  ): Promise<Response> => {
    calls.push({
      url: String(url),
      method: init?.method ?? 'GET',
      headers: (init?.headers ?? {}) as Record<string, string>,
      body: init?.body
    })
    const text = typeof body === 'string' ? body : JSON.stringify(body)
    // A real Response rather than a stand-in, so `ok` and `text()` behave as
    // they will in the app instead of as this test imagines they might.
    return new Response(text, { status })
  }
  return { fetch: fake as unknown as typeof fetch, calls }
}

describe('api client', function () {
  it('reads account tag choices and writes escaped event assignments and removals', async () => {
    const choices = stubFetch(200, {
      recent: ['great catch'],
      popular: [{ tag: 'great pitch', count: 2 }]
    })
    const client = new TeamStationClient({
      baseUrl: 'https://example.test/api/v1',
      fetch: choices.fetch
    })
    expect(await client.tagChoices()).deep.equals({
      recent: ['great catch'],
      popular: [{ tag: 'great pitch', count: 2 }]
    })
    expect(choices.calls[0].url).equals('https://example.test/api/v1/tags')
    await client.tagChoices({ includeUnused: true })
    expect(choices.calls[1].url).equals(
      'https://example.test/api/v1/tags?includeUnused=true'
    )
    const mutation = stubFetch(200, {
      targetId: 'target/id',
      tag: 'great catch',
      revision: '9007199254740993'
    })
    const writer = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: mutation.fetch
    })
    expect(
      (await writer.saveEventTag('game/id', 'target/id', 'great catch')).tag
    ).equals('great catch')
    expect(
      (await writer.saveEventTag('game/id', 'target/id', 'great catch'))
        .revision
    ).equals('9007199254740993')
    await writer.saveEventTag('game/id', 'target/id', null)
    expect(mutation.calls.map(call => call.method)).deep.equals([
      'PUT',
      'PUT',
      'DELETE'
    ])
    expect(mutation.calls[0].url).equals(
      '/api/v1/games/game%2Fid/tags/target%2Fid'
    )
    expect(JSON.parse(mutation.calls[0].body!)).deep.equals({
      tag: 'great catch'
    })
    expect(mutation.calls[2].body).equals(undefined)
  })

  it('requests team pitching with optional season filtering', async function () {
    const { fetch, calls } = stubFetch(200, [])
    const client = new TeamStationClient({
      baseUrl: 'http://example.com/api/v1',
      fetch
    })
    expect(await client.teamPitchingStats('team/one')).deep.equals([])
    expect(
      await client.teamPitchingStats('team/one', 'season/one')
    ).deep.equals([])
    expect(calls.map(call => call.url)).deep.equals([
      'http://example.com/api/v1/teams/team%2Fone/stats?kind=pitching',
      'http://example.com/api/v1/teams/team%2Fone/stats?kind=pitching&seasonId=season%2Fone'
    ])
  })

  it('sets somebody\u2019s roles on one level, and reads the caller\u2019s own', async function () {
    const set = stubFetch(200, { userId: 42, roles: ['admin', 'coach'] })
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: set.fetch
    })
    const roles = await client.setRoles('season', 'sea 1', 42, {
      admin: true,
      flags: ['coach']
    })
    expect(roles).deep.equals(['admin', 'coach'])
    expect(set.calls[0].method).equals('PUT')
    expect(set.calls[0].url).equals(
      'http://x/api/v1/manage/season/sea%201/people/42/roles'
    )
    expect(JSON.parse(set.calls[0].body ?? '')).deep.equals({
      admin: true,
      flags: ['coach']
    })

    const mine = stubFetch(200, {
      teams: { tem_1: ['scorekeeper'], tem_2: ['admin', 'coach'] }
    })
    const reader = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: mine.fetch
    })
    expect((await reader.myRoles()).teams.tem_1).deep.equals(['scorekeeper'])
    expect(mine.calls[0].url).equals('http://x/api/v1/me/roles')
    // A role this app does not know is refused rather than drawn.
    const odd = stubFetch(200, { teams: { tem_1: ['umpire'] } })
    let refused = false
    try {
      await new TeamStationClient({
        baseUrl: 'http://x/api/v1',
        fetch: odd.fetch
      }).myRoles()
    } catch {
      refused = true
    }
    expect(refused).equals(true)
  })

  it('sets a player\u2019s settings on a team, and reads back the roster entry', async function () {
    const set = stubFetch(200, {
      userId: 7,
      shortName: 'Jordan P',
      jersey: '12',
      positions: ['SS', '2B'],
      bats: 'left',
      throws: 'right',
      isPlayer: true,
      role: 'member'
    })
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: set.fetch
    })
    const entry = await client.setPlayerSettings('tem 1', 7, {
      jersey: '12',
      bats: 'left'
    })
    expect(entry.jersey).equals('12')
    expect(entry.positions).deep.equals(['SS', '2B'])
    expect(set.calls[0].method).equals('PUT')
    expect(set.calls[0].url).equals(
      'http://x/api/v1/teams/tem%201/players/7/settings'
    )
    expect(JSON.parse(set.calls[0].body ?? '')).deep.equals({
      jersey: '12',
      bats: 'left'
    })
  })

  it('sets and clears a walk-up song, and reads it on the roster', async function () {
    const song = {
      provider: 'appleMusic',
      providerId: '1440857781',
      isrc: 'USFI86900049',
      title: 'Centerfield',
      artist: 'John Fogerty',
      album: null,
      artworkUrl: null,
      durationMs: 230000,
      startMs: 10000,
      endMs: 25000
    } as const
    const set = stubFetch(200, song)
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: set.fetch
    })
    expect(await client.setWalkUpSong('tem 1', 7, song)).deep.equals(song)
    expect(set.calls[0].method).equals('PUT')
    expect(set.calls[0].url).equals(
      'http://x/api/v1/teams/tem%201/players/7/walk-up-song'
    )
    expect(JSON.parse(set.calls[0].body ?? '')).deep.equals(song)

    // 204 carries no body, which a stubbed Response may not be given.
    const cleared: Array<{ url: string; method?: string; body?: unknown }> = []
    await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: async (url: unknown, init?: RequestInit) => {
        cleared.push({
          url: String(url),
          method: init?.method,
          body: init?.body
        })
        return new Response(null, { status: 204 })
      }
    }).clearWalkUpSong('tem 1', '7')
    expect(cleared).deep.equals([
      {
        url: 'http://x/api/v1/teams/tem%201/players/7/walk-up-song',
        method: 'DELETE',
        body: undefined
      }
    ])

    // A song the app would not store is refused rather than drawn.
    let refused = false
    try {
      await new TeamStationClient({
        baseUrl: 'http://x/api/v1',
        fetch: stubFetch(200, { ...song, endMs: 5000 }).fetch
      }).setWalkUpSong('tem_1', 7, song)
    } catch {
      refused = true
    }
    expect(refused).equals(true)

    const entry = {
      userId: 7,
      shortName: 'Jordan P',
      jersey: '12',
      positions: [],
      isPlayer: true,
      role: 'member'
    }
    const roster = stubFetch(200, [
      { ...entry, walkUpSong: song },
      { ...entry, userId: 8, walkUpSong: null },
      // An older server sends no song at all.
      { ...entry, userId: 9 }
    ])
    const read = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: roster.fetch
    }).roster('tem_1')
    expect(read.map(row => row.walkUpSong)).deep.equals([song, null, null])
  })

  it("reads a team's default lineup and a game's lineups", async function () {
    const person = { userId: 7, name: 'Jordan P', jersey: '12' }
    const defense = {
      P: person,
      C: null,
      '1B': null,
      '2B': null,
      SS: null,
      '3B': null,
      LF: null,
      CF: null,
      RF: null
    }
    const kept = stubFetch(200, {
      lineup: { batters: [person], defense },
      fromGameId: 'gam 1',
      setAt: '2026-09-28T12:00:00.000Z'
    })
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: kept.fetch
    })
    const found = await client.defaultLineup('tem 1')
    expect(found.lineup?.defense.P).deep.equals(person)
    expect(found.fromGameId).equals('gam 1')
    expect(kept.calls[0].url).equals(
      'http://x/api/v1/teams/tem%201/default-lineup'
    )

    const side = (teamId: string): Record<string, unknown> => ({
      teamId,
      teamName: teamId.toUpperCase(),
      start: null,
      changes: [
        {
          atBatIndex: 3,
          inning: 1,
          half: 'bottom',
          side: 'home',
          eventType: 'pitching_substitution',
          player: person,
          position: 'P',
          battingOrder: null,
          replaced: null,
          description: 'Pitching Change: Jordan P replaces Ott O.'
        }
      ],
      current: { batters: [person], defense }
    })
    const read = stubFetch(200, { away: side('a'), home: side('h') })
    const lineups = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: read.fetch
    }).gameLineups('gam 1')
    expect(read.calls[0].url).equals('http://x/api/v1/games/gam%201/lineups')
    expect(lineups.away.teamName).equals('A')
    expect(lineups.home.changes[0].eventType).equals('pitching_substitution')
    expect(lineups.home.current?.batters).deep.equals([person])

    const bad = stubFetch(200, { away: side('a'), home: { teamId: 'h' } })
    let refused = false
    try {
      await new TeamStationClient({
        baseUrl: 'http://x/api/v1',
        fetch: bad.fetch
      }).gameLineups('g')
    } catch {
      refused = true
    }
    expect(refused).equals(true)
  })

  it("reads DJ Game's batters and songs, and refuses a bad source (U27)", async function () {
    const song = {
      provider: 'localFile',
      providerId: 'lf:0123456789abcdef',
      isrc: null,
      title: 'Walk',
      artist: 'Band',
      album: null,
      artworkUrl: null,
      durationMs: 180000,
      startMs: 10000,
      endMs: 25000
    }
    const side = (source: string): Record<string, unknown> => ({
      teamId: 'tem_1',
      teamName: 'Titan',
      source,
      canEditWalkUp: true,
      batters: [
        { userId: 7, name: 'Tom A', walkUpSong: song },
        { userId: null, name: 'Guest', walkUpSong: null }
      ]
    })
    const read = stubFetch(200, { away: side('lineup'), home: side('roster') })
    const dj = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: read.fetch
    }).djGame('gam 1')
    expect(read.calls[0].url).equals('http://x/api/v1/games/gam%201/dj')
    expect(dj.away.source).equals('lineup')
    expect(dj.home.source).equals('roster')
    expect(dj.away.batters[0].walkUpSong?.title).equals('Walk')
    expect(dj.away.batters[1].userId).equals(null)

    const bad = stubFetch(200, { away: side('lineup'), home: side('guess') })
    let refused = false
    try {
      await new TeamStationClient({
        baseUrl: 'http://x/api/v1',
        fetch: bad.fetch
      }).djGame('g')
    } catch {
      refused = true
    }
    expect(refused).equals(true)
  })

  it('renames a camera with nothing but its label', async function () {
    const renamed = stubFetch(200, {
      id: 'liv_1',
      gameId: 'gam 1',
      userId: 42,
      ownerName: 'Pat',
      slot: 1,
      label: 'Dugout',
      keyPrefix: 'ts_abc',
      state: 'idle',
      opensAt: '2026-05-02T18:00:00.000Z',
      closesAt: null
    })
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: renamed.fetch
    })
    const stream = await client.updateLiveStream('gam 1', 'liv_1', {
      label: 'Dugout'
    })
    expect(stream.label).equals('Dugout')
    expect(renamed.calls[0].method).equals('PATCH')
    expect(renamed.calls[0].url).equals(
      'http://x/api/v1/games/gam%201/live-streams/liv_1'
    )
    expect(JSON.parse(renamed.calls[0].body ?? '')).deep.equals({
      label: 'Dugout'
    })
  })

  it('cleans a team list', async function () {
    const { fetch } = stubFetch(200, [
      { id: 'tem_1', name: 'Badgers', shortName: null, logoPath: null }
    ])
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    const teams = await client.teams()
    expect(teams.length).equals(1)
    expect(teams[0].name).equals('Badgers')
    expect(teams[0].shortName).equals(null)
  })

  it('reads whether a listed team is full or external, full when not said', async function () {
    const { fetch } = stubFetch(200, [
      { id: 'tem_1', name: 'Ospreys', shortName: null, logoPath: null },
      {
        id: 'tem_2',
        name: 'Gulls - Livestream',
        shortName: null,
        logoPath: null,
        kind: 'external'
      },
      {
        id: 'tem_3',
        name: 'Herons',
        shortName: null,
        logoPath: null,
        kind: 'full'
      }
    ])
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    expect((await client.teams()).map(team => team.kind)).deep.equals([
      'full',
      'external',
      'full'
    ])

    const odd = stubFetch(200, [
      {
        id: 'tem_1',
        name: 'Ospreys',
        shortName: null,
        logoPath: null,
        kind: 'opponent'
      }
    ])
    const refusing = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: odd.fetch
    })
    let refused: unknown
    try {
      await refusing.teams()
    } catch (error: unknown) {
      refused = error
    }
    expect(refused).instanceOf(Error)
  })

  it('refuses a response of the wrong shape rather than passing it on', async function () {
    const { fetch } = stubFetch(200, [{ id: 'tem_1' }])
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    let threw = false
    try {
      await client.teams()
    } catch {
      threw = true
    }
    expect(threw).equals(true)
  })

  it('turns an error body back into the same error the server threw', async function () {
    const { fetch } = stubFetch(404, { code: 'notFound', message: 'Not found' })
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    try {
      await client.game('gam_missing')
      expect.fail('should have thrown')
    } catch (error) {
      expect(error).is.instanceOf(HttpError)
      expect((error as HttpError).code).equals('notFound')
      expect((error as HttpError).status).equals(404)
    }
  })

  it('does not choke on an error body that is not our shape', async function () {
    const { fetch } = stubFetch(502, '<html>gateway</html>')
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    try {
      await client.teams()
      expect.fail('should have thrown')
    } catch (error) {
      expect((error as HttpError).code).equals('internal')
    }
  })

  it('carries the token once signed in, and drops it on sign-out', async function () {
    const session = {
      token: 'tok_abc',
      expiresAt: '2026-10-01T00:00:00.000Z',
      user: { id: 1, displayName: 'Robin', isAdmin: false }
    }
    const { fetch, calls } = stubFetch(200, session)
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      passwordKdf: async () => 'ab'.repeat(32),
      fetch: async (input, init) =>
        (typeof input === 'string'
          ? input
          : input instanceof URL
            ? input.href
            : input.url
        ).endsWith('/parameters')
          ? new Response(JSON.stringify(testPasswordParameters))
          : await fetch(input, init)
    })
    await client.signInWithPassword('a@b.c', 'hunter2')
    expect(client.token).equals('tok_abc')

    await client.teams().catch(() => undefined)
    const last = calls[calls.length - 1]
    expect(last.headers.authorization).equals('Bearer tok_abc')
  })

  it('sends a JSON body only when there is one', async function () {
    const { fetch, calls } = stubFetch(200, [])
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    await client.teams()
    expect(calls[0].body).equals(undefined)
    expect(calls[0].headers['content-type']).equals(undefined)
  })

  it('escapes an id rather than pasting it into the path', async function () {
    const { fetch, calls } = stubFetch(200, [])
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    await client.teamGames('a/b?c')
    expect(calls[0].url).equals('http://x/api/v1/teams/a%2Fb%3Fc/games')
  })

  it('asks for people by each external id, escaped', async function () {
    const { fetch, calls } = stubFetch(200, [
      { userId: 7, externalIds: ['a&b', 'c'] }
    ])
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    const users = await client.users({ externalIds: ['a&b', 'c'] })
    expect(calls[0].url).equals(
      'http://x/api/v1/users?externalId=a%26b&externalId=c'
    )
    expect(users).deep.equals([{ userId: 7, externalIds: ['a&b', 'c'] }])
  })

  it('trims a trailing slash off the base so paths do not double up', async function () {
    const { fetch, calls } = stubFetch(200, [])
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1/', fetch })
    await client.teams()
    expect(calls[0].url).equals('http://x/api/v1/teams')
  })

  it("reads a game's plays and the at-bat in progress", async function () {
    const play = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
      result: { eventType: 'single', awayScore: 0, homeScore: 0 }
    }
    const current = {
      about: { atBatIndex: 1, inning: 1, halfInning: 'top', isComplete: false }
    }
    const { fetch, calls } = stubFetch(200, {
      plays: [{ id: 'evt_1', gameId: 'gam_1', gumbo: play }],
      currentPlay: current
    })
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    const stored = await client.gameEvents('gam 1')
    expect(calls[0].url).equals('http://x/api/v1/games/gam%201/events')
    expect(JSON.parse(JSON.stringify(stored.plays))).deep.equals([play])
    expect(stored.currentPlay).deep.equals(current)
    const none = stubFetch(200, { plays: [] })
    const bare = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: none.fetch
    })
    expect(await bare.gameEvents('g')).deep.equals({
      plays: [],
      currentPlay: null
    })
  })

  it('scores into a game live, naming TeamStation and only what changed', async function () {
    const { fetch, calls } = stubFetch(200, { plays: [], currentPlay: null })
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    await client.saveGameEvents('gam_1', { plays: [], remove: [3] })
    expect(calls[0].method).equals('POST')
    expect(JSON.parse(calls[0].body!)).deep.equals({
      mode: 'live',
      source: { system: 'teamstation' },
      plays: [],
      remove: [3]
    })
    await client.saveGameEvents('gam_1', {
      plays: [],
      remove: [],
      currentPlay: null
    })
    expect(JSON.parse(calls[1].body!)).to.have.property('currentPlay', null)
    // The fence the plays were sized by goes with them.
    await client.saveGameEvents('gam_1', {
      plays: [],
      remove: [],
      fenceDistanceFt: 225
    })
    expect(JSON.parse(calls[2].body!)).to.have.property('fenceDistanceFt', 225)
  })

  it('reads sacrifice bunts on a batting line, and none from an older server', async function () {
    const batting = {
      userId: '7',
      teamId: 'tem_1',
      pa: 3,
      ab: 1,
      h: 1,
      singles: 1,
      doubles: 0,
      triples: 0,
      hr: 0,
      bb: 0,
      k: 0,
      hbp: 0,
      rbi: 0,
      sf: 1,
      rates: { avg: 1 }
    }
    const { fetch, calls } = stubFetch(200, {
      batting: [{ ...batting, sh: 1 }],
      pitching: []
    })
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    const box = await client.boxScore('gam 1')
    expect(calls[0].url).equals('http://x/api/v1/games/gam%201/box-score')
    expect([box.batting[0].sf, box.batting[0].sh]).deep.equals([1, 1])

    const older = stubFetch(200, [batting])
    const team = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: older.fetch
    })
    expect((await team.teamStats('tem 1'))[0].sh).equals(0)
    await team.teamStats('tem_1', 'sea 1')
    expect(older.calls.map(call => call.url)).deep.equals([
      'http://x/api/v1/teams/tem%201/stats',
      'http://x/api/v1/teams/tem_1/stats?seasonId=sea%201'
    ])
  })

  it("reads a game whose stored line score carries Gumbo's innings", async function () {
    const plays = [
      asGumboPlay({
        about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
        result: { eventType: 'home_run', awayScore: 1, homeScore: 0 }
      })
    ]
    const linescore = lineScore(plays, halfOutcomes(plays), 1, 0)
    expect(linescore.innings).to.have.length(1)
    const { fetch } = stubFetch(200, {
      id: 'gam_1',
      homeTeamId: 'tem_h',
      awayTeamId: 'tem_a',
      homeTeamName: 'Hosts',
      awayTeamName: 'Visitors',
      seasonId: null,
      startAt: null,
      venue: null,
      status: 'final',
      homeScore: 0,
      awayScore: 1,
      ingestStatus: 'ok',
      ingestMessage: null,
      linescore: JSON.parse(JSON.stringify(linescore)),
      videos: []
    })
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    const game = await client.game('gam_1')
    // The totals the scoreboard draws, and nothing it does not read.
    expect(game.linescore).deep.equals({
      away: { runs: [1], r: 1, h: 1, e: 0, bb: 0, k: 0, hr: 1, hbp: 0 },
      home: { runs: [0], r: 0, h: 0, e: 0, bb: 0, k: 0, hr: 0, hbp: 0 }
    })
  })

  it("asks for a season's standings by its escaped id", async function () {
    const row = {
      teamId: 'tem_1',
      teamName: 'Hosts',
      w: 2,
      l: 1,
      t: 0,
      runsFor: 12,
      runsAgainst: 9,
      played: 3,
      winningPct: 0.667,
      runDifferential: 3
    }
    const { fetch, calls } = stubFetch(200, [row])
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    expect(await client.standings('sea 1')).deep.equals([row])
    expect(calls[0].url).equals('http://x/api/v1/seasons/sea%201/standings')
  })

  it('signs in by code, by link, and by a sign-in approved elsewhere, and signs out', async function () {
    const session = {
      token: 'tok_code',
      expiresAt: '2026-10-01T00:00:00.000Z',
      user: { id: 1, displayName: 'Robin', isAdmin: false }
    }
    const answers: Array<[number, unknown]> = [
      [202, { sent: true, requestId: 'req_1', clientSecret: 'secret' }],
      [202, { ready: false }],
      [200, { ...session, token: 'tok_claim' }],
      [200, { ...session, token: 'tok_link' }],
      [200, session],
      [200, { ok: true }]
    ]
    const calls: Call[] = []
    const fetch = async (
      url: unknown,
      init?: { method?: string; headers?: unknown; body?: string }
    ): Promise<Response> => {
      calls.push({
        url: String(url),
        method: init?.method ?? 'GET',
        headers: (init?.headers ?? {}) as Record<string, string>,
        body: init?.body
      })
      const [status, body] = answers[calls.length - 1]
      return new Response(JSON.stringify(body), { status })
    }
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: fetch as unknown as typeof globalThis.fetch
    })
    const wait = await client.requestEmailCode('a@b.c')
    expect(wait).deep.equals({ requestId: 'req_1', clientSecret: 'secret' })
    expect(JSON.parse(calls[0].body ?? '')).deep.equals({
      email: 'a@b.c',
      origin: 'web'
    })
    expect(await client.claimSignIn(wait)).equals(undefined)
    expect(client.token).equals(undefined)
    expect((await client.claimSignIn(wait))?.token).equals('tok_claim')
    expect(JSON.parse(calls[2].body ?? '')).deep.equals({
      requestId: 'req_1',
      clientSecret: 'secret'
    })
    await client.signInWithLink('link_token')
    expect(client.token).equals('tok_link')
    await client.signInWithCode('a@b.c', '123456')
    expect(client.token).equals('tok_code')
    expect(calls[4].url).equals('http://x/api/v1/auth/email-code/verify')
    await client.signOut()
    expect(client.token).equals(undefined)
    expect(
      calls.map(call => call.url.slice('http://x/api/v1'.length))
    ).deep.equals([
      '/auth/email-code',
      '/auth/request/claim',
      '/auth/request/claim',
      '/auth/link/verify',
      '/auth/email-code/verify',
      '/auth/logout'
    ])
  })

  it("reads a game's scoring and scoreboard flags, and their defaults from a server from before them", async function () {
    const game = {
      id: 'g/1',
      homeTeamId: 'h',
      awayTeamId: 'a',
      homeTeamName: 'Hawks',
      awayTeamName: 'Gulls',
      seasonId: null,
      startAt: '2026-09-28T18:00:00.000Z',
      venue: null,
      status: 'scheduled',
      homeScore: null,
      awayScore: null,
      ingestStatus: 'none',
      ingestMessage: null,
      videos: []
    }
    const flagged = stubFetch(200, {
      ...game,
      canScore: true,
      canDj: true,
      scoreboard: { open: true, mayOverride: false }
    })
    const detail = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: flagged.fetch
    }).game('g/1')
    expect(flagged.calls[0].url).equals('http://x/api/v1/games/g%2F1')
    expect(detail.canScore).equals(true)
    expect(detail.canDj).equals(true)
    expect(detail.scoreboard).deep.equals({ open: true, mayOverride: false })
    const older = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, game).fetch
    }).game('g/1')
    expect(older.canScore).equals(false)
    expect(older.canDj).equals(false)
    expect(older.scoreboard).equals(null)
  })

  it('keeps each side\u2019s logo on the newest game, and reads a missing one as none', async function () {
    const row = {
      id: 'gam_1',
      homeTeamId: 'tem_ag',
      awayTeamId: 'tem_br',
      homeTeamName: 'Amber Gardens',
      awayTeamName: 'Badgers (Ripken)',
      homeTeamExternal: false,
      awayTeamExternal: false,
      seasonId: null,
      startAt: '2026-10-04T19:30:00Z',
      venue: null,
      status: 'inProgress',
      homeScore: 0,
      awayScore: 0,
      ingestStatus: 'none',
      videoCount: 0
    }
    const withLogo = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, [
        {
          ...row,
          awayLogoUrl: 'https://space/badgers-96.png',
          homeLogoUrl: null
        }
      ]).fetch
    }).recentGame()
    expect(withLogo?.awayLogoUrl).equals('https://space/badgers-96.png')
    expect(withLogo?.homeLogoUrl).equals(null)
    const older = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, [row]).fetch
    }).recentGame()
    expect(older?.awayLogoUrl).equals(null)
    expect(older?.homeLogoUrl).equals(null)
  })

  it('asks for seasons, their games and teams, the newest game and who is signed in', async function () {
    const { fetch, calls } = stubFetch(200, [])
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    expect(await client.seasons()).deep.equals([])
    expect(await client.games()).deep.equals([])
    expect(await client.games({ externalIds: ['ext 1'] })).deep.equals([])
    expect(await client.seasonGames('s/1')).deep.equals([])
    expect(await client.seasonTeams('s/1')).deep.equals([])
    expect(await client.liveNow()).deep.equals([])
    expect(await client.whoAmI()).equals(null)
    expect(
      await new TeamStationClient({
        baseUrl: 'http://x/api/v1',
        fetch: stubFetch(200, []).fetch
      }).recentGame()
    ).equals(null)
    expect(
      calls.map(call => call.url.slice('http://x/api/v1'.length))
    ).deep.equals([
      '/seasons',
      '/events',
      '/events?externalId=ext%201',
      '/events?season=s%2F1',
      '/seasons/s%2F1/teams',
      '/live',
      '/auth/me'
    ])
  })
})
