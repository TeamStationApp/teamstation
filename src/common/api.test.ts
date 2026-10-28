import { expect } from 'chai'
import { describe, it } from 'mocha'

import { mintedRosterEntry } from '../test/mintedRosterEntry'
import { testPasswordParameters } from '../test/passwordFixtures'
import {
  asHighlight,
  asPlayerHighlight,
  asSaveLineupsBody,
  asStandingsRow,
  type SaveLineupsBody,
  TeamStationClient
} from './api'
import { HttpError } from './errors'
import { asGumboPlay } from './gumboPlay'
import { halfOutcomes, lineScore } from './scoring/linescore'
import { userIdOfGumbo } from './userId'

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
  it('carries canonical identities in account, player and role mutations', async () => {
    const userId = userIdOfGumbo(42)
    const held = { userId, roles: ['coach'], member: true }
    const stub = stubFetch(200, held)
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: stub.fetch
    })
    await client.changeNodeAccount(userId, { isNodeAdmin: true })
    expect(
      await client.addRole('team', 'team/id', userId, 'coach')
    ).deep.equals(held)
    expect(
      await client.removeRole('team', 'team/id', userId, 'coach')
    ).deep.equals(held)
    expect(stub.calls.map(call => [call.method, call.url])).deep.equals([
      ['PATCH', `/api/v1/users/${userId}/administration`],
      ['PUT', `/api/v1/manage/team/team%2Fid/people/${userId}/roles/coach`],
      ['DELETE', `/api/v1/manage/team/team%2Fid/people/${userId}/roles/coach`]
    ])
    const role = stubFetch(200, { userId, role: 'member' })
    await new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: role.fetch
    }).setRole('team', 'team/id', userId, 'member')
    expect(role.calls[0].url).equals(
      `/api/v1/manage/team/team%2Fid/people/${userId}/role`
    )
    const settings = { userId, bats: 'right', throws: 'left' }
    const player = stubFetch(200, settings)
    expect(
      await new TeamStationClient({
        baseUrl: '/api/v1',
        fetch: player.fetch
      }).setPlayerBatsThrows(userId, { bats: 'right', throws: 'left' })
    ).deep.equals(settings)
    expect(player.calls[0].url).equals(`/api/v1/players/${userId}/settings`)
  })
  it('writes a game availability switch and reads the two exclusion lists', async () => {
    const set = stubFetch(200, { away: [123], home: [] })
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: set.fetch
    })
    const body = {
      side: 'away' as const,
      userId: userIdOfGumbo(123),
      rostered: false
    }
    expect(await client.setRostered('game/id', body)).deep.equals({
      away: [123],
      home: []
    })
    expect(set.calls[0].url).equals('/api/v1/games/game%2Fid/unroster')
    expect(set.calls[0].method).equals('PUT')
    expect(JSON.parse(set.calls[0].body!)).deep.equals(body)
  })
  it('posts a game guest to its side and returns the minted identity', async () => {
    const player = {
      firstName: 'Mike',
      lastName: 'Trout',
      jersey: '27',
      positions: ['CF' as const],
      bats: 'right' as const,
      throws: 'right' as const
    }
    const set = stubFetch(201, mintedRosterEntry(player, 700001))
    const client = new TeamStationClient({
      baseUrl: 'https://example.test/api/v1',
      fetch: set.fetch
    })
    const entry = await client.createGuestPlayer('game 1', 'away', player)
    expect(entry.userId).equals(userIdOfGumbo(700001))
    expect(set.calls[0].url).equals(
      'https://example.test/api/v1/games/game%201/guest-players'
    )
    expect(set.calls[0].method).equals('POST')
    expect(JSON.parse(set.calls[0].body!)).deep.equals({
      side: 'away',
      ...player
    })
  })

  it('keeps node access filters on the existing users collection and escapes name/email searches', async () => {
    const response = stubFetch(200, [
      {
        userId: userIdOfGumbo(101),
        displayName: 'Babe Ruth',
        email: 'babe@example.com',
        isNodeAdmin: true,
        suspended: false,
        loginEnabled: true,
        canRemoveNodeRole: false,
        avatarUrl: 'https://images.example.test/avatar.png'
      }
    ])
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: response.fetch
    })
    const accounts = await client.nodeAccounts('Aaron & email@example.com')
    expect(accounts[0].avatarUrl).equals(
      'https://images.example.test/avatar.png'
    )
    await client.nodeAccounts('', true)
    expect(response.calls.map(call => call.url)).deep.equals([
      '/api/v1/users?view=administration&query=Aaron%20%26%20email%40example.com',
      '/api/v1/users?view=administration&query=&nodeAdmin=true'
    ])
  })
  it('fetches a replay step\u2019s narration with the client\u2019s session, and says where it is', async function () {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = []
    let status = 200
    const client = new TeamStationClient({
      baseUrl: 'https://api.example.test/api/v1/',
      token: 'tok',
      fetch: async (url: unknown, init?: RequestInit) => {
        calls.push({ url: String(url), init })
        return status === 200
          ? new Response(new Blob(['ID3'], { type: 'audio/mpeg' }), {
              status
            })
          : new Response(
              JSON.stringify({ error: 'narrationUnavailable', message: 'No' }),
              { status }
            )
      }
    })
    // The sentence is asked for as the step stood with that many actions.
    const step = { key: '0-1', count: 2 }
    expect(client.narrationSource('gam 1', step)).deep.equals({
      uri: 'https://api.example.test/api/v1/games/gam%201/narrations/0-1?count=2',
      headers: { authorization: 'Bearer tok' }
    })
    const signal = new AbortController().signal
    const audio = await client.narrationAudio('gam 1', step, signal)
    expect(await audio.text()).equals('ID3')
    expect(calls[0].url).equals(
      'https://api.example.test/api/v1/games/gam%201/narrations/0-1?count=2'
    )
    expect(calls[0].init?.headers).deep.equals({
      authorization: 'Bearer tok',
      accept: 'audio/mpeg'
    })
    expect(calls[0].init?.credentials).equals('include')
    expect(calls[0].init?.signal).equals(signal)
    expect(calls[0].init?.method).equals('GET')
    // A phone's player fetches the audio itself: the check downloads none.
    await client.narrationReady('gam 1', step, signal)
    expect(calls[1].url).equals(calls[0].url)
    expect(calls[1].init?.method).equals('HEAD')
    expect(calls[1].init?.signal).equals(signal)
    status = 503
    const unavailable = await client
      .narrationAudio('gam 1', step)
      .catch((error: unknown) => error)
    expect(unavailable).instanceOf(HttpError)
    expect(
      await client
        .narrationReady('gam 1', step)
        .catch((error: unknown) => error)
    ).instanceOf(HttpError)
    // A browser's session is its cookie: no header to add.
    const cookie = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: async () => {
        throw new TypeError('Failed to fetch')
      }
    })
    expect(
      cookie.narrationSource('g', { key: '1-0', count: 1 }).headers
    ).deep.equals({})
    const offline = await cookie
      .narrationAudio('g', { key: '1-0', count: 1 })
      .catch((error: unknown) => error)
    expect((offline as HttpError).code).equals('offline')
  })

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

  it("narrows a player's highlights by the stats filter, and pages with it", async function () {
    const { fetch, calls } = stubFetch(200, {
      highlights: [],
      nextBefore: null,
      withoutVideo: 0
    })
    const client = new TeamStationClient({
      baseUrl: 'http://example.com/api/v1',
      fetch
    })
    await client.playerHighlights(userIdOfGumbo(7))
    await client.playerHighlights(userIdOfGumbo(7), {
      before: '2026-05-02T18:00:00.000Z',
      limit: 5,
      seasonId: 'season/one',
      teamId: 'team/one',
      year: 2026
    })
    expect(calls.map(call => call.url)).deep.equals([
      `http://example.com/api/v1/players/${userIdOfGumbo(7)}/highlights`,
      `http://example.com/api/v1/players/${userIdOfGumbo(7)}/highlights?before=2026-05-02T18%3A00%3A00.000Z&limit=5&seasonId=season%2Fone&teamId=team%2Fone&year=2026`
    ])
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
    const set = stubFetch(200, {
      userId: userIdOfGumbo(42),
      roles: ['admin', 'coach']
    })
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: set.fetch
    })
    const roles = await client.setRoles('season', 'sea 1', userIdOfGumbo(42), {
      admin: true,
      flags: ['coach']
    })
    expect(roles).deep.equals(['admin', 'coach'])
    expect(set.calls[0].method).equals('PUT')
    expect(set.calls[0].url).equals(
      `http://x/api/v1/manage/season/sea%201/people/${userIdOfGumbo(42)}/roles`
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
      userId: userIdOfGumbo(7),
      gumboId: 7,
      shortName: 'Jordan P',
      jersey: '12',
      positions: ['SS', '2B'],
      bats: 'left',
      throws: 'right',
      isPlayer: true,
      role: 'member',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null
    })
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: set.fetch
    })
    const entry = await client.setPlayerSettings('tem 1', userIdOfGumbo(7), {
      jersey: '12',
      bats: 'left'
    })
    expect(entry.jersey).equals('12')
    expect(entry.positions).deep.equals(['SS', '2B'])
    expect(set.calls[0].method).equals('PUT')
    expect(set.calls[0].url).equals(
      `http://x/api/v1/teams/tem%201/players/${userIdOfGumbo(7)}/settings`
    )
    expect(JSON.parse(set.calls[0].body ?? '')).deep.equals({
      jersey: '12',
      bats: 'left'
    })
  })

  it('creates a roster player and reads back the roster entry', async function () {
    const set = stubFetch(201, {
      userId: userIdOfGumbo(7),
      gumboId: 7,
      shortName: 'Cliff L',
      nameDetails: {
        firstName: 'Cliff',
        lastName: 'Lee',
        displayName: 'Cliff Lee'
      },
      jersey: '7',
      positions: ['SS'],
      bats: 'right',
      throws: 'right',
      isPlayer: true,
      role: 'member',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null,
      avatarUrl: null,
      walkUpSong: null
    })
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: set.fetch
    })
    const entry = await client.createRosterPlayer('tem 1', {
      firstName: 'Cliff',
      lastName: 'Lee',
      jersey: '7',
      positions: ['SS'],
      bats: 'right',
      throws: 'right'
    })
    expect(entry.userId).equals(userIdOfGumbo(7))
    expect(entry.shortName).equals('Cliff L')
    expect(entry.nameDetails?.displayName).equals('Cliff Lee')
    expect(set.calls[0].method).equals('POST')
    expect(set.calls[0].url).equals(
      'http://x/api/v1/teams/tem%201/roster-players'
    )
    expect(JSON.parse(set.calls[0].body ?? '')).deep.equals({
      firstName: 'Cliff',
      lastName: 'Lee',
      jersey: '7',
      positions: ['SS'],
      bats: 'right',
      throws: 'right'
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
    expect(
      await client.setWalkUpSong('tem 1', userIdOfGumbo(7), song)
    ).deep.equals(song)
    expect(set.calls[0].method).equals('PUT')
    expect(set.calls[0].url).equals(
      `http://x/api/v1/teams/tem%201/players/${userIdOfGumbo(7)}/walk-up-song`
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
    }).clearWalkUpSong('tem 1', userIdOfGumbo(7))
    expect(cleared).deep.equals([
      {
        url: `http://x/api/v1/teams/tem%201/players/${userIdOfGumbo(7)}/walk-up-song`,
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
      }).setWalkUpSong('tem_1', userIdOfGumbo(7), song)
    } catch {
      refused = true
    }
    expect(refused).equals(true)

    const entry = {
      userId: userIdOfGumbo(7),
      gumboId: 7,
      shortName: 'Jordan P',
      jersey: '12',
      positions: [],
      isPlayer: true,
      role: 'member',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null
    }
    const roster = stubFetch(200, [
      { ...entry, walkUpSong: song },
      { ...entry, userId: userIdOfGumbo(8), walkUpSong: null },
      // An older server sends no song at all.
      { ...entry, userId: userIdOfGumbo(9) }
    ])
    const read = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: roster.fetch
    }).roster('tem_1')
    expect(read.map(row => row.walkUpSong)).deep.equals([song, null, null])
  })

  it("reads a team's default lineup and a game's lineups", async function () {
    const person = { gumboId: 7, name: 'Jorge P', jersey: '12' }
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
          description: 'Pitching Change: Jorge P replaces Mel O.'
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
    // An older server sends no digest.
    expect(lineups.digest).equals('')

    const saved = stubFetch(200, {
      away: side('a'),
      home: side('h'),
      digest: 'd2'
    })
    const body: SaveLineupsBody = {
      side: 'home',
      base: 'd1',
      players: [
        { gumboId: 7, fullName: 'Jorge P', jersey: '12' },
        { gumboId: null, fullName: 'Guest', jersey: '' }
      ],
      battingOrder: [1, 0],
      defense: { P: 0, CF: 1 }
    }
    const answer = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: saved.fetch
    }).saveLineups('gam 1', body)
    expect(answer.digest).equals('d2')
    expect(saved.calls[0]).deep.include({
      url: 'http://x/api/v1/games/gam%201/lineups',
      method: 'POST'
    })
    expect(JSON.parse(saved.calls[0].body ?? '')).deep.equals(body)

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

  it('cleans a lineup save, refusing an index past its players', function () {
    const players = [
      { gumboId: 7, fullName: 'Judge', jersey: '99' },
      { gumboId: null, fullName: 'Soto', jersey: '22' }
    ]
    expect(
      asSaveLineupsBody({
        side: 'away',
        base: '',
        players,
        battingOrder: [0, 1],
        defense: { P: 1, SS: undefined, XX: 0 },
        nextBatter: 1,
        runners: [{ base: '2B', player: 0 }]
      })
    ).deep.equals({
      side: 'away',
      base: '',
      players,
      battingOrder: [0, 1],
      defense: { P: 1 },
      nextBatter: 1,
      runners: [{ base: '2B', player: 0 }]
    })
    const refused = (raw: Record<string, unknown>): string => {
      try {
        asSaveLineupsBody({
          side: 'home',
          base: '',
          players,
          battingOrder: [],
          defense: {},
          ...raw
        })
      } catch (error) {
        return (error as Error).message
      }
      return 'cleaned'
    }
    expect(refused({ battingOrder: [2] })).match(
      /Player 2 is not one of the 2 players/
    )
    expect(refused({ defense: { C: 5 } })).match(/Player 5/)
    expect(refused({ nextBatter: 2 })).match(/Player 2/)
    expect(refused({ runners: [{ base: '1B', player: 3 }] })).match(/Player 3/)
    expect(refused({ battingOrder: [-1] })).match(/an index into players/)
    expect(refused({ battingOrder: [0.5] })).match(/an index into players/)
    expect(refused({ runners: [{ base: 'home', player: 0 }] })).not.equals(
      'cleaned'
    )
    expect(refused({})).equals('cleaned')
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
        { userId: userIdOfGumbo(7), name: 'Tom A', walkUpSong: song },
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
      userId: userIdOfGumbo(42),
      ownerName: 'Pat Neshek',
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

  it('asks for a device’s stream, says it holds its recording, and dismisses the reminder', async function () {
    const device = {
      id: 'liv_1',
      gameId: 'gam 1',
      userId: userIdOfGumbo(42),
      ownerName: 'Pat Neshek',
      slot: 1,
      label: 'Home Plate',
      keyPrefix: 'ts_abc',
      state: 'idle',
      opensAt: '2026-05-02T18:00:00.000Z',
      closesAt: null,
      deviceModel: 'iPhone 13 Pro',
      deviceId: '00000000-0000-4000-8000-000000000001',
      localRecording: 'none'
    }
    const asked = stubFetch(201, device)
    const stream = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: asked.fetch
    }).addLiveStream('gam 1', 'Home Plate', {
      deviceId: '00000000-0000-4000-8000-000000000001',
      deviceModel: 'iPhone 13 Pro',
      recordsLocally: true
    })
    expect(stream.deviceModel).equals('iPhone 13 Pro')
    expect(stream.localRecording).equals('none')
    expect(JSON.parse(asked.calls[0].body ?? '')).deep.equals({
      label: 'Home Plate',
      deviceId: '00000000-0000-4000-8000-000000000001',
      deviceModel: 'iPhone 13 Pro',
      recordsLocally: true
    })

    // A browser's camera has no device fields at all, and a list item's
    // device model may be null.
    const plain = stubFetch(201, { ...device, deviceModel: null })
    const unnamed = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: plain.fetch
    }).addLiveStream('gam 1')
    expect(JSON.parse(plain.calls[0].body ?? '')).deep.equals({})
    expect(unnamed.deviceModel).equals(null)

    const recorded = stubFetch(200, { ...device, localRecording: 'recorded' })
    const marked = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: recorded.fetch
    }).updateLiveStream('gam 1', 'liv_1', { localRecording: 'recorded' })
    expect(marked.localRecording).equals('recorded')

    // 204 in production; a stub Response cannot carry a body with it.
    const dismissed = stubFetch(200, '')
    await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: dismissed.fetch
    }).dismissNotification('aud 1')
    expect(dismissed.calls[0].method).equals('PUT')
    expect(dismissed.calls[0].url).equals(
      'http://x/api/v1/me/notifications/aud%201/dismissed'
    )
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
  it('keeps authoritative authorization refusals recognizable even when a proxy returns a non-JSON body', async function () {
    for (const [status, code] of [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'notFound']
    ] as const) {
      const { fetch } = stubFetch(status, '<html>refused</html>')
      const client = new TeamStationClient({
        baseUrl: 'http://x/api/v1',
        fetch
      })
      expect(await client.teams().catch((error: unknown) => error)).property(
        'code',
        code
      )
    }
  })

  it('carries the token once signed in, and drops it on sign-out', async function () {
    const session = {
      token: 'tok_abc',
      expiresAt: '2026-10-01T00:00:00.000Z',
      user: {
        id: userIdOfGumbo(1),
        gumboId: null,
        displayName: 'Robin Yount',
        isAdmin: false
      }
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
      { userId: userIdOfGumbo(7), externalIds: ['a&b', 'c'] }
    ])
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    const users = await client.users({ externalIds: ['a&b', 'c'] })
    expect(calls[0].url).equals(
      'http://x/api/v1/users?externalId=a%26b&externalId=c'
    )
    // An answer without the name and picture still reads.
    expect(users).deep.equals([
      {
        userId: userIdOfGumbo(7),
        gumboId: null,
        externalIds: ['a&b', 'c'],
        shortName: undefined,
        avatarUrl: null
      }
    ])
  })

  it('asks for the players the signed-in person is a guardian of', async function () {
    const { fetch, calls } = stubFetch(200, [
      {
        userId: userIdOfGumbo(7),
        gumboId: null,
        externalIds: [],
        shortName: 'Alfonso S',
        avatarUrl: null
      }
    ])
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    expect(await client.guardedPlayers()).deep.equals([
      {
        userId: userIdOfGumbo(7),
        gumboId: null,
        externalIds: [],
        shortName: 'Alfonso S',
        avatarUrl: null
      }
    ])
    expect(calls[0].url).equals('http://x/api/v1/users?guardedBy=me')
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

  it('names the lineups base a live save was built on, and reads the digests back', async function () {
    const { fetch, calls } = stubFetch(200, {
      plays: [],
      currentPlay: null,
      playsDigest: 'plays',
      priorPlaysDigest: 'found',
      lineupsDigest: 'after',
      swap: 'reset'
    })
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    const saved = await client.saveGameEvents('gam_1', {
      plays: [],
      remove: [],
      lineupsBase: 'before'
    })
    expect(JSON.parse(calls[0].body!)).to.have.property('lineupsBase', 'before')
    expect(saved).deep.include({
      playsDigest: 'plays',
      priorPlaysDigest: 'found',
      lineupsDigest: 'after'
    })
    expect(await client.gameEvents('gam_1')).deep.include({
      lineupsDigest: 'after',
      swap: 'reset'
    })
    // A store that keeps none, and an older server, send none.
    await client.saveGameEvents('gam_1', { plays: [], remove: [] })
    expect(JSON.parse(calls[2].body!)).not.to.have.property('lineupsBase')
    const old = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      // And a swap effect this app does not know is none.
      fetch: stubFetch(200, {
        plays: [],
        lineupsDigest: null,
        swap: 'sideways'
      }).fetch
    })
    expect(await old.gameEvents('g')).deep.equals({
      plays: [],
      currentPlay: null
    })
  })

  it('reads sacrifice bunts on a batting line, and none from an older server', async function () {
    const batting = {
      userId: userIdOfGumbo(7),
      gumboId: 7,
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
      nonMemberView: false,
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
    expect(await client.standings('sea 1')).deep.equals([asStandingsRow(row)])
    expect(calls[0].url).equals('http://x/api/v1/seasons/sea%201/standings')
  })

  it('retains reserved and replacement identities across game proposal responses', async function () {
    const response = {
      id: 'req_demo',
      status: 'pending',
      gameId: null,
      proposedGameId: 'gam_reserved',
      replacesGameId: 'gam_original'
    }
    const fake = stubFetch(200, response)
    const client = new TeamStationClient({
      baseUrl: 'http://example.com/api/v1',
      fetch: fake.fetch
    })
    const proposal = {
      sender: { kind: 'team' as const, id: 'tem_demo' },
      game: {
        homeTeamId: 'tem_demo',
        awayTeamId: 'tem_other',
        seasonId: null,
        startAt: '2027-04-01T19:00:00Z',
        venue: null,
        outsideTournament: null,
        status: 'scheduled' as const
      },
      idempotencyKey: 'demo-proposal-key'
    }
    expect(await client.proposeGame(proposal)).deep.equals(response)
    expect(await client.decideGameRequest('req_demo', 'accept')).deep.equals({
      ...response,
      notice: undefined
    })
    const legacy = stubFetch(200, {
      id: 'req_demo',
      status: 'accepted',
      gameId: 'gam_demo'
    })
    const oldClient = new TeamStationClient({
      baseUrl: 'http://example.com/api/v1',
      fetch: legacy.fetch
    })
    expect(await oldClient.proposeGame(proposal)).deep.include({
      proposedGameId: null,
      replacesGameId: null
    })
    expect(
      await oldClient.decideGameRequest('req_demo', 'decline')
    ).deep.include({ proposedGameId: null, replacesGameId: null })
  })

  it('asks the standings collection for explicit exhibition inclusion and cleans authorized season stats', async function () {
    const listed = stubFetch(200, [])
    const client = new TeamStationClient({
      baseUrl: 'http://example.com/api/v1',
      fetch: listed.fetch
    })
    await client.standings('season/one', { includeExhibitions: false })
    await client.standings('season/one', { includeExhibitions: true })
    expect(listed.calls.map(call => call.url)).deep.equals([
      'http://example.com/api/v1/seasons/season%2Fone/standings?includeExhibitions=false',
      'http://example.com/api/v1/seasons/season%2Fone/standings?includeExhibitions=true'
    ])
    const stats = stubFetch(200, {
      seasonId: 'season/one',
      batting: [],
      pitching: []
    })
    const statsClient = new TeamStationClient({
      baseUrl: 'http://example.com/api/v1',
      fetch: stats.fetch
    })
    expect(await statsClient.seasonStats('season/one')).deep.equals({
      seasonId: 'season/one',
      batting: [],
      pitching: []
    })
    expect(stats.calls[0].url).equals(
      'http://example.com/api/v1/seasons/season%2Fone/stats'
    )
  })

  it('signs in by code, by link, and by a sign-in approved elsewhere, and signs out', async function () {
    const session = {
      token: 'tok_code',
      expiresAt: '2026-10-01T00:00:00.000Z',
      user: {
        id: userIdOfGumbo(1),
        gumboId: null,
        displayName: 'Robin Yount',
        isAdmin: false
      }
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
      nonMemberView: false,
      videos: []
    }
    const flagged = stubFetch(200, {
      ...game,
      canScore: true,
      canDj: true,
      scoreboard: { open: true, mayOverride: false },
      assignedRoles: { away: ['coach'], home: ['songkeeper'] }
    })
    const detail = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: flagged.fetch
    }).game('g/1')
    expect(flagged.calls[0].url).equals('http://x/api/v1/games/g%2F1')
    expect(detail.canScore).equals(true)
    expect(detail.canDj).equals(true)
    expect(detail.assignedRoles).deep.equals({
      away: ['coach'],
      home: ['songkeeper']
    })
    expect(detail.scoreboard).deep.equals({ open: true, mayOverride: false })
    const older = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, game).fetch
    }).game('g/1')
    expect(older.canScore).equals(false)
    expect(older.canDj).equals(false)
    expect(older.assignedRoles).deep.equals({ away: [], home: [] })
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
    // An answer that is not a person is not "nobody": it throws.
    let unread: unknown
    await client.whoAmI().catch((error: unknown) => {
      unread = error
    })
    expect(unread).instanceOf(Error)
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

  it('asks for a sign-in with the platform and the app that should open the link', async function () {
    const wait = { requestId: 'emc_1', clientSecret: 'secret' }
    const { fetch, calls } = stubFetch(202, wait)
    const client = new TeamStationClient({
      baseUrl: 'https://example.test/api/v1',
      fetch
    })
    await client.requestEmailCode('alex.lee@example.com', {
      origin: 'ios',
      appOrigin: 'https://app1.example.test'
    })
    expect(JSON.parse(calls[0].body ?? '')).deep.equals({
      email: 'alex.lee@example.com',
      origin: 'ios',
      appOrigin: 'https://app1.example.test'
    })
    await client.requestEmailCode('alex.lee@example.com')
    expect(JSON.parse(calls[1].body ?? '')).deep.equals({
      email: 'alex.lee@example.com',
      origin: 'web'
    })
    await client.requestInviteCode('join1', {
      email: 'alex.lee@example.com',
      origin: 'android',
      appOrigin: 'https://app1.example.test'
    })
    expect(calls[2].url).equals(
      'https://example.test/api/v1/join/join1/email-code'
    )
    expect(JSON.parse(calls[2].body ?? '')).deep.equals({
      email: 'alex.lee@example.com',
      origin: 'android',
      appOrigin: 'https://app1.example.test'
    })
    await client.requestInviteCode('join1', { email: 'alex.lee@example.com' })
    expect(JSON.parse(calls[3].body ?? '')).deep.equals({
      email: 'alex.lee@example.com',
      origin: 'web'
    })
  })

  it('names the device spending a link, and only when there is one', async function () {
    const session = {
      token: 'tok_abc',
      expiresAt: '2026-10-01T00:00:00.000Z',
      user: {
        id: userIdOfGumbo(1),
        gumboId: null,
        displayName: 'Robin Yount',
        isAdmin: false
      }
    }
    const { fetch, calls } = stubFetch(200, session)
    const client = new TeamStationClient({
      baseUrl: 'https://example.test/api/v1',
      fetch
    })
    await client.signInWithLink('tok_link', 'Bench iPad')
    expect(JSON.parse(calls[0].body ?? '')).deep.equals({
      token: 'tok_link',
      deviceName: 'Bench iPad'
    })
    await client.signInWithLink('tok_link')
    expect(JSON.parse(calls[1].body ?? '')).deep.equals({ token: 'tok_link' })
  })

  it('names the sign-in it is waiting on when an installed app spends its link, once', async function () {
    const answers = [
      { requestId: 'emc_asked', clientSecret: 's', sent: true },
      {
        token: 'tok',
        expiresAt: '2026-11-01T00:00:00.000Z',
        user: {
          id: userIdOfGumbo(1),
          gumboId: null,
          displayName: 'Robin Yount',
          isAdmin: false
        }
      },
      { requestId: 'emc_asked', clientSecret: 's', sent: true },
      {
        token: 'tok',
        expiresAt: '2026-11-01T00:00:00.000Z',
        user: {
          id: userIdOfGumbo(1),
          gumboId: null,
          displayName: 'Robin Yount',
          isAdmin: false
        }
      },
      {
        token: 'tok',
        expiresAt: '2026-11-01T00:00:00.000Z',
        user: {
          id: userIdOfGumbo(1),
          gumboId: null,
          displayName: 'Robin Yount',
          isAdmin: false
        }
      }
    ]
    const bodies: unknown[] = []
    const client = new TeamStationClient({
      baseUrl: 'https://example.test/api/v1',
      fetch: async (_url, init) => {
        bodies.push(
          JSON.parse(typeof init?.body === 'string' ? init.body : '{}')
        )
        return new Response(JSON.stringify(answers.shift()), {
          status: 200,
          headers: { 'content-type': 'application/json' }
        })
      }
    })
    await client.requestEmailCode('robin@example.test')
    // A browser spending it names nothing; the request may be waiting in another tab.
    await client.signInWithLink('tok_link')
    expect(bodies[1]).deep.equals({ token: 'tok_link' })
    await client.requestEmailCode('robin@example.test')
    await client.signInWithLink('tok_link', 'Bench iPad')
    expect(bodies[3]).deep.equals({
      token: 'tok_link',
      deviceName: 'Bench iPad',
      requestId: 'emc_asked'
    })
    await client.signInWithLink('tok_link', 'Bench iPad')
    expect(bodies[4]).deep.equals({
      token: 'tok_link',
      deviceName: 'Bench iPad'
    })
  })

  it('names its server’s origin and asks it for its OpenID issuer', async function () {
    const { fetch, calls } = stubFetch(200, {
      issuer: 'https://web.example.test/oauth'
    })
    const client = new TeamStationClient({
      baseUrl: 'https://API.example.test/api/v1/',
      fetch
    })
    expect(client.serverOrigin()).equals('https://api.example.test')
    expect(await client.issuer()).equals('https://web.example.test/oauth')
    expect(calls[0].url).equals(
      'https://api.example.test/oauth/.well-known/openid-configuration'
    )
    // Answered without one: null. Not answered (a 5xx): undefined.
    for (const [status, body, expected] of [
      [404, {}, null],
      [200, { issuer: 7 }, null],
      [200, 'not json', null],
      [502, {}, undefined]
    ] as const) {
      const answer = stubFetch(status, body)
      expect(
        await new TeamStationClient({
          baseUrl: 'https://api.example.test/api/v1',
          fetch: answer.fetch
        }).issuer()
      ).equals(expected)
    }
    const offline = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: async () => {
        throw new TypeError('Load failed')
      }
    })
    expect(offline.serverOrigin()).equals(
      (globalThis as { location?: { origin?: string } }).location?.origin ?? ''
    )
    expect(await offline.issuer()).equals(undefined)
  })
  it('keeps the server’s answer when the body breaks off, and is offline only for a success cut short', async () => {
    const brokenBody = (status: number): TeamStationClient =>
      new TeamStationClient({
        baseUrl: '/api/v1',
        fetch: async () =>
          ({
            ok: status < 400,
            status,
            text: async () => {
              throw new TypeError('Load failed')
            }
          }) as unknown as Response
      })
    for (const [status, code] of [
      [401, 'unauthorized'],
      [403, 'forbidden'],
      [404, 'notFound'],
      [503, 'internal'],
      [200, 'offline']
    ] as const) {
      const thrown = await brokenBody(status)
        .scoreboardOverlay('g1')
        .then(
          () => null,
          (error: unknown) => error
        )
      expect(thrown, String(status)).instanceOf(HttpError)
      expect((thrown as HttpError).code, String(status)).equals(code)
    }
  })
  it('asks for team suggestions around a team, a season or both, and keeps search rows', async () => {
    const row = {
      id: 'tem_owls',
      kind: 'team',
      name: 'Demo Owls',
      imageUrl: null,
      locality: null,
      seasonNames: ['Demo Regular'],
      staffNames: ['Ichiro']
    }
    const stub = stubFetch(200, [row])
    const client = new TeamStationClient({
      baseUrl: 'https://example.test/api/v1',
      fetch: stub.fetch
    })
    const [found] = await client.relatedTeams({ teamId: 'tem a' })
    expect(found.seasonNames).deep.equals(['Demo Regular'])
    expect(found.staffNames).deep.equals(['Ichiro'])
    await client.relatedTeams({ seasonId: 'sea_b' })
    await client.relatedTeams({ teamId: 'tem_a', seasonId: 'sea_b' })
    await client.relatedTeams({})
    expect(stub.calls.map(call => call.url)).deep.equals([
      'https://example.test/api/v1/teams?view=public&relatedTeam=tem+a',
      'https://example.test/api/v1/teams?view=public&relatedSeason=sea_b',
      'https://example.test/api/v1/teams?view=public&relatedTeam=tem_a&relatedSeason=sea_b',
      'https://example.test/api/v1/teams?view=public'
    ])
    const [searched] = await client.discoverGroups('team', 'Owls')
    expect(searched.staffNames).deep.equals(['Ichiro'])
    const bare = stubFetch(200, [
      { ...row, seasonNames: undefined, staffNames: undefined }
    ])
    const [plain] = await new TeamStationClient({
      baseUrl: 'https://example.test/api/v1',
      fetch: bare.fetch
    }).discoverGroups('team')
    expect(plain.seasonNames).equals(undefined)
    expect(plain.staffNames).equals(undefined)
  })
})

describe('a highlight’s end', function () {
  const highlight = {
    eventId: 'evt_1',
    atBatIndex: 1,
    title: 'Single: Mookie B',
    startOffsetSec: 562,
    playOffsetSec: 592,
    eventType: 'single',
    isScoringPlay: false,
    stillUrl: 'https://example.test/still.jpg'
  }
  const player = {
    eventId: 'evt_1',
    gameId: 'game_1',
    videoId: 'video_1',
    teamId: null,
    teamName: null,
    outcome: 'Single',
    title: 'Single: Mookie B',
    playAt: '2026-05-01T18:09:52.000Z',
    startOffsetSec: 562,
    playOffsetSec: 592,
    stillUrl: 'https://example.test/still.jpg'
  }

  it('is read where the server sends it, and absent from an older server', function () {
    expect(
      asHighlight({ ...highlight, endOffsetSec: 597 }).endOffsetSec
    ).equals(597)
    expect(asHighlight(highlight).endOffsetSec).equals(undefined)
    expect(
      asPlayerHighlight({ ...player, endOffsetSec: 597 }).endOffsetSec
    ).equals(597)
    expect(asPlayerHighlight(player).endOffsetSec).equals(undefined)
  })
})

describe('a session the server refuses', function () {
  it('is told on a 401, and not for a sign-in attempt refused', async function () {
    const stub = stubFetch(401, { error: 'unauthorized', message: 'Sign in' })
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: stub.fetch
    })
    let refused = 0
    client.onSessionRefused = () => {
      refused++
    }
    expect(await client.whoAmI()).equals(null)
    expect(refused, 'whoAmI').equals(1)
    let failure: unknown
    try {
      await client.teams()
    } catch (error) {
      failure = error
    }
    expect(failure).property('code', 'unauthorized')
    expect(refused, 'an authenticated read').equals(2)
    try {
      await client.requestEmailCode('fan@example.test')
    } catch {
      // The code is refused; the session is not the question.
    }
    expect(stub.calls.at(-1)?.url).equals('/api/v1/auth/email-code')
    expect(refused, 'a sign-in attempt').equals(2)
  })
})

describe('who is signed in, with no signal', function () {
  it('throws when the question cannot leave the device, and is null only for nobody', async function () {
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: async () => {
        throw new TypeError('Load failed')
      }
    })
    let failure: unknown
    try {
      await client.whoAmI()
    } catch (error) {
      failure = error
    }
    expect(failure).property('code', 'offline')
    expect(client.offline).equals(true)
    const nobody = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: stubFetch(401, { error: 'unauthorized', message: 'Sign in' }).fetch
    })
    expect(await nobody.whoAmI()).equals(null)
    // A server restarting or busy has not said who it is.
    for (const [status, code] of [
      [502, 'internal'],
      [503, 'unavailable'],
      [429, 'rateLimited']
    ] as const) {
      const busy = new TeamStationClient({
        baseUrl: '/api/v1',
        fetch: stubFetch(status, { code, message: 'Busy' }).fetch
      })
      let thrown: unknown
      await busy.whoAmI().catch((error: unknown) => {
        thrown = error
      })
      expect(thrown, String(status)).property('code', code)
    }
  })
})
