import { expect } from 'chai'
import { describe, it } from 'mocha'

import { testPasswordParameters } from '../test/passwordFixtures'
import { asStandingsRow, asManagePage, asScopeGrant, TeamStationClient } from './api'
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
    await client.playerHighlights('7')
    await client.playerHighlights('7', {
      before: '2026-05-02T18:00:00.000Z',
      limit: 5,
      seasonId: 'season/one',
      teamId: 'team/one',
      year: 2026
    })
    expect(calls.map(call => call.url)).deep.equals([
      'http://example.com/api/v1/players/7/highlights',
      'http://example.com/api/v1/players/7/highlights?before=2026-05-02T18%3A00%3A00.000Z&limit=5&seasonId=season%2Fone&teamId=team%2Fone&year=2026'
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
      role: 'member',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null
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
      role: 'member',
      section: 'player',
      staffRoles: [],
      inheritedFrom: null
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

  it('finds, follows and unfollows teams, and reads what a fan may', async function () {
    const client = (
      body: unknown
    ): {
      client: TeamStationClient
      calls: Call[]
    } => {
      const stub = stubFetch(200, body)
      return {
        client: new TeamStationClient({
          baseUrl: 'http://x/api/v1',
          fetch: stub.fetch
        }),
        calls: stub.calls
      }
    }
    const hawks = {
      id: 'tem_1',
      name: 'Hawks',
      logoUrl: null,
      seasons: [{ id: 'sea_1', title: 'QPLL Spring 2027' }],
      following: false
    }

    const search = client([hawks])
    expect(await search.client.searchTeams('Haw ks')).deep.equals([hawks])
    expect(search.calls[0].url).equals(
      'http://x/api/v1/teams/search?q=Haw%20ks'
    )

    const follow = client({ following: true })
    expect(await follow.client.follow('tem 1')).equals(true)
    expect(follow.calls[0]).deep.include({
      method: 'PUT',
      url: 'http://x/api/v1/teams/tem%201/follow'
    })

    const unfollow = client({ following: false })
    expect(await unfollow.client.unfollow('tem_1')).equals(false)
    expect(unfollow.calls[0]).deep.include({
      method: 'DELETE',
      url: 'http://x/api/v1/teams/tem_1/follow'
    })

    const mine = client([{ ...hawks, following: true }])
    expect((await mine.client.myFollows())[0]?.following).equals(true)
    expect(mine.calls[0].url).equals('http://x/api/v1/me/follows')

    const entry = {
      gameId: 'gam_1',
      startsAt: '2027-04-03T17:00:00.000Z',
      homeTeam: { id: 'tem_1', name: 'Hawks' },
      awayTeam: { id: 'tem_2', name: 'Owls' },
      venue: null,
      homeScore: 6
    }
    const schedule = client([entry])
    // Anything more than the listing is dropped, a score included.
    expect(await schedule.client.teamSchedule('tem_1')).deep.equals([
      {
        gameId: 'gam_1',
        startsAt: '2027-04-03T17:00:00.000Z',
        homeTeam: { id: 'tem_1', name: 'Hawks' },
        awayTeam: { id: 'tem_2', name: 'Owls' },
        venue: null
      }
    ])
    expect(schedule.calls[0].url).equals('http://x/api/v1/teams/tem_1/schedule')

    const staff = client([
      { userId: 42, shortName: 'Hank C', avatarUrl: null, roles: ['coach'] }
    ])
    expect(await staff.client.teamStaff('tem_1')).deep.equals([
      { userId: 42, shortName: 'Hank C', avatarUrl: null, roles: ['coach'] }
    ])
    expect(staff.calls[0].url).equals('http://x/api/v1/teams/tem_1/staff')
  })

  it('links, lists and unlinks guardians, and sets birth months and SafeSport', async function () {
    const client = (
      body: unknown
    ): {
      client: TeamStationClient
      calls: Call[]
    } => {
      const stub = stubFetch(200, body)
      return {
        client: new TeamStationClient({
          baseUrl: 'http://x/api/v1',
          fetch: stub.fetch
        }),
        calls: stub.calls
      }
    }
    const g1 = { userId: 7, name: 'Gale G', email: 'g1@x', kind: 'guardian' }

    const list = client([g1])
    expect(await list.client.guardians('tem 1', 42)).deep.equals([g1])
    expect(list.calls[0].url).equals(
      'http://x/api/v1/teams/tem%201/players/42/guardians'
    )

    const byId = client({ guardians: [g1] })
    expect(
      await byId.client.addGuardian('tem_1', 42, { userId: 7 })
    ).deep.equals({ guardians: [g1], invited: undefined })
    expect(byId.calls[0].method).equals('POST')
    expect(JSON.parse(byId.calls[0].body ?? '')).deep.equals({
      userId: '7',
      kind: 'guardian'
    })

    const invited = {
      inviteId: 'inv_1',
      email: 'aunt@x',
      code: 'abc',
      invitedAt: '2027-04-01T00:00:00.000Z'
    }
    const byEmail = client({ guardians: [], invited })
    expect(
      (
        await byEmail.client.addGuardian(
          'tem_1',
          '42',
          { email: 'aunt@x' },
          'family'
        )
      ).invited
    ).deep.equals(invited)
    expect(JSON.parse(byEmail.calls[0].body ?? '')).deep.equals({
      email: 'aunt@x',
      kind: 'family'
    })

    const removed = client({ removed: true })
    expect(await removed.client.removeGuardian('tem_1', 42, 7)).equals(true)
    expect(removed.calls[0]).deep.include({
      method: 'DELETE',
      url: 'http://x/api/v1/teams/tem_1/players/42/guardians/7'
    })

    const born = client({ userId: 42, birthMonth: '2012-03' })
    expect(
      await born.client.setBirthMonth(42, { year: 2012, month: 3 })
    ).equals('2012-03')
    expect(born.calls[0]).deep.include({
      method: 'PUT',
      url: 'http://x/api/v1/players/42/birth-month'
    })
    expect(JSON.parse(born.calls[0].body ?? '')).deep.equals({
      year: 2012,
      month: 3
    })
    const cleared = client({ userId: 42, birthMonth: null })
    expect(await cleared.client.setBirthMonth(42, null)).equals(null)
    expect(JSON.parse(cleared.calls[0].body ?? '')).deep.equals({
      year: null,
      month: null
    })

    const lao = client({ leagueId: 'lea 1', safesportLao: true })
    expect(await lao.client.setSafesport('lea 1', true)).equals(true)
    expect(lao.calls[0]).deep.include({
      method: 'PUT',
      url: 'http://x/api/v1/manage/league/lea%201/safesport'
    })
    expect(JSON.parse(lao.calls[0].body ?? '')).deep.equals({ lao: true })
  })

  it('reads chats, members, the log, candidates and adults, and starts, adds to and leaves DMs', async function () {
    const client = (
      body: unknown
    ): {
      client: TeamStationClient
      calls: Call[]
    } => {
      const stub = stubFetch(200, body)
      return {
        client: new TeamStationClient({
          baseUrl: 'http://x/api/v1',
          fetch: stub.fetch
        }),
        calls: stub.calls
      }
    }
    const chat = {
      id: 'cnv_1',
      kind: 'teamMembers',
      title: 'Hawks Members',
      scope: { type: 'team', id: 'tem_1' },
      scopeName: 'Hawks',
      lastSeq: 3,
      lastMessageAt: '2027-04-01T17:00:00.000Z',
      unread: 1,
      canPost: true,
      canModerate: false,
      locked: true,
      noHolder: false,
      closed: false,
      memberCount: 11
    }
    const dm = {
      ...chat,
      id: 'cnv_2',
      kind: 'dm',
      title: null,
      scope: null,
      scopeName: null,
      memberCount: 1,
      people: [{ userId: 7, shortName: 'Eli C', left: true }]
    }
    const list = client([chat, dm])
    // A server that names nobody (an older one) reads as nobody to name.
    expect(await list.client.chatConversations()).deep.equals([
      {
        ...chat,
        people: [],
        lastPostAt: null,
        lastPostId: null,
        lastPostSeq: 0,
        preferences: {
          pinned: false,
          muted: false,
          manualUnread: false,
          manualUnreadRevision: 0
        }
      },
      {
        ...dm,
        lastPostAt: null,
        lastPostId: null,
        lastPostSeq: 0,
        preferences: {
          pinned: false,
          muted: false,
          manualUnread: false,
          manualUnreadRevision: 0
        }
      }
    ])
    expect(list.calls[0].url).equals('http://x/api/v1/chat/conversations')

    const member = {
      userId: 42,
      shortName: 'Hank C',
      avatarUrl: null,
      label: 'Coach',
      isModerator: true,
      isApprover: true,
      eligible: false,
      hasIdentity: false,
      identityKey: null,
      generation: null
    }
    const members = client([member])
    expect(await members.client.chatMembers('cnv 1')).deep.equals([member])
    expect(members.calls[0].url).equals(
      'http://x/api/v1/chat/conversations/cnv%201/members'
    )

    const reads = client([{ userId: 42, seq: 3 }])
    expect(await reads.client.chatReads('cnv_1')).deep.equals([
      { userId: 42, seq: 3 }
    ])
    expect(reads.calls[0].url).equals(
      'http://x/api/v1/chat/conversations/cnv_1/reads'
    )

    const row = {
      seq: 1,
      event: 'join',
      userId: 42,
      actorUserId: null,
      reason: 'audience',
      prevHash: 'AA',
      hash: 'BB',
      at: 1
    }
    const log = client([row])
    expect(await log.client.chatLog('cnv_1', 5)).deep.equals([row])
    expect(log.calls[0].url).equals(
      'http://x/api/v1/chat/conversations/cnv_1/log?after=5'
    )
    await client([]).client.chatLog('cnv_1')

    const person = { userId: 42, shortName: 'Hank C', avatarUrl: null }
    const candidates = client([person])
    expect(await candidates.client.dmCandidates('ha nk')).deep.equals([person])
    expect(candidates.calls[0].url).equals(
      'http://x/api/v1/chat/dm-candidates?q=ha%20nk'
    )
    await client([]).client.dmCandidates()

    const adult = { userId: 7, shortName: 'Gale G', label: 'Guardian' }
    const adults = client([adult])
    expect(await adults.client.includedAdults([1, 2], 'ga')).deep.equals([
      adult
    ])
    expect(adults.calls[0].url).equals(
      'http://x/api/v1/chat/included-adults?playerIds=1,2&q=ga'
    )
    await client([]).client.includedAdults([1])

    const made = client({ ...chat, kind: 'dm', title: null, scope: null })
    expect((await made.client.createDm([42])).kind).equals('dm')
    expect(made.calls[0]).deep.include({
      method: 'POST',
      url: 'http://x/api/v1/chat/dms'
    })
    expect(JSON.parse(made.calls[0].body ?? '')).deep.equals({
      userIds: [42]
    })

    const added = client({ added: [7] })
    expect(await added.client.addDmMembers('cnv_1', [7, 8])).deep.equals([7])
    expect(added.calls[0].url).equals('http://x/api/v1/chat/dms/cnv_1/members')

    const left = client({ left: true, closed: true })
    expect(await left.client.leaveDm('cnv_1')).deep.equals({ closed: true })
    expect(left.calls[0]).deep.include({
      method: 'DELETE',
      url: 'http://x/api/v1/chat/dms/cnv_1/members/me'
    })
  })

  it('registers, resumes and revokes chat devices, publishes keys, and links devices', async function () {
    const client = (
      body: unknown
    ): {
      client: TeamStationClient
      calls: Call[]
    } => {
      const stub = stubFetch(200, body)
      return {
        client: new TeamStationClient({
          baseUrl: 'http://x/api/v1',
          fetch: stub.fetch
        }),
        calls: stub.calls
      }
    }
    const device = {
      id: 'cdv_1',
      name: 'Phone',
      platform: 'ios',
      boxPublicKey: 'AA',
      signPublicKey: 'BB',
      createdAt: '2027-04-10T12:00:00.000Z',
      lastSeenAt: '2027-04-10T12:00:00.000Z',
      revokedAt: null,
      linked: false,
      current: true
    }
    const registration = {
      name: 'Phone',
      platform: 'ios' as const,
      boxPublicKey: 'AA',
      signPublicKey: 'BB'
    }
    const registered = client(device)
    expect(
      await registered.client.registerChatDevice(registration)
    ).deep.equals(device)
    expect(registered.calls[0]).deep.include({
      method: 'POST',
      url: 'http://x/api/v1/chat/devices'
    })
    expect(JSON.parse(registered.calls[0].body ?? '')).deep.equals(registration)

    const listed = client([device])
    expect(await listed.client.chatDevices()).deep.equals([device])
    expect(listed.calls[0].url).equals('http://x/api/v1/chat/devices')

    const revoked = client({ ...device, revokedAt: 'later', current: false })
    expect((await revoked.client.revokeChatDevice('cdv 1')).revokedAt).equals(
      'later'
    )
    expect(revoked.calls[0]).deep.include({
      method: 'DELETE',
      url: 'http://x/api/v1/chat/devices/cdv%201'
    })

    const challenge = { nonce: 'NN', sessionId: 'ses_1', expiresAt: 'soon' }
    const challenged = client(challenge)
    expect(await challenged.client.chatResumeChallenge('cdv_1')).deep.equals(
      challenge
    )
    expect(challenged.calls[0]).deep.include({
      method: 'POST',
      url: 'http://x/api/v1/chat/devices/cdv_1/resume-challenge'
    })
    const resumed = client(device)
    await resumed.client.resumeChatDevice('cdv_1', {
      nonce: 'NN',
      signature: 'SS'
    })
    expect(resumed.calls[0].url).equals(
      'http://x/api/v1/chat/devices/cdv_1/resume'
    )
    expect(JSON.parse(resumed.calls[0].body ?? '')).deep.equals({
      nonce: 'NN',
      signature: 'SS'
    })

    const identity = {
      identityId: 'cid_1',
      identityPublicKey: 'II',
      pukPublicKey: 'PP',
      pukSignature: 'SS',
      box: 'BX'
    }
    const enrolled = client({
      identityId: 'cid_1',
      generation: 1,
      grantRequests: 2
    })
    expect((await enrolled.client.enrolChat(identity)).grantRequests).equals(2)
    expect(enrolled.calls[0]).deep.include({
      method: 'PUT',
      url: 'http://x/api/v1/chat/identity'
    })
    expect(JSON.parse(enrolled.calls[0].body ?? '')).deep.equals(identity)
    const reset = client({
      identityId: 'cid_2',
      generation: 1,
      revokedDeviceIds: ['cdv_2']
    })
    expect(
      (await reset.client.resetChatIdentity(identity)).revokedDeviceIds
    ).deep.equals(['cdv_2'])
    expect(reset.calls[0].url).equals('http://x/api/v1/chat/identity/reset')

    const puk = {
      generation: 2,
      publicKey: 'PK',
      signature: 'SG',
      previousKeysBox: 'PB',
      boxes: [{ deviceId: 'cdv_1', box: 'BX' }]
    }
    const posted = client({ generation: 2, grantRequests: 0 })
    expect(await posted.client.postChatPuk(puk)).deep.equals({
      generation: 2,
      grantRequests: 0
    })
    expect(posted.calls[0].url).equals('http://x/api/v1/chat/puk')
    expect(JSON.parse(posted.calls[0].body ?? '')).deep.equals(puk)

    const mine = {
      deviceId: 'cdv_1',
      linked: true,
      identity: { id: 'cid_1', publicKey: 'II', createdAt: 'then' },
      generations: [
        {
          generation: 1,
          publicKey: 'PK',
          signature: 'SG',
          previousKeysBox: null,
          box: 'BX'
        }
      ],
      pukNeedsRotation: false
    }
    const keys = client(mine)
    expect(await keys.client.myChatKeys()).deep.equals(mine)
    expect(keys.calls[0].url).equals('http://x/api/v1/chat/me/keys')
    await client({
      ...mine,
      deviceId: null,
      identity: null,
      generations: []
    }).client.myChatKeys()

    const theirs = {
      userId: 42,
      identity: { id: 'cid_9', publicKey: 'II', createdAt: 'then' },
      puk: { generation: 3, publicKey: 'PK', signature: 'SG' }
    }
    const users = client(theirs)
    expect(await users.client.chatUserKeys(42)).deep.equals(theirs)
    expect(users.calls[0].url).equals('http://x/api/v1/chat/users/42/keys')
    await client({ userId: 42, identity: null, puk: null }).client.chatUserKeys(
      42
    )

    const old = {
      id: 'cid_9',
      userId: 42,
      publicKey: 'II',
      createdAt: 'then',
      replacedAt: 'later'
    }
    const identities = client(old)
    expect(await identities.client.chatIdentity('cid_9')).deep.equals(old)
    expect(identities.calls[0].url).equals(
      'http://x/api/v1/chat/identities/cid_9'
    )

    const link = {
      id: 'clk_1',
      newDeviceId: 'cdv_2',
      createdAt: 'now',
      expiresAt: 'soon',
      approved: false,
      expired: false,
      approvedByDeviceId: null,
      box: null
    }
    const asked = client(link)
    expect(await asked.client.requestChatLink()).deep.equals(link)
    expect(asked.calls[0]).deep.include({
      method: 'POST',
      url: 'http://x/api/v1/chat/links'
    })
    const pendingLink = {
      id: 'clk_1',
      newDevice: {
        id: 'cdv_2',
        name: 'Laptop',
        platform: 'web',
        boxPublicKey: 'AA'
      },
      createdAt: 'now',
      expiresAt: 'soon'
    }
    const pending = client([pendingLink])
    expect(await pending.client.chatLinks()).deep.equals([pendingLink])
    expect(pending.calls[0].url).equals('http://x/api/v1/chat/links')
    const polled = client(link)
    await polled.client.chatLink('clk_1')
    expect(polled.calls[0].url).equals('http://x/api/v1/chat/links/clk_1')
    const approval = { box: 'BX', pukBoxes: [{ generation: 1, box: 'B1' }] }
    const approved = client({
      ...link,
      approved: true,
      approvedByDeviceId: 'cdv_1',
      box: 'BX'
    })
    expect(
      (await approved.client.approveChatLink('clk_1', approval)).box
    ).equals('BX')
    expect(approved.calls[0]).deep.include({
      method: 'POST',
      url: 'http://x/api/v1/chat/links/clk_1/approve'
    })
    expect(JSON.parse(approved.calls[0].body ?? '')).deep.equals(approval)
  })

  it('reads epochs, makes one, and lists and fills grant requests', async function () {
    const client = (
      body: unknown
    ): {
      client: TeamStationClient
      calls: Call[]
    } => {
      const stub = stubFetch(200, body)
      return {
        client: new TeamStationClient({
          baseUrl: 'http://x/api/v1',
          fetch: stub.fetch
        }),
        calls: stub.calls
      }
    }
    const epochs = {
      latest: 2,
      needsRotation: false,
      noHolder: false,
      epochs: [
        {
          epoch: 2,
          createdByUserId: 7,
          identityId: 'cid_1',
          previousKeyBox: 'PK',
          chainBreak: false,
          signature: 'SG',
          createdAt: 'now'
        }
      ],
      boxes: [
        {
          epoch: 2,
          identityId: 'cid_2',
          pukGeneration: 1,
          box: 'BX',
          grantedByUserId: null
        }
      ]
    }
    const read = client(epochs)
    expect(await read.client.chatEpochs('cnv 1', 1)).deep.equals(epochs)
    expect(read.calls[0].url).equals(
      'http://x/api/v1/chat/conversations/cnv%201/epochs?after=1'
    )
    await client(epochs).client.chatEpochs('cnv_1')

    const publication = {
      epoch: 3,
      previousKeyBox: 'PK',
      signature: 'SG',
      boxes: [{ userId: 7, pukGeneration: 1, box: 'BX' }]
    }
    const made = client({
      epoch: 3,
      chainBreak: false,
      boxed: 1,
      grantRequests: 0
    })
    expect(
      (await made.client.postChatEpoch('cnv_1', publication)).epoch
    ).equals(3)
    expect(made.calls[0]).deep.include({
      method: 'POST',
      url: 'http://x/api/v1/chat/conversations/cnv_1/epochs'
    })
    expect(JSON.parse(made.calls[0].body ?? '')).deep.equals(publication)

    const request = {
      id: 1,
      conversationId: 'cnv_1',
      epoch: 3,
      userId: 8,
      identityId: 'cid_3',
      identityKey: 'IK',
      pukGeneration: 1,
      pukPublicKey: 'PP',
      pukSignature: 'PS',
      identityReset: true,
      canApprove: false,
      openedAt: 'now'
    }
    const listed = client([request])
    expect(await listed.client.chatGrants()).deep.equals([request])
    expect(listed.calls[0].url).equals('http://x/api/v1/chat/grants')

    const boxes = [
      {
        conversationId: 'cnv_1',
        epoch: 3,
        userId: 8,
        identityId: 'cid_3',
        pukGeneration: 1,
        box: 'BX'
      }
    ]
    const answer = {
      filled: 0,
      skipped: [
        {
          conversationId: 'cnv_1',
          userId: 8,
          identityId: 'cid_3',
          pukGeneration: 1,
          reason: 'notOpen'
        }
      ]
    }
    const filled = client(answer)
    expect(await filled.client.postChatGrants(boxes)).deep.equals(answer)
    expect(filled.calls[0]).deep.include({
      method: 'POST',
      url: 'http://x/api/v1/chat/grants'
    })
    expect(JSON.parse(filled.calls[0].body ?? '')).deep.equals({ boxes })
  })
  it('posts and pages chat messages, moves read cursors, and reports', async function () {
    const client = (
      body: unknown
    ): {
      client: TeamStationClient
      calls: Call[]
    } => {
      const stub = stubFetch(200, body)
      return {
        client: new TeamStationClient({
          baseUrl: 'http://x/api/v1',
          fetch: stub.fetch
        }),
        calls: stub.calls
      }
    }
    const message = {
      id: 'msg_aaaaaaaaaaaaaaaaaaaaaaaaaa',
      conversationId: 'cnv_1',
      seq: 3,
      epoch: 1,
      senderUserId: 7,
      senderIdentityId: 'cid_1',
      kind: 'delete',
      targetIds: ['msg_bbbbbbbbbbbbbbbbbbbbbbbbbb'],
      nonce: 'NN',
      ciphertext: 'CT',
      signature: 'SG',
      attachmentIds: [],
      clearedAt: null,
      createdAt: '2027-04-10T12:00:00.000Z'
    }
    const envelope = {
      id: message.id,
      epoch: 1,
      kind: 'delete' as const,
      senderIdentityId: 'cid_1',
      targetIds: message.targetIds,
      nonce: 'NN',
      ciphertext: 'CT',
      signature: 'SG'
    }
    const posted = client(message)
    expect(await posted.client.postChatMessage('cnv 1', envelope)).deep.equals(
      message
    )
    expect(posted.calls[0]).deep.include({
      method: 'POST',
      url: 'http://x/api/v1/chat/conversations/cnv%201/messages'
    })
    expect(JSON.parse(posted.calls[0].body ?? '')).deep.equals(envelope)

    const paged = client([message])
    expect(await paged.client.chatMessages('cnv_1')).deep.equals([message])
    await paged.client.chatMessages('cnv_1', { after: 2, limit: 50 })
    await paged.client.chatMessages('cnv_1', { before: 9 })
    expect(paged.calls.map(call => call.url)).deep.equals([
      'http://x/api/v1/chat/conversations/cnv_1/messages',
      'http://x/api/v1/chat/conversations/cnv_1/messages?after=2&limit=50',
      'http://x/api/v1/chat/conversations/cnv_1/messages?before=9'
    ])

    const read = client({ seq: 3 })
    expect(await read.client.markChatRead('cnv_1', 2)).deep.equals({ seq: 3 })
    expect(read.calls[0]).deep.include({
      method: 'PUT',
      url: 'http://x/api/v1/chat/conversations/cnv_1/read'
    })
    expect(JSON.parse(read.calls[0].body ?? '')).deep.equals({ seq: 2 })

    const disclosure = {
      messageId: message.id,
      plaintext: '{"type":"text"}',
      messageKey: 'MK'
    }
    const reported = client({ id: 'crp_1', verified: true })
    expect(await reported.client.reportChatMessage(disclosure)).deep.equals({
      id: 'crp_1',
      verified: true
    })
    expect(reported.calls[0]).deep.include({
      method: 'POST',
      url: 'http://x/api/v1/chat/reports'
    })
    expect(JSON.parse(reported.calls[0].body ?? '')).deep.equals(disclosure)

    const report = {
      id: 'crp_1',
      conversation: {
        id: 'cnv_1',
        kind: 'teamMembers',
        title: 'Hawks Members'
      },
      messageId: message.id,
      reporter: { userId: 8, shortName: 'Blair B' },
      sender: { userId: 7, shortName: 'Casey C' },
      kind: 'post',
      sentAt: '2027-04-10T12:00:00.000Z',
      plaintext: '{"type":"text"}',
      verified: true,
      createdAt: '2027-04-10T12:01:00.000Z',
      resolvedAt: null
    }
    const listed = client([report])
    expect(await listed.client.chatReports()).deep.equals([report])
    await listed.client.chatReports(true)
    expect(listed.calls.map(call => call.url)).deep.equals([
      'http://x/api/v1/admin/chat/reports',
      'http://x/api/v1/admin/chat/reports?open=true'
    ])
    const resolved = client({ ...report, resolvedAt: 'later' })
    expect(
      (await resolved.client.resolveChatReport('crp 1')).resolvedAt
    ).equals('later')
    expect(resolved.calls[0]).deep.include({
      method: 'PUT',
      url: 'http://x/api/v1/admin/chat/reports/crp%201/resolve'
    })
  })

  it('uploads attachment parts as bytes and reads attachments', async function () {
    const client = (
      body: unknown
    ): {
      client: TeamStationClient
      calls: Call[]
    } => {
      const stub = stubFetch(200, body)
      return {
        client: new TeamStationClient({
          baseUrl: 'http://x/api/v1',
          fetch: stub.fetch
        }),
        calls: stub.calls
      }
    }
    const upload = {
      id: 'cat_1',
      conversationId: 'cnv_1',
      size: 9,
      completed: false,
      partSize: 8388608,
      parts: 1,
      missing: [0]
    }
    const opened = client(upload)
    const request = { conversationId: 'cnv_1', size: 9, digest: 'DG' }
    expect(await opened.client.createChatAttachment(request)).deep.equals(
      upload
    )
    expect(opened.calls[0]).deep.include({
      method: 'POST',
      url: 'http://x/api/v1/chat/attachments'
    })
    expect(JSON.parse(opened.calls[0].body ?? '')).deep.equals(request)

    const part = client({ received: 1, parts: 1, missing: [] })
    const bytes = new Uint8Array([1, 2, 3])
    expect(
      await part.client.putChatAttachmentPart('cat 1', 0, bytes)
    ).deep.equals({ received: 1, parts: 1, missing: [] })
    expect(part.calls[0]).deep.include({
      method: 'PUT',
      url: 'http://x/api/v1/chat/attachments/cat%201/parts/0'
    })
    expect(part.calls[0].headers['content-type']).equals(
      'application/octet-stream'
    )
    expect([...(part.calls[0].body as unknown as Uint8Array)]).deep.equals([
      1, 2, 3
    ])

    const finished = {
      id: 'cat_1',
      conversationId: 'cnv_1',
      size: 9,
      digest: 'DG',
      completed: true
    }
    const completed = client(finished)
    expect(
      await completed.client.completeChatAttachment('cat_1')
    ).to.deep.include(finished)
    expect(completed.calls[0]).deep.include({
      method: 'POST',
      url: 'http://x/api/v1/chat/attachments/cat_1/complete'
    })

    const readable = {
      ...finished,
      url: 'http://space/x',
      expiresAt: '2027-04-10T12:10:00.000Z'
    }
    const read = client(readable)
    expect(await read.client.chatAttachment('cat_1')).deep.equals(readable)
    expect(read.calls[0]).deep.include({
      method: 'GET',
      url: 'http://x/api/v1/chat/attachments/cat_1'
    })
    const unfinished = client(upload)
    expect(await unfinished.client.chatAttachment('cat_1')).deep.equals(upload)
  })

  it('reads isPlayer on team grants, and season and league grants without it', function () {
    expect(
      asScopeGrant({
        id: 'tem_1',
        name: 'Hawks',
        role: 'member',
        isPlayer: true
      }).isPlayer
    ).equals(true)
    expect(
      asScopeGrant({ id: 'sea_1', name: 'Spring', role: 'spectator' }).isPlayer
    ).equals(undefined)
    expect(() =>
      asScopeGrant({ id: 'tem_1', name: 'H', role: 'member', isPlayer: 'yes' })
    ).to.throw()
    const page = asManagePage({
      scope: { kind: 'league', id: 'lea_1', name: 'QPLL', safesportLao: true },
      tree: { leagues: [], seasons: [], teams: [] },
      people: [],
      pending: [],
      invites: []
    })
    expect(page.scope.safesportLao).equals(true)
  })

  it('reads how a team is seen, and a list from before that was said', async function () {
    const now = stubFetch(200, [
      {
        id: 'tem_1',
        name: 'Hawks',
        shortName: null,
        logoPath: null,
        record: null,
        access: 'fan',
        following: true,
        onTeam: false
      },
      { id: 'tem_2', name: 'Owls', shortName: null, logoPath: null }
    ])
    const teams = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: now.fetch
    }).teams()
    expect(teams[0]).deep.include({
      access: 'fan',
      following: true,
      onTeam: false
    })
    expect(teams[1]?.access).equals(undefined)
    expect(teams[1]?.onTeam).equals(undefined)
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
    // An answer without the name and picture still reads.
    expect(users).deep.equals([
      {
        userId: 7,
        externalIds: ['a&b', 'c'],
        shortName: undefined,
        avatarUrl: null
      }
    ])
  })

  it('asks for the players the signed-in person is a guardian of', async function () {
    const { fetch, calls } = stubFetch(200, [
      { userId: 7, externalIds: [], shortName: 'Avery S', avatarUrl: null }
    ])
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    expect(await client.guardedPlayers()).deep.equals([
      { userId: 7, externalIds: [], shortName: 'Avery S', avatarUrl: null }
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
    expect(await client.decideGameRequest('req_demo', 'accept')).deep.equals(
      response
    )
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
      nonMemberView: false,
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
      user: { id: 1, displayName: 'Robin', isAdmin: false }
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
        user: { id: 1, displayName: 'Robin', isAdmin: false }
      },
      { requestId: 'emc_asked', clientSecret: 's', sent: true },
      {
        token: 'tok',
        expiresAt: '2026-11-01T00:00:00.000Z',
        user: { id: 1, displayName: 'Robin', isAdmin: false }
      },
      {
        token: 'tok',
        expiresAt: '2026-11-01T00:00:00.000Z',
        user: { id: 1, displayName: 'Robin', isAdmin: false }
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
