import { expect } from 'chai'
import { asString } from 'cleaners'
import { describe, it } from 'mocha'

import { mintedRosterEntry } from '../test/mintedRosterEntry'
import { testPasswordParameters } from '../test/passwordFixtures'
import { asAccountSettings } from './accountSettings'
import {
  asAccountAffiliations,
  asChatBlock,
  asChatKind,
  asGameDetail,
  asHighlight,
  asLiveNow,
  asLiveStream,
  asManagePage,
  asPage,
  asPersonProfile,
  asPlayerDetail,
  asPlayerHighlight,
  asPlayerStats,
  asPostedEdits,
  asRosterEntry,
  asSaveLineupsBody,
  asScopeGrant,
  asSeasonSummary,
  asSession,
  asStandingsRow,
  isStreamRefusal,
  planRefusal,
  type RequestOptions,
  type SaveLineupsBody,
  STREAM_REFUSAL_PREFIXES,
  TeamStationClient,
  type TimedRequest
} from './api'
import { HttpError, isUpdateRequired } from './errors'
import { GAME_SOCKET_PROTOCOL, PROTOCOL_HEADER } from './gameSocket'
import { asGumboPlay } from './gumboPlay'
import { asNodeAccount } from './nodeAdministration'
import { asGroupDetail, asPublicGroup } from './publicGroups'
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

describe('a player’s stats answer', function () {
  const answer = {
    userId: userIdOfGumbo(7),
    filter: { seasonId: null, teamId: null, year: null },
    games: 1,
    batting: null,
    pitching: null,
    options: { seasons: [], teams: [], years: [] }
  }
  const split = {
    teamId: 'tea_1',
    teamName: 'Hawks',
    seasonName: 'Spring 2026',
    gameId: null,
    startAt: '2026-05-16T18:00:00.000Z',
    opponentName: null,
    home: null
  }

  it('reads the split rows beside the totals', function () {
    const stats = asPlayerStats({
      ...answer,
      splits: {
        by: 'team',
        batting: [
          {
            split,
            line: {
              userId: userIdOfGumbo(7),
              teamId: 'tea_1',
              pa: 4,
              ab: 3,
              h: 2,
              singles: 2,
              doubles: 0,
              triples: 0,
              hr: 0,
              bb: 1,
              k: 0,
              hbp: 0,
              rbi: 1,
              rates: { avg: 0.667 }
            }
          }
        ],
        pitching: []
      }
    })
    expect(stats.splits?.by).equals('team')
    expect(stats.splits?.batting[0].split).deep.equals(split)
    expect(stats.splits?.batting[0].line.rates.avg).equals(0.667)
  })

  it('reads an answer from a server that sends no split rows', function () {
    expect(asPlayerStats(answer).splits).equals(undefined)
  })

  it('refuses a split by anything but a team or a game', function () {
    expect(() =>
      asPlayerStats({
        ...answer,
        splits: { by: 'season', batting: [], pitching: [] }
      })
    ).throws()
  })
})

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
  it('reads the account’s affiliations, and refuses a group of another kind', async () => {
    const group = {
      id: 'tea_hawks',
      kind: 'team',
      name: 'Demo Hawks',
      imageUrl: null,
      locality: null
    }
    const answer = {
      groups: [
        {
          kind: 'team',
          id: 'tea_hawks',
          group,
          roles: ['admin', 'coach'],
          headCoach: true,
          player: true,
          member: false,
          following: true
        }
      ],
      players: [
        {
          userId: userIdOfGumbo(400),
          name: 'Mookie B',
          avatarUrl: null,
          teamNames: ['Demo Hawks']
        }
      ]
    }
    const stub = stubFetch(200, answer)
    const read = await new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: stub.fetch
    }).accountAffiliations()
    expect(stub.calls.map(call => [call.method, call.url])).deep.equals([
      ['GET', '/api/v1/me/affiliations']
    ])
    expect(read.groups[0]).deep.includes({
      kind: 'team',
      roles: ['admin', 'coach'],
      headCoach: true,
      player: true,
      member: false,
      following: true
    })
    expect(read.groups[0].group).deep.equals(asPublicGroup(group))
    expect(read.players).deep.equals(answer.players)
    // An older answer with only the groups, and no flags, reads as none.
    expect(
      asAccountAffiliations({
        groups: [{ kind: 'league', id: 'lea_a', group, roles: [] }]
      })
    ).deep.equals({
      groups: [
        {
          kind: 'league',
          id: 'lea_a',
          group: asPublicGroup(group),
          roles: [],
          headCoach: false,
          player: false,
          member: false,
          following: false
        }
      ],
      players: []
    })
    expect(() =>
      asAccountAffiliations({
        groups: [{ ...answer.groups[0], kind: 'club' }],
        players: []
      })
    ).throws()
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
  it('tells the app a chat call refused for want of an age', async function () {
    let told = 0
    const client = new TeamStationClient({
      baseUrl: 'https://api.example.test/api/v1',
      token: 'tok',
      fetch: async () =>
        Response.json(
          {
            code: 'forbidden',
            message: 'Give your age to use chat',
            details: { reason: 'ageRequired' }
          },
          { status: 403 }
        )
    })
    client.onAgeRequired = () => {
      told += 1
    }
    let failure: unknown
    try {
      await client.chatConversations()
    } catch (error) {
      failure = error
    }
    expect(failure).property('code', 'forbidden')
    expect(told).equals(1)
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

  it('lists, makes and revokes the account’s API keys', async function () {
    const key = {
      id: 'uak_1',
      name: 'Agent',
      secret: 'tsk_abcdefgh',
      createdAt: '2026-10-28T00:00:00.000Z',
      permissions: ['team:read']
    }
    const listed = stubFetch(200, { keys: [key] })
    expect(
      await new TeamStationClient({
        baseUrl: 'http://example.com/api/v1',
        fetch: listed.fetch
      }).apiKeys()
    ).deep.equals([key])
    const made = stubFetch(201, key)
    const client = new TeamStationClient({
      baseUrl: 'http://example.com/api/v1',
      fetch: made.fetch
    })
    expect(
      await client.createApiKey({ name: 'Agent', permissions: ['team:read'] })
    ).deep.equals(key)
    await client.deleteApiKey('uak/1')
    expect(
      made.calls.map(call => [call.method, call.url, call.body])
    ).deep.equals([
      [
        'POST',
        'http://example.com/api/v1/me/api-keys',
        JSON.stringify({ name: 'Agent', permissions: ['team:read'] })
      ],
      ['DELETE', 'http://example.com/api/v1/me/api-keys/uak%2F1', undefined]
    ])
  })

  it('reads the Web Push key, none while the server sends none, registers a device with its switches, changes them and deletes it', async function () {
    const client = (answer: ReturnType<typeof stubFetch>): TeamStationClient =>
      new TeamStationClient({
        baseUrl: 'http://example.com/api/v1',
        fetch: answer.fetch
      })
    const key = stubFetch(200, { publicKey: 'BPublicKey' })
    expect(await client(key).webPushKey()).equals('BPublicKey')
    expect(key.calls.map(call => [call.method, call.url])).deep.equals([
      ['GET', 'http://example.com/api/v1/push/web-key']
    ])
    expect(
      await client(
        stubFetch(404, { code: 'notFound', message: 'Web Push is off' })
      ).webPushKey()
    ).equals(null)
    let refused: unknown
    await client(stubFetch(500, { code: 'internal', message: 'Down' }))
      .webPushKey()
      .catch((error: unknown) => {
        refused = error
      })
    expect(refused).instanceOf(HttpError)
    const posted = stubFetch(200, { id: 'psh_1' })
    const registration = {
      platform: 'web' as const,
      address: '{"endpoint":"https://fcm.googleapis.com/fcm/send/1"}',
      environment: 'production' as const,
      messages: true,
      rsvpEvents: false
    }
    expect(await client(posted).registerPush(registration)).equals('psh_1')
    expect(
      posted.calls.map(call => [call.method, call.url, call.body])
    ).deep.equals([
      [
        'POST',
        'http://example.com/api/v1/me/push-registrations',
        JSON.stringify(registration)
      ]
    ])
    // League management goes with the others when the device says it.
    const third = stubFetch(200, { id: 'psh_2' })
    await client(third).registerPush({
      ...registration,
      leagueManagement: false
    })
    expect(JSON.parse(String(third.calls[0].body))).deep.include({
      leagueManagement: false
    })
    // A switch changed on the device changes the registration, by its id.
    const patched = stubFetch(200, {
      id: 'psh/1',
      messages: true,
      rsvpEvents: true,
      leagueManagement: false
    })
    expect(
      await client(patched).updatePush('psh/1', {
        rsvpEvents: true,
        leagueManagement: false
      })
    ).deep.equals({ messages: true, rsvpEvents: true, leagueManagement: false })
    expect(
      patched.calls.map(call => [call.method, call.url, call.body])
    ).deep.equals([
      [
        'PATCH',
        'http://example.com/api/v1/me/push-registrations/psh%2F1',
        JSON.stringify({ rsvpEvents: true, leagueManagement: false })
      ]
    ])
    // A server from before League management answers two: it is on there.
    expect(
      await client(
        stubFetch(200, { id: 'psh/1', messages: false, rsvpEvents: true })
      ).updatePush('psh/1', { messages: false })
    ).deep.equals({ messages: false, rsvpEvents: true, leagueManagement: true })
    let unclean: unknown
    await client(
      stubFetch(200, {
        id: 'psh/1',
        messages: false,
        rsvpEvents: true,
        leagueManagement: 'yes'
      })
    )
      .updatePush('psh/1', { messages: false })
      .catch((error: unknown) => {
        unclean = error
      })
    expect(unclean).not.equals(undefined)
    // Sign-out deletes it again, by its id.
    const deleted = stubFetch(200, {})
    await client(deleted).unregisterPush('psh/1')
    expect(deleted.calls.map(call => [call.method, call.url])).deep.equals([
      ['DELETE', 'http://example.com/api/v1/me/push-registrations/psh%2F1']
    ])
  })

  it('gives up on a push registration call that gets no answer by the deadline', async function () {
    // A stalled link: the request leaves and nothing ever comes back.
    const stalled = new TeamStationClient({
      baseUrl: 'http://example.com/api/v1',
      fetch: async () => await new Promise<Response>(() => {}),
      requestDeadlineMs: 20
    })
    for (const call of [
      async () =>
        await stalled.registerPush({
          platform: 'android',
          address: 'fcm-1',
          environment: 'production',
          messages: true,
          rsvpEvents: false
        }),
      async () => await stalled.updatePush('psh_1', { messages: false }),
      async () => {
        await stalled.unregisterPush('psh_1')
      }
    ]) {
      let failed: unknown
      await call().catch((error: unknown) => {
        failed = error
      })
      expect(failed).instanceOf(HttpError)
      expect((failed as HttpError).code).equals('offline')
      // Sent in the background, it leaves the phone's banner alone.
      expect(stalled.offline).equals(false)
    }
    // The app's own request on the same link still says it is offline.
    await stalled.accountSettings().catch(() => undefined)
    expect(stalled.offline).equals(true)
  })

  it('never changes offline by a push registration call: not when it fails, and not when it is answered', async function () {
    let reachable = false
    const told: boolean[] = []
    const client = new TeamStationClient({
      baseUrl: 'http://example.com/api/v1',
      fetch: async () => {
        // A request that never leaves the device, as fetch says it.
        if (!reachable) throw new TypeError('Load failed')
        return new Response(
          '{"id":"psh_1","messages":true,"rsvpEvents":true}',
          {
            status: 200
          }
        )
      }
    })
    client.subscribeOffline(offline => told.push(offline))
    const registration = {
      platform: 'ios',
      address: 'apns-1',
      environment: 'production',
      messages: true,
      rsvpEvents: true
    } as const
    expect(
      await client.registerPush(registration).catch((error: unknown) => error)
    ).property('code', 'offline')
    expect(
      await client
        .updatePush('psh_1', { messages: true })
        .catch((error: unknown) => error)
    ).property('code', 'offline')
    expect(
      await client.unregisterPush('psh_1').catch((error: unknown) => error)
    ).property('code', 'offline')
    expect(client.offline).equals(false)
    expect(told).deep.equals([])
    // An ordinary request that fails is the phone offline...
    await client.accountSettings().catch(() => undefined)
    expect(client.offline).equals(true)
    // ...and a push call answered while it is does not bring it back.
    reachable = true
    expect(await client.registerPush(registration)).equals('psh_1')
    expect(await client.updatePush('psh_1', { rsvpEvents: true })).deep.equals({
      messages: true,
      rsvpEvents: true,
      leagueManagement: true
    })
    await client.unregisterPush('psh_1')
    expect(client.offline).equals(true)
    expect(told).deep.equals([true])
  })

  it('sets and clears the node’s Jev key', async function () {
    const { fetch, calls } = stubFetch(200, { ok: true })
    const client = new TeamStationClient({
      baseUrl: 'http://example.com/api/v1',
      fetch
    })
    await client.setJevKey('ts-jev-key')
    await client.clearJevKey()
    expect(calls.map(call => [call.method, call.url, call.body])).deep.equals([
      [
        'PUT',
        'http://example.com/api/v1/node/jev-key',
        JSON.stringify({ apiKey: 'ts-jev-key' })
      ],
      ['DELETE', 'http://example.com/api/v1/node/jev-key', undefined]
    ])
  })

  it('keeps no roster candidates on the web, and asks nothing to', async function () {
    const { fetch, calls } = stubFetch(200, [])
    const client = new TeamStationClient({
      baseUrl: 'http://example.com/api/v1',
      fetch
    })
    await client.keepRosterCandidates('tem_one', [])
    expect(calls).deep.equals([])
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
      { ...entry, walkUpSong: song, affiliations: 'Guardians: Bob M' },
      { ...entry, userId: userIdOfGumbo(8), walkUpSong: null },
      // An older server sends no song and no affiliation line at all.
      { ...entry, userId: userIdOfGumbo(9) }
    ])
    const read = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: roster.fetch
    }).roster('tem_1')
    expect(read.map(row => row.walkUpSong)).deep.equals([song, null, null])
    expect(read.map(row => row.affiliations)).deep.equals([
      'Guardians: Bob M',
      '',
      ''
    ])
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

  it('reads and saves a game’s plans, refusing an answer that does not read', async function () {
    const side = {
      teamId: 'tem 1',
      plan: {
        enabled: true,
        innings: 2,
        rows: [
          {
            player: { gumboId: 7, fullName: 'Lou Gehrig', jersey: '4' },
            cells: ['1B', '']
          },
          {
            player: { gumboId: null, fullName: 'Yogi Berra', jersey: '8' },
            cells: ['C', '-']
          }
        ]
      },
      rules: { defensivePlayingTime: true, measuredIn: 'outs' },
      sameDay: {
        before: { catcherInnings: { 'n:Yogi Berra#8': 2 } },
        laterPitched: { 'g:7': true }
      }
    }
    // An older server also answers the season's history and who caught a
    // fourth inning, which are not read.
    const older = {
      ...side,
      history: { players: {}, lastLeadoff: 'g:7', lastGameSits: {} },
      sameDay: {
        ...side.sameDay,
        before: { ...side.sameDay.before, caughtFourth: { 'g:7': true } }
      }
    }
    const read = stubFetch(200, { away: null, home: older })
    const plans = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: read.fetch
    }).gamePlans('gam 1')
    expect(read.calls[0]).deep.include({
      url: 'http://x/api/v1/games/gam%201/plans',
      method: 'GET'
    })
    expect(plans.away).equals(null)
    // A dash, the bench as an older server stores it, reads as blank.
    expect(plans.home?.plan).deep.equals({
      ...side.plan,
      rows: [side.plan.rows[0], { ...side.plan.rows[1], cells: ['C', ''] }]
    })
    // A rule the server left out takes its default.
    expect(plans.home?.rules?.measuredIn).equals('outs')
    expect(plans.home?.rules?.outs).deep.equals({
      required: 6,
      consecutive: false
    })
    expect(Object.keys(plans.home ?? {})).not.includes('history')
    expect(plans.home?.sameDay).deep.equals(side.sameDay)
    // Rules in the first version's shape read into this one.
    const first = stubFetch(200, {
      away: null,
      home: {
        ...side,
        rules: { mandatoryPlay: true, catcherInningLimit: true }
      }
    })
    expect(
      (
        await new TeamStationClient({
          baseUrl: 'http://x/api/v1',
          fetch: first.fetch
        }).gamePlans('gam 1')
      ).home?.rules
    ).deep.include({
      defensivePlayingTime: true,
      measuredIn: 'outs',
      catcherMaxInnings: 4
    })

    const saved = stubFetch(200, { ...side, plan: null, rules: null })
    const plan = side.plan as Parameters<TeamStationClient['saveGamePlan']>[2]
    const answer = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: saved.fetch
    }).saveGamePlan('gam 1', 'tem 1', plan)
    expect(saved.calls[0]).deep.include({
      url: 'http://x/api/v1/games/gam%201/plans/tem%201',
      method: 'PUT'
    })
    expect(JSON.parse(saved.calls[0].body ?? '')).deep.equals(plan)
    expect(answer).to.include({ teamId: 'tem 1', plan: null, rules: null })

    for (const bad of [
      [],
      { away: null },
      { away: null, home: { ...side, plan: { ...side.plan, innings: 3 } } },
      {
        away: null,
        home: {
          ...side,
          sameDay: { ...side.sameDay, laterPitched: { 'g:7': 1 } }
        }
      },
      // A same-day load not split at the game.
      {
        away: null,
        home: {
          ...side,
          sameDay: { catcherInnings: {}, pitched: {} }
        }
      }
    ]) {
      let refused = false
      try {
        await new TeamStationClient({
          baseUrl: 'http://x/api/v1',
          fetch: stubFetch(200, bad).fetch
        }).gamePlans('g')
      } catch {
        refused = true
      }
      expect(refused, JSON.stringify(bad)).equals(true)
    }
  })

  it('reads one team’s column for the inning in play, aborts it on its signal, and tells why the route refused', async function () {
    const column = [
      {
        player: { gumboId: null, fullName: 'Yogi Berra', jersey: '8' },
        cell: ''
      },
      {
        player: { gumboId: 7, fullName: 'Lou Gehrig', jersey: '4' },
        cell: '1B'
      }
    ]
    const read = stubFetch(200, { teamId: 'tem 1', inning: 3, column })
    const answer = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: read.fetch
    }).planInning('gam 1', 'tem 1', 3)
    expect(read.calls[0]).deep.include({
      url: 'http://x/api/v1/games/gam%201/plans/tem%201/innings/3',
      method: 'GET'
    })
    expect(answer).deep.equals({ teamId: 'tem 1', inning: 3, column })
    for (const bad of [
      { teamId: 'tem 1', inning: 3 },
      { teamId: 'tem 1', inning: 3, column: [{ ...column[0], cell: 'XX' }] }
    ]) {
      let refused = false
      try {
        await new TeamStationClient({
          baseUrl: 'http://x/api/v1',
          fetch: stubFetch(200, bad).fetch
        }).planInning('g', 't', 1)
      } catch {
        refused = true
      }
      expect(refused, JSON.stringify(bad)).equals(true)
    }

    // The signal reaches fetch, which aborts.
    let signal: AbortSignal | undefined
    const aborting = (async (
      _url: unknown,
      init?: { signal?: AbortSignal }
    ) => {
      signal = init?.signal
      return await new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
      })
    }) as unknown as typeof fetch
    const controller = new AbortController()
    const pending = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: aborting
    }).planInning('g', 't', 1, { signal: controller.signal })
    controller.abort()
    let aborted = false
    try {
      await pending
    } catch {
      aborted = true
    }
    expect(aborted).equals(true)
    expect(signal?.aborted).equals(true)

    const refusal = async (status: number, body: unknown): Promise<unknown> => {
      try {
        await new TeamStationClient({
          baseUrl: 'http://x/api/v1',
          fetch: stubFetch(status, body).fetch
        }).planInning('g', 't', 1)
      } catch (error) {
        return planRefusal(error)
      }
      throw new Error('Expected a refusal')
    }
    expect(
      await refusal(403, {
        code: 'forbidden',
        message: 'Not yet',
        details: { reason: 'planNotStarted' }
      })
    ).equals('planNotStarted')
    expect(
      await refusal(403, {
        code: 'forbidden',
        message: 'Over',
        details: { reason: 'planGameOver' }
      })
    ).equals('planGameOver')
    expect(
      await refusal(409, {
        code: 'conflict',
        message: 'Not in play',
        details: { reason: 'planInningNotCurrent', inning: 2 }
      })
    ).equals('planInningNotCurrent')
    expect(await refusal(403, { code: 'forbidden', message: 'No' })).equals(
      null
    )
    expect(
      await refusal(403, {
        code: 'forbidden',
        message: 'No',
        details: { reason: 'somethingElse' }
      })
    ).equals(null)
    expect(planRefusal(new Error('offline'))).equals(null)
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

    const external = stubFetch(201, device)
    await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: external.fetch
    }).addLiveStream('gam 1', 'Backstop', { source: 'gopro' })
    expect(JSON.parse(external.calls[0].body ?? '')).deep.equals({
      label: 'Backstop',
      source: 'gopro'
    })

    const discarded = stubFetch(200, {
      gameId: 'gam 1',
      mine: [],
      others: [],
      canAdd: 4,
      maxCameras: 4,
      gameCanAdd: 4,
      discarded: ['liv_1']
    })
    const left = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: discarded.fetch
    }).discardLiveStream('gam 1', 'liv_1')
    expect(discarded.calls[0].method).equals('POST')
    expect(discarded.calls[0].url).equals(
      'http://x/api/v1/games/gam%201/live-streams/liv_1/discard'
    )
    expect(left.discarded).deep.equals(['liv_1'])

    const revoked = stubFetch(200, {
      removed: true,
      streams: {
        gameId: 'gam 1',
        mine: [],
        others: [],
        canAdd: 4,
        maxCameras: 4
      }
    })
    const answer = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: revoked.fetch
    }).revokeLiveStream('gam 1', 'liv_1')
    expect(revoked.calls[0].method).equals('POST')
    expect(revoked.calls[0].url).equals(
      'http://x/api/v1/games/gam%201/live-streams/liv_1/revoke'
    )
    expect(answer.removed).equals(true)

    const access = stubFetch(200, {
      canFilm: false,
      canRequest: true,
      requested: false,
      teamId: 'tem_home'
    })
    expect(
      await new TeamStationClient({
        baseUrl: 'http://x/api/v1',
        fetch: access.fetch
      }).streamAccess('gam 1')
    ).deep.equals({
      canFilm: false,
      canRequest: true,
      requested: false,
      teamId: 'tem_home'
    })
    expect(access.calls[0].method).equals('GET')
    expect(access.calls[0].url).equals(
      'http://x/api/v1/games/gam%201/stream-access'
    )

    const filmRequest = stubFetch(201, { id: 'inv_1', status: 'pending' })
    await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: filmRequest.fetch
    }).inviteRelationship({
      kind: 'videographer',
      teamId: 'tem_home',
      idempotencyKey: 'film-request'
    })
    expect(filmRequest.calls[0].url).equals(
      'http://x/api/v1/relationship-requests'
    )
    expect(JSON.parse(filmRequest.calls[0].body ?? '')).deep.equals({
      kind: 'videographer',
      teamId: 'tem_home',
      idempotencyKey: 'film-request'
    })

    // An older server says neither: room for the game, nothing discarded.
    const older = stubFetch(200, {
      gameId: 'gam 1',
      mine: [],
      others: [],
      canAdd: 4,
      maxCameras: 4
    })
    const listed = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: older.fetch
    }).liveStreams('gam 1')
    expect(listed.gameCanAdd).equals(undefined)
    expect(listed.maxGameCameras).equals(undefined)
    expect(listed.discarded).deep.equals([])

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
    expect(await follow.client.followTeam('tem 1')).equals(true)
    expect(follow.calls[0]).deep.include({
      method: 'PUT',
      url: 'http://x/api/v1/teams/tem%201/follow'
    })

    const unfollow = client({ following: false })
    expect(await unfollow.client.unfollowTeam('tem_1')).equals(false)
    expect(unfollow.calls[0]).deep.include({
      method: 'DELETE',
      url: 'http://x/api/v1/teams/tem_1/follow'
    })

    const mine = client([{ ...hawks, following: true }])
    expect((await mine.client.myFollows())[0]?.following).equals(true)
    expect(mine.calls[0].url).equals('http://x/api/v1/me/team-follows')

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
      {
        userId: userIdOfGumbo(42),
        shortName: 'Hank C',
        avatarUrl: null,
        roles: ['coach']
      }
    ])
    expect(await staff.client.teamStaff('tem_1')).deep.equals([
      {
        userId: userIdOfGumbo(42),
        shortName: 'Hank C',
        avatarUrl: null,
        roles: ['coach']
      }
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
    const g1 = {
      userId: userIdOfGumbo(7),
      name: 'Gale G',
      email: 'g1@x',
      kind: 'guardian'
    }

    const list = client([g1])
    expect(await list.client.guardians('tem 1', userIdOfGumbo(42))).deep.equals(
      [g1]
    )
    expect(list.calls[0].url).equals(
      `http://x/api/v1/teams/tem%201/players/${userIdOfGumbo(42)}/guardians`
    )

    const byId = client({ guardians: [g1] })
    expect(
      await byId.client.addGuardian('tem_1', userIdOfGumbo(42), {
        userId: userIdOfGumbo(7)
      })
    ).deep.equals({ guardians: [g1], invited: undefined })
    expect(byId.calls[0].method).equals('POST')
    expect(JSON.parse(byId.calls[0].body ?? '')).deep.equals({
      userId: userIdOfGumbo(7),
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
          userIdOfGumbo(42),
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
    expect(
      await removed.client.removeGuardian(
        'tem_1',
        userIdOfGumbo(42),
        userIdOfGumbo(7)
      )
    ).equals(true)
    expect(removed.calls[0]).deep.include({
      method: 'DELETE',
      url: `http://x/api/v1/teams/tem_1/players/${userIdOfGumbo(42)}/guardians/${userIdOfGumbo(7)}`
    })

    const minor = {
      userId: userIdOfGumbo(42),
      band: 'minor',
      birthMonth: '2012-03',
      isAdult: false
    }
    const born = client(minor)
    expect(
      await born.client.setAge(userIdOfGumbo(42), { year: 2012, month: 3 })
    ).deep.equals(minor)
    expect(born.calls[0]).deep.include({
      method: 'PUT',
      url: `http://x/api/v1/people/${userIdOfGumbo(42)}/age`
    })
    expect(JSON.parse(born.calls[0].body ?? '')).deep.equals({
      year: 2012,
      month: 3
    })
    const cleared = client({ ...minor, band: 'unknown', birthMonth: null })
    expect(
      (await cleared.client.setAge(userIdOfGumbo(42), null)).birthMonth
    ).equals(null)
    expect(JSON.parse(cleared.calls[0].body ?? '')).deep.equals({
      year: null,
      month: null
    })

    const view = {
      band: 'adult',
      birthYear: null,
      birthMonth: null,
      isAdult: true,
      ageSource: 'apple',
      ageSetAt: '2026-11-20T12:00:00.000Z'
    }
    const mine = client(view)
    expect(await mine.client.myAge()).deep.equals(view)
    expect(mine.calls[0]).deep.include({
      method: 'GET',
      url: 'http://x/api/v1/me/account/age'
    })
    const given = client(view)
    expect(
      await given.client.setMyAge({ apple: { lowerBound: 18 } })
    ).deep.equals(view)
    expect(given.calls[0]).deep.include({
      method: 'PUT',
      url: 'http://x/api/v1/me/account/age'
    })
    expect(JSON.parse(given.calls[0].body ?? '')).deep.equals({
      apple: { lowerBound: 18 }
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
      people: [{ userId: userIdOfGumbo(7), shortName: 'Eli C', left: true }]
    }
    const list = client([chat, dm])
    // A server that names nobody (an older one) reads as nobody to name.
    expect(await list.client.chatConversations()).deep.equals([
      {
        ...chat,
        avatarName: null,
        avatarUrl: null,
        leagueId: null,
        leaguePictureUrl: null,
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
        avatarName: null,
        avatarUrl: null,
        leagueId: null,
        leaguePictureUrl: null,
        people: dm.people.map(person => ({
          ...person,
          avatarUrl: null
        })),
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
    // It names the newer chat kinds it reads, and a kind it does not know,
    // from a newer server still, is left out rather than failing the list.
    expect(list.calls[0].headers['x-teamstation-chat-kinds']).equals(
      'leagueUmpires'
    )
    const newer = client([
      { ...chat, id: 'cnv_new', kind: 'leagueReferees' },
      { ...chat, id: 'cnv_umpires', kind: 'leagueUmpires' },
      chat
    ])
    expect(
      (await newer.client.chatConversations()).map(item => item.id)
    ).deep.equals(['cnv_umpires', 'cnv_1'])
    // A malformed row of a known kind still fails.
    expect(
      await client([{ ...chat, unread: 'one' }])
        .client.chatConversations()
        .catch((error: unknown) => error)
    ).instanceOf(Error)
    // And so does a missing or malformed kind: a broken answer, not a newer one.
    for (const kind of [null, undefined, 7])
      expect(
        await client([{ ...chat, kind }])
          .client.chatConversations()
          .catch((error: unknown) => error)
      ).instanceOf(Error)

    // A coach reads Hank Conger in full; the public label rides beside it.
    const member = {
      userId: userIdOfGumbo(42),
      shortName: 'Hank Conger',
      compactName: 'Hank C',
      avatarUrl: null,
      label: 'Coach',
      isModerator: true,
      isApprover: true,
      eligible: false,
      hasIdentity: false,
      identityKey: null,
      generation: null
    }
    // An older server sends no affiliation line, which reads as none.
    const members = client([member])
    expect(await members.client.chatMembers('cnv 1')).deep.equals([
      { ...member, affiliations: '' }
    ])
    const lined = {
      ...member,
      affiliations: 'Guardian of Tim R · Demo Eagles'
    }
    expect(await client([lined]).client.chatMembers('cnv 1')).deep.equals([
      lined
    ])
    expect(members.calls[0].url).equals(
      'http://x/api/v1/chat/conversations/cnv%201/members'
    )

    const reads = client([{ userId: userIdOfGumbo(42), seq: 3 }])
    expect(await reads.client.chatReads('cnv_1')).deep.equals([
      { userId: userIdOfGumbo(42), seq: 3 }
    ])
    expect(reads.calls[0].url).equals(
      'http://x/api/v1/chat/conversations/cnv_1/reads'
    )

    const row = {
      seq: 1,
      event: 'join',
      userId: userIdOfGumbo(42),
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

    const person = {
      userId: userIdOfGumbo(42),
      shortName: 'Hank Conger',
      compactName: 'Hank C',
      avatarUrl: null
    }
    const candidates = client([person])
    expect(await candidates.client.dmCandidates('ha nk')).deep.equals([
      { ...person, affiliations: '' }
    ])
    const lined2 = {
      ...person,
      affiliations: 'Demo Eagles'
    }
    expect(await client([lined2]).client.dmCandidates('ha nk')).deep.equals([
      lined2
    ])
    expect(candidates.calls[0].url).equals(
      'http://x/api/v1/chat/dm-candidates?q=ha%20nk'
    )
    await client([]).client.dmCandidates()
    await candidates.client.dmCandidates('', person.userId)
    expect(candidates.calls[1].url).equals(
      `http://x/api/v1/chat/dm-candidates?q=&userId=${encodeURIComponent(person.userId)}`
    )

    const reachOf = client({ reach: 'proxies' })
    expect(await reachOf.client.dmReach(person.userId)).equals('proxies')
    expect(reachOf.calls[0].url).equals(
      `http://x/api/v1/chat/dm-reach?userId=${encodeURIComponent(person.userId)}`
    )
    expect(await client({ reach: null }).client.dmReach(person.userId)).equals(
      null
    )
    expect(
      await client({ reach: 'maybe' })
        .client.dmReach('x')
        .catch((error: unknown) => error)
    ).instanceOf(Error)
    const proxies = client({
      player: { userId: person.userId, shortName: 'Riley Rookie' },
      kind: 'guardians',
      people: [person]
    })
    // An older server says nothing of why: no account, as it always meant.
    expect(await proxies.client.dmProxies(person.userId)).deep.equals({
      player: { userId: person.userId, shortName: 'Riley Rookie' },
      kind: 'guardians',
      why: 'noAccount',
      people: [{ ...person, affiliations: '' }]
    })
    expect(
      (
        await client({
          player: { userId: person.userId, shortName: 'Riley Rookie' },
          kind: 'guardians',
          why: 'tooYoung',
          people: []
        }).client.dmProxies(person.userId)
      ).why
    ).equals('tooYoung')
    expect(proxies.calls[0].url).equals(
      `http://x/api/v1/chat/dm-proxies?userId=${encodeURIComponent(person.userId)}`
    )
    expect(
      await client({
        player: { userId: person.userId, shortName: 'R' },
        kind: 'parents',
        people: []
      })
        .client.dmProxies('x')
        .catch((error: unknown) => error)
    ).instanceOf(Error)

    const adult = {
      userId: userIdOfGumbo(7),
      shortName: 'Gale G',
      compactName: undefined,
      label: 'Guardian'
    }
    const adults = client([adult])
    expect(
      await adults.client.includedAdults(
        [userIdOfGumbo(1), userIdOfGumbo(2)],
        'ga'
      )
    ).deep.equals([adult])
    expect(adults.calls[0].url).equals(
      `http://x/api/v1/chat/included-adults?playerIds=${[1, 2].map(userIdOfGumbo).join(',')}&q=ga`
    )
    await client([]).client.includedAdults([userIdOfGumbo(1)])

    const made = client({ ...chat, kind: 'dm', title: null, scope: null })
    expect((await made.client.createDm([userIdOfGumbo(42)])).kind).equals('dm')
    expect(made.calls[0]).deep.include({
      method: 'POST',
      url: 'http://x/api/v1/chat/dms'
    })
    expect(JSON.parse(made.calls[0].body ?? '')).deep.equals({
      userIds: [userIdOfGumbo(42)]
    })

    const added = client({ added: [userIdOfGumbo(7)] })
    expect(
      await added.client.addDmMembers('cnv_1', [
        userIdOfGumbo(7),
        userIdOfGumbo(8)
      ])
    ).deep.equals([userIdOfGumbo(7)])
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
    await revoked.client.revokeChatDevice('cdv 1', { keepSession: true })
    expect(revoked.calls[1]).deep.include({
      method: 'DELETE',
      url: 'http://x/api/v1/chat/devices/cdv%201?keepSession=true'
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
      userId: userIdOfGumbo(42),
      identity: { id: 'cid_9', publicKey: 'II', createdAt: 'then' },
      puk: { generation: 3, publicKey: 'PK', signature: 'SG' }
    }
    const users = client(theirs)
    expect(await users.client.chatUserKeys(userIdOfGumbo(42))).deep.equals(
      theirs
    )
    expect(users.calls[0].url).equals(
      `http://x/api/v1/chat/users/${userIdOfGumbo(42)}/keys`
    )
    await client({
      userId: userIdOfGumbo(42),
      identity: null,
      puk: null
    }).client.chatUserKeys(userIdOfGumbo(42))

    const old = {
      id: 'cid_9',
      userId: userIdOfGumbo(42),
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
      declined: undefined,
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
    const declined = client({ ...link, declined: true })
    expect(await declined.client.declineChatLink('clk_1')).deep.equals({
      ...link,
      declined: true
    })
    expect(declined.calls[0]).deep.include({
      method: 'POST',
      url: 'http://x/api/v1/chat/links/clk_1/decline'
    })
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
          createdByUserId: userIdOfGumbo(7),
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
      boxes: [{ userId: userIdOfGumbo(7), pukGeneration: 1, box: 'BX' }]
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
      userId: userIdOfGumbo(8),
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
        userId: userIdOfGumbo(8),
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
          userId: userIdOfGumbo(8),
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
      senderUserId: userIdOfGumbo(7),
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

    for (const invalidReceipt of ['', { seq: 3 }]) {
      const failure = await client(invalidReceipt)
        .client.postChatMessage('cnv_1', envelope)
        .catch((error: unknown) => error)
      expect(failure).instanceOf(HttpError)
      expect((failure as HttpError).code).equals('internal')
    }
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
      verified: true,
      blockedUserIds: undefined
    })
    expect(reported.calls[0]).deep.include({
      method: 'POST',
      url: 'http://x/api/v1/chat/reports'
    })
    expect(JSON.parse(reported.calls[0].body ?? '')).deep.equals(disclosure)

    const blockedUserIds = [userIdOfGumbo(7), userIdOfGumbo(9)]
    const combined = client({ id: 'crp_2', verified: true, blockedUserIds })
    expect(
      await combined.client.reportChatMessage({
        ...disclosure,
        blockSender: true
      })
    ).deep.equals({ id: 'crp_2', verified: true, blockedUserIds })
    expect(JSON.parse(combined.calls[0].body ?? '')).deep.equals({
      ...disclosure,
      blockSender: true
    })

    const report = {
      id: 'crp_1',
      conversation: {
        id: 'cnv_1',
        kind: 'teamMembers',
        title: 'Hawks Members'
      },
      messageId: message.id,
      reporter: { userId: userIdOfGumbo(8), shortName: 'Blair B' },
      sender: { userId: userIdOfGumbo(7), shortName: 'Casey C' },
      kind: 'post',
      sentAt: '2027-04-10T12:00:00.000Z',
      plaintext: '{"type":"text"}',
      verified: true,
      createdAt: '2027-04-10T12:01:00.000Z',
      resolvedAt: null
    }
    const listed = client([report])
    expect(await listed.client.chatReports()).deep.equals([report])
    // A report from a chat of a kind this build does not know is left out.
    expect(
      await client([
        {
          ...report,
          id: 'crp_new',
          conversation: { ...report.conversation, kind: 'leagueReferees' }
        },
        report
      ]).client.chatReports()
    ).deep.equals([report])
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
    ).equals(false)
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

  it('reads an answer the same whatever revision header it carries, and keeps none', async function () {
    const answers: Array<Record<string, string>> = [
      {},
      { 'x-teamstation-revision': '4' }
    ]
    const read = await Promise.all(
      answers.map(async headers => {
        const client = new TeamStationClient({
          baseUrl: 'http://x/api/v1',
          fetch: async () => new Response('[]', { status: 200, headers })
        })
        return { teams: await client.teams(), client }
      })
    )
    expect(read[1].teams).deep.equals(read[0].teams).deep.equals([])
    expect('revisionFor' in read[1].client).equals(false)
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

  it('reads schedule pages with what they asked for, escaped', async function () {
    const page = {
      items: [],
      nextCursor: 'after',
      prevCursor: null,
      anchorId: null,
      counts: null
    }
    const { fetch, calls } = stubFetch(200, page)
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    expect(await client.gamesPage()).deep.equals(page)
    await client.gamesPage({
      when: 'past',
      order: 'desc',
      hasVideo: true,
      limit: 25,
      cursor: 'a+b'
    })
    await client.gamesPage({ when: 'all' })
    await client.seasonGamesPage('s/1', { when: 'upcoming' })
    await client.seasonGamesPage('s/1')
    await client.teamGamesPage('t/1', { around: 'next', order: 'asc' })
    await client.teamGamesPage('t/1')
    expect(
      calls.map(call => call.url.replace('http://x/api/v1', ''))
    ).deep.equals([
      '/events?paged=1',
      '/events?paged=1&when=past&order=desc&hasVideo=1&cursor=a%2Bb&limit=25',
      '/events?paged=1',
      '/events?season=s%2F1&paged=1&when=upcoming',
      '/events?season=s%2F1&paged=1',
      '/teams/t%2F1/games?paged=1&order=asc&around=next',
      '/teams/t%2F1/games?paged=1'
    ])
  })

  it('reads public pages of a team or a season, with their own rows', async function () {
    const game = {
      id: 'gam_1',
      homeTeam: { id: 'tem_1', name: 'Demo Hawks' },
      awayTeam: { id: 'tem_2', name: 'Demo Eagles' },
      seasonId: null,
      startAt: '2027-04-01T19:00:00.000Z',
      venue: null,
      status: 'scheduled',
      homeScore: null,
      awayScore: null,
      cancellationReason: null,
      withdrawnByTeamId: null
    }
    const { fetch, calls } = stubFetch(200, {
      items: [game],
      nextCursor: null,
      prevCursor: null,
      anchorId: null,
      counts: null
    })
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    const page = await client.publicGamesPage('team', 't/1', {
      when: 'past',
      order: 'asc',
      hasVideo: true,
      cursor: 'a+b',
      limit: 5
    })
    expect(page.items[0].homeTeam.name).equals('Demo Hawks')
    expect(page.items[0].videoCount).equals(0)
    await client.publicGamesPage('season', 's/1')
    expect(
      calls.map(call => call.url.replace('http://x/api/v1', ''))
    ).deep.equals([
      '/teams/t%2F1/games?public=1&paged=1&when=past&order=asc&hasVideo=1&cursor=a%2Bb&limit=5',
      '/seasons/s%2F1/games?public=1&paged=1'
    ])
  })

  it('reads an umpire page with its columns, and its query as the whole one', async function () {
    const page = {
      settings: { management: true, credits: false },
      levels: [],
      types: [],
      noteTypes: [],
      viewerId: 'usr_1',
      isAdmin: false,
      view: 'schedule',
      creditTeams: [],
      items: [],
      nextCursor: null,
      prevCursor: null,
      anchorId: null,
      counts: null,
      positions: [
        {
          slot: 'uty_field:2',
          typeId: 'uty_field',
          typeName: 'Field',
          ordinal: 2,
          required: false,
          optionalHeader: 'Optional'
        }
      ]
    }
    const { fetch, calls } = stubFetch(200, page)
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    const answer = await client.umpireSchedulePage(
      'l/1',
      'view=schedule&days=0,4&levels=',
      { around: 'next', limit: 9 }
    )
    expect(answer.positions[0].optionalHeader).equals('Optional')
    await client.umpireSchedulePage('l/1', 'view=schedule', { cursor: 'a+b' })
    await client.umpireSchedulePage('l/1')
    // A notice opens the schedule on its game.
    await client.umpireSchedulePage('l/1', 'view=schedule', {
      around: 'gam_one'
    })
    expect(
      calls.map(call => call.url.replace('http://x/api/v1', ''))
    ).deep.equals([
      '/leagues/l%2F1/umpire-schedule?view=schedule&days=0&days=4&paged=1&around=next&limit=9',
      '/leagues/l%2F1/umpire-schedule?view=schedule&paged=1&cursor=a%2Bb',
      '/leagues/l%2F1/umpire-schedule?paged=1',
      '/leagues/l%2F1/umpire-schedule?view=schedule&paged=1&around=gam_one'
    ])
  })

  it('reads and changes the caller’s own Umpire Management Notifications', async function () {
    const calls: Call[] = []
    const answer = {
      missingSlots: true,
      daysBefore: 3,
      signUps: false,
      withdrawals: true
    }
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, answer, calls).fetch
    })
    expect(await client.umpireNotifications('l/1')).deep.equals(answer)
    expect(
      await client.setUmpireNotifications('l/1', { daysBefore: 3 })
    ).deep.equals(answer)
    expect(
      calls.map(call => [
        call.method,
        call.url.replace('http://x/api/v1', ''),
        call.body
      ])
    ).deep.equals([
      ['GET', '/leagues/l%2F1/umpire-notifications', undefined],
      [
        'PUT',
        '/leagues/l%2F1/umpire-notifications',
        JSON.stringify({ daysBefore: 3 })
      ]
    ])
    let refused: unknown
    await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, { ...answer, daysBefore: '3' }).fetch
    })
      .umpireNotifications('l/1')
      .catch((error: unknown) => {
        refused = error
      })
    expect(refused).not.equals(undefined)
  })

  it('saves the schedule’s default sort and the league’s season order', async function () {
    const calls: Call[] = []
    const settings = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(
        200,
        { management: true, credits: false, sort: ['-certification'] },
        calls
      ).fetch
    })
    expect(
      await settings.setUmpireSettings('l/1', { sort: ['-certification'] })
    ).deep.equals({
      management: true,
      credits: false,
      sort: ['-certification']
    })
    await settings.setUmpireSettings('l/1', { sort: null })
    const season = {
      id: 'sea_1',
      name: 'Demo Spring',
      logoUrl: null,
      leagueId: 'l/1',
      leaguePictureUrl: null,
      requirement: null
    }
    const priority = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(
        200,
        {
          seasons: [
            { ...season, priority: 1 },
            { ...season, id: 'sea_2', priority: null }
          ]
        },
        calls
      ).fetch
    })
    const ordered = await priority.setUmpireSeasonPriority('l/1', [
      'sea_1',
      'sea_2'
    ])
    expect(ordered.map(one => [one.id, one.priority])).deep.equals([
      ['sea_1', 1],
      ['sea_2', null]
    ])
    expect(
      calls.map(call => [
        call.method,
        call.url.replace('http://x/api/v1', ''),
        call.body
      ])
    ).deep.equals([
      [
        'PUT',
        '/leagues/l%2F1/umpire-settings',
        JSON.stringify({ sort: ['-certification'] })
      ],
      ['PUT', '/leagues/l%2F1/umpire-settings', JSON.stringify({ sort: null })],
      [
        'PUT',
        '/leagues/l%2F1/umpire-season-priority',
        JSON.stringify({ seasonIds: ['sea_1', 'sea_2'] })
      ]
    ])
    const refused = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, { seasons: [{ ...season, priority: 'one' }] }).fetch
    })
    let failure: unknown
    await refused
      .setUmpireSeasonPriority('l/1', ['sea_1'])
      .catch((error: unknown) => {
        failure = error
      })
    expect(failure).not.equals(undefined)
  })

  it('reads, saves and queries umpire availability, and reads commitments', async function () {
    const availability = {
      levels: ['ulv_1'],
      days: [0, 4],
      from: '17:00',
      to: '22:00',
      timezone: 'America/Chicago'
    }
    const person = {
      id: 'usr_1',
      name: 'Mookie B',
      avatarUrl: null,
      affiliations: '',
      certifications: []
    }
    const calls: Call[] = []
    const answer = stubFetch(200, { availability }, calls)
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: answer.fetch
    })
    expect(await client.umpireAvailability('l/1')).deep.equals(availability)
    expect(
      await client.saveUmpireAvailability('l/1', availability)
    ).deep.equals(availability)
    const cleared = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, { availability: null }, calls).fetch
    })
    expect(await cleared.saveUmpireAvailability('l/1', null)).equals(null)
    const people = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(
        200,
        {
          people: [
            { ...person, umpireAvailability: availability },
            { ...person, id: 'usr_2', umpireAvailability: null },
            { ...person, id: 'usr_3' }
          ]
        },
        calls
      ).fetch
    })
    const listed = await people.umpirePeople('l/1', undefined, {
      availableAt: '2027-04-13T01:30:00.000Z',
      durationMinutes: 120,
      level: 'ulv_1',
      strict: true
    })
    expect(listed.map(one => one.umpireAvailability)).deep.equals([
      availability,
      null,
      undefined
    ])
    await people.umpirePeople('l/1', undefined, { day: 0, time: '18:00' })
    await people.umpirePeople('l/1')
    // Candidates take no availability parameters.
    await people.umpirePeople('l/1', 'ma', { day: 0, time: '18:00' })
    const commitment = {
      gameId: 'gam_1',
      leagueId: 'l/1',
      startAt: '2027-04-13T01:30:00.000Z',
      endAt: '2027-04-13T04:30:00.000Z',
      home: 'Demo Rockets',
      away: 'Demo Comets',
      role: 'umpire',
      slot: 'uty_plate:1'
    }
    const reads = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(
        200,
        {
          commitments: [
            commitment,
            { ...commitment, role: 'player', slot: undefined }
          ]
        },
        calls
      ).fetch
    })
    const held = await reads.umpireCommitments(
      'l/1',
      'usr/1',
      '2027-04-12T00:00:00Z',
      '2027-04-14T00:00:00Z'
    )
    expect(held.map(one => [one.role, one.slot])).deep.equals([
      ['umpire', 'uty_plate:1'],
      ['player', undefined]
    ])
    expect(
      calls.map(call => [
        call.method,
        call.url.replace('http://x/api/v1', ''),
        call.body
      ])
    ).deep.equals([
      ['GET', '/leagues/l%2F1/me/umpire-availability', undefined],
      [
        'PUT',
        '/leagues/l%2F1/me/umpire-availability',
        JSON.stringify({ availability })
      ],
      [
        'PUT',
        '/leagues/l%2F1/me/umpire-availability',
        JSON.stringify({ availability: null })
      ],
      [
        'GET',
        '/leagues/l%2F1/umpires?availableAt=2027-04-13T01%3A30%3A00.000Z&durationMinutes=120&level=ulv_1&strict=true',
        undefined
      ],
      ['GET', '/leagues/l%2F1/umpires?day=0&time=18%3A00', undefined],
      ['GET', '/leagues/l%2F1/umpires', undefined],
      ['GET', '/leagues/l%2F1/umpire-candidates?q=ma', undefined],
      [
        'GET',
        '/leagues/l%2F1/umpires/usr%2F1/commitments?from=2027-04-12T00%3A00%3A00Z&to=2027-04-14T00%3A00%3A00Z',
        undefined
      ]
    ])
    expect(() =>
      asPersonProfile({
        context: { kind: 'league', id: 'l', name: 'Demo League' },
        person: {
          userId: userIdOfGumbo(7),
          shortName: 'Mookie B',
          fullName: null,
          avatarUrl: null,
          canHoldRoles: true
        },
        guardianOf: [],
        sections: [],
        viewer: { manages: false, admin: false },
        umpireAvailability: { ...availability, days: 'Monday' }
      })
    ).throws()
  })

  it('reads umpireAvailability on a profile only when the server sends it', function () {
    const profile = {
      context: { kind: 'league', id: 'l', name: 'Demo League' },
      person: {
        userId: userIdOfGumbo(7),
        shortName: 'Mookie B',
        fullName: null,
        avatarUrl: null,
        canHoldRoles: true
      },
      guardianOf: [],
      sections: [],
      viewer: { manages: false, admin: false }
    }
    expect(asPersonProfile(profile).umpireAvailability).equals(undefined)
    expect(
      asPersonProfile({ ...profile, umpireAvailability: null })
        .umpireAvailability
    ).equals(null)
  })

  it('cleans a page and refuses a bare array as one', function () {
    const counts = {
      total: 3,
      upcoming: 1,
      withVideo: 2,
      videos: 4,
      newestSeasonId: null
    }
    const clean = asPage(asString)
    expect(
      clean({
        items: ['a'],
        nextCursor: null,
        prevCursor: 'before',
        anchorId: 'a',
        counts
      })
    ).deep.equals({
      items: ['a'],
      nextCursor: null,
      prevCursor: 'before',
      anchorId: 'a',
      counts
    })
    expect(() => clean(['a'])).throws()
    expect(() => clean({ items: [1] })).throws()
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
    const dictating = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, { plays: [], modelNames: { 7: 'Alex L.' } }).fetch
    })
    expect((await dictating.gameEvents('g')).modelNames).deep.equals({
      7: 'Alex L.'
    })
    // The players its reader reads in full, beside plays named for everyone.
    const reading = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, { plays: [], readerNames: { 7: 'Alex Lee' } }).fetch
    })
    expect((await reading.gameEvents('g')).readerNames).deep.equals({
      7: 'Alex Lee'
    })
    // ...which the cleaner gives the game's players: the full name, with the
    // public label beside it; the play's references stay as everyone's.
    const setupPlayer = {
      id: 7,
      teamId: 'tem_1',
      fullName: 'Alex L',
      jersey: '7',
      bats: 'right',
      throws: 'right',
      positions: [],
      local: false
    }
    const withSetup = {
      ...play,
      matchup: {
        batter: { id: 7, fullName: 'Alex L' },
        pitcher: { id: 8, fullName: 'Gerrit C' }
      },
      teamStation: {
        version: 2,
        setupBefore: { players: { 7: setupPlayer } },
        actions: []
      }
    }
    const named = await new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, {
        plays: [{ id: 'evt_1', gameId: 'gam_1', gumbo: withSetup }],
        readerNames: { 7: 'Alex Lee' }
      }).fetch
    }).gameEvents('g')
    const held = named.plays[0] as unknown as typeof withSetup
    expect(held.teamStation.setupBefore.players[7]).deep.equals({
      ...setupPlayer,
      fullName: 'Alex Lee',
      nameFormat: 'full',
      compactName: 'Alex L'
    })
    expect(held.matchup.batter.fullName).equals('Alex L')
    const none = stubFetch(200, { plays: [] })
    const bare = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: none.fetch
    })
    expect(await bare.gameEvents('g')).deep.equals({
      plays: [],
      currentPlay: null
    })
    // The teams whose players' halves the read carries, when there are any.
    const managing = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, { plays: [], halves: ['tem_home'] }).fetch
    })
    expect((await managing.gameEvents('g')).halves).deep.equals(['tem_home'])
    const nobody = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, { plays: [], halves: [] }).fetch
    })
    expect(await nobody.gameEvents('g')).not.to.have.property('halves')
  })

  it('scores into a game live, naming TeamStation and only what changed', async function () {
    const { fetch, calls } = stubFetch(200, { plays: [], currentPlay: null })
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    await client.saveGameEvents('gam_1', { plays: [], remove: [3] })
    expect(calls[0].method).equals('POST')
    // Only what it wrote is asked for back.
    expect(calls[0].url).equals(
      'http://x/api/v1/games/gam_1/events?answer=edits'
    )
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

  it('keeps completed scoring ancestry off ordinary pitch uploads', async () => {
    const { fetch, calls } = stubFetch(200, { plays: [], currentPlay: null })
    const client = new TeamStationClient({ baseUrl: 'http://x/api/v1', fetch })
    const scoringHistory = Array.from({ length: 72 }, (_, index) =>
      asGumboPlay({
        about: { atBatIndex: index },
        result: { eventType: 'score_correction', awayScore: 0, homeScore: 0 }
      })
    )
    const change = { plays: [], remove: [], currentPlay: null, scoringHistory }
    await client.saveGameEvents('gam_1', change)
    expect(JSON.parse(calls[0].body!)).not.has.property('scoringHistory')
    expect(calls[0].body!.length).lessThan(200)
    expect(change.scoringHistory).length(72)
  })

  for (const code of ['conflict', 'idempotencyKeyReused'])
    it(`sends retained ancestry only after a definitive ${code}`, async () => {
      const calls: Call[] = []
      const fail = stubFetch(409, { code, message: 'Read history' }, calls)
      const ok = stubFetch(200, { plays: [], currentPlay: null }, calls)
      const client = new TeamStationClient({
        baseUrl: 'http://x/api/v1',
        fetch: (async (...args: Parameters<typeof fetch>) =>
          await (calls.length === 0 ? fail.fetch : ok.fetch)(
            ...args
          )) as typeof fetch
      })
      const scoringHistory = [
        asGumboPlay({
          about: { atBatIndex: 0 },
          result: { eventType: 'score_correction', awayScore: 0, homeScore: 0 }
        })
      ]
      await client.saveGameEvents('gam_1', {
        plays: [],
        remove: [],
        scoringHistory
      })
      expect(calls).length(2)
      expect(JSON.parse(calls[0].body!)).not.has.property('scoringHistory')
      expect(JSON.parse(calls[1].body!).scoringHistory).deep.equals(
        JSON.parse(JSON.stringify(scoringHistory))
      )
    })

  it('never retries retained scoring history as a newly signed-in user', async () => {
    const calls: Call[] = []
    const refused = stubFetch(
      409,
      { code: 'conflict', message: 'Stale lineups' },
      calls
    )
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      token: 'first-session',
      fetch: (async (...args: Parameters<typeof fetch>) => {
        const response = await refused.fetch(...args)
        client.token = 'second-session'
        return response
      }) as typeof fetch
    })
    try {
      await client.saveGameEvents('gam_1', {
        plays: [],
        remove: [],
        scoringHistory: []
      })
      expect.fail('The interrupted account must not retry')
    } catch (error) {
      expect(error).instanceOf(HttpError)
    }
    expect(calls).length(1)
    expect(calls[0].headers.authorization).equals('Bearer first-session')
  })

  for (const status of [401, 503, 409])
    it(`never repeatedly retries retained ancestry after status ${status}`, async () => {
      const { fetch, calls } = stubFetch(status, {
        code:
          status === 409
            ? 'conflict'
            : status === 401
              ? 'unauthorized'
              : 'unavailable',
        message: 'Refused'
      })
      const client = new TeamStationClient({
        baseUrl: 'http://x/api/v1',
        fetch
      })
      try {
        await client.saveGameEvents('gam_1', {
          plays: [],
          remove: [],
          scoringHistory: [
            asGumboPlay({
              about: { atBatIndex: 0 },
              result: {
                eventType: 'score_correction',
                awayScore: 0,
                homeScore: 0
              }
            })
          ]
        })
        expect.fail('The refusal must propagate')
      } catch (error) {
        expect(error).instanceOf(HttpError)
      }
      expect(calls).length(status === 409 ? 2 : 1)
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

  it('reads a save of either shape for its digests and generation (asPostedEdits)', async function () {
    const digests = {
      playsDigest: 'after',
      priorPlaysDigest: 'found',
      lineupsDigest: 'lineups',
      generation: 2
    }
    const play = {
      id: 'evt_1',
      gameId: 'gam_1',
      gumbo: { about: { atBatIndex: 0 } }
    }
    // A live post's edits (`?answer=edits`), and a whole game (no answer
    // asked for, or an older server), keep the same four fields.
    expect(
      asPostedEdits({
        edits: [
          { op: 'put', play },
          { op: 'remove', atBatIndex: 4 }
        ],
        currentPlay: null,
        ...digests
      })
    ).deep.equals(digests)
    expect(
      asPostedEdits({ plays: [play], currentPlay: null, ...digests })
    ).deep.equals(digests)
    // A mocked server's bare list, and the phone's own copy of a queued
    // post, carry none, or none that are not null.
    expect(asPostedEdits({ plays: [play], currentPlay: null })).deep.equals({})
    expect(
      asPostedEdits({
        plays: [],
        currentPlay: null,
        playsDigest: null,
        priorPlaysDigest: null,
        lineupsDigest: null,
        generation: null
      })
    ).deep.equals({})
    expect(asPostedEdits({ playsDigest: 'only' })).deep.equals({
      playsDigest: 'only'
    })
    for (const raw of [null, 'plays', 3, undefined])
      expect(() => asPostedEdits(raw), String(raw)).to.throw(TypeError)
    expect(() => asPostedEdits({ generation: 'two' })).to.throw(TypeError)

    // `saveGameEvents` answers what it reads of either.
    const edits = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, { edits: [], currentPlay: null, ...digests }).fetch
    })
    expect(
      await edits.saveGameEvents('gam_1', { plays: [], remove: [] })
    ).deep.equals(digests)
    const bare = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch: stubFetch(200, { plays: [play], currentPlay: null }).fetch
    })
    expect(
      await bare.saveGameEvents('gam_1', { plays: [], remove: [] })
    ).deep.equals({})
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

  it('keeps the token a code sign-in took when a claim it raced comes back after it', async function () {
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
    const calls: string[] = []
    let answerClaim: (() => void) | undefined
    const fetch = async (url: unknown): Promise<Response> => {
      const path = String(url).slice('http://x/api/v1'.length)
      calls.push(path)
      if (path === '/auth/email-code')
        return new Response(
          JSON.stringify({ sent: true, requestId: 'req_1', clientSecret: 's' }),
          { status: 202 }
        )
      if (path === '/auth/request/claim') {
        // The code approved the request, so the claim mints a session too;
        // its answer arrives after the code's.
        await new Promise<void>(resolve => {
          answerClaim = resolve
        })
        return new Response(JSON.stringify({ ...session, token: 'tok_claim' }))
      }
      return new Response(JSON.stringify(session))
    }
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch
    })
    const wait = await client.requestEmailCode('a@b.c')
    const claimed = client.claimSignIn(wait)
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(answerClaim).not.equals(undefined)
    await client.signInWithCode('a@b.c', '123456')
    expect(client.token).equals('tok_code')
    answerClaim?.()
    expect(await claimed).equals(undefined)
    // The phone's file was opened for this token, and it was kept.
    expect(client.token).equals('tok_code')
    // A poll after the sign-in asks nothing.
    expect(await client.claimSignIn(wait)).equals(undefined)
    expect(calls).deep.equals([
      '/auth/email-code',
      '/auth/request/claim',
      '/auth/email-code/verify'
    ])
  })

  it('claims a sign-in asked for while a token the server refused is still held', async function () {
    const session = {
      token: 'tok_claim',
      expiresAt: '2026-10-01T00:00:00.000Z',
      user: {
        id: userIdOfGumbo(1),
        gumboId: null,
        displayName: 'Robin Yount',
        isAdmin: false
      }
    }
    const fetch = async (url: unknown): Promise<Response> =>
      String(url).endsWith('/auth/email-code')
        ? new Response(
            JSON.stringify({
              sent: true,
              requestId: 'req_2',
              clientSecret: 's'
            }),
            { status: 202 }
          )
        : new Response(JSON.stringify(session))
    const client = new TeamStationClient({
      baseUrl: 'http://x/api/v1',
      fetch,
      token: 'tok_stale'
    })
    const wait = await client.requestEmailCode('a@b.c')
    expect((await client.claimSignIn(wait))?.token).equals('tok_claim')
    expect(client.token).equals('tok_claim')
    // Signed in by that claim: the next poll asks nothing.
    expect(await client.claimSignIn(wait)).equals(undefined)
    // A wait this client never asked for is claimed on the token it holds.
    expect(
      (await client.claimSignIn({ requestId: 'req_other', clientSecret: 's' }))
        ?.token
    ).equals('tok_claim')
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

describe('the ids and pictures a group’s tile is drawn from', function () {
  const league = 'https://images.example.test/league.png'
  it('keeps a live game’s team ids, and reads an older answer as none', function () {
    const live = {
      videoId: 'vid_demo',
      gameId: 'gam_demo',
      title: 'Demo Owls at Demo Hawks',
      homeTeamName: 'Demo Hawks',
      awayTeamName: 'Demo Owls',
      startedAt: null,
      gameStartAt: '2027-04-01T17:00:00.000Z'
    }
    expect(
      asLiveNow({ ...live, homeTeamId: 'tem_hawks', awayTeamId: 'tem_owls' })
    ).includes({ homeTeamId: 'tem_hawks', awayTeamId: 'tem_owls' })
    expect(asLiveNow(live)).includes({ homeTeamId: '', awayTeamId: '' })
  })

  it('keeps a season’s league picture, and reads an older answer as none', function () {
    const season = {
      id: 'sea_demo',
      leagueId: 'lea_demo',
      name: 'Demo Spring',
      year: 2027,
      term: null,
      ageGroup: null,
      teams: 2,
      games: 1,
      videos: 0
    }
    expect(
      asSeasonSummary({ ...season, leaguePictureUrl: league }).leaguePictureUrl
    ).equals(league)
    expect(asSeasonSummary(season).leaguePictureUrl).equals(null)
    const group = {
      id: 'sea_demo',
      kind: 'season',
      name: 'Demo Spring',
      imageUrl: null,
      locality: null,
      leagueId: 'lea_demo'
    }
    expect(
      asPublicGroup({ ...group, leaguePictureUrl: league }).leaguePictureUrl
    ).equals(league)
    expect(asPublicGroup(group).leaguePictureUrl).equals(null)
  })
})

describe('a timed request over XMLHttpRequest, as the phone sends one (1.harness-review.1)', function () {
  /**
   * The phone's request: after `at` ms the headers, then each piece of the
   * body `at` ms after the last; with `stallAfter`, nothing more after
   * that many, and with `never`, no answer at all.
   */
  function request(
    status: number,
    pieces: string[],
    at: number,
    options: {
      stallAfter?: number
      never?: boolean
      error?: boolean
      /** Pieces of the request body going up, `at` ms apart, first. */
      uploads?: number
    } = {}
  ): { make: () => TimedRequest; aborted: () => boolean; sent: string[] } {
    let aborted = false
    const sent: string[] = []
    const make = (): TimedRequest => {
      const xhr: TimedRequest = {
        readyState: 0,
        status: 0,
        responseText: '',
        withCredentials: false,
        onreadystatechange: null,
        onprogress: null,
        onload: null,
        onerror: null,
        ontimeout: null,
        onabort: null,
        upload: { onprogress: null },
        open: () => undefined,
        setRequestHeader: () => undefined,
        abort: () => {
          aborted = true
          xhr.onabort?.()
        },
        send: body => {
          sent.push(body ?? '')
          if (options.never === true) return
          const uploads = options.uploads ?? 0
          for (let piece = 1; piece <= uploads; piece++)
            setTimeout(() => {
              if (!aborted) xhr.upload?.onprogress?.()
            }, at * piece)
          const set = (patch: Partial<TimedRequest>): void => {
            Object.assign(xhr, patch)
          }
          setTimeout(
            () => {
              if (aborted) return
              if (options.error === true) {
                xhr.onerror?.()
                return
              }
              set({ readyState: 2, status })
              xhr.onreadystatechange?.()
              let text = ''
              pieces.forEach((piece, index) => {
                if (index >= (options.stallAfter ?? Infinity)) return
                setTimeout(
                  () => {
                    if (aborted) return
                    text += piece
                    set({ readyState: 3, responseText: text })
                    xhr.onprogress?.()
                    if (index === pieces.length - 1) {
                      set({ readyState: 4 })
                      xhr.onload?.()
                    }
                  },
                  at * (index + 1)
                )
              })
            },
            at * (uploads + 1)
          )
        }
      }
      return xhr
    }
    return { make, aborted: () => aborted, sent }
  }
  class Sender extends TeamStationClient {
    async send(
      method: string,
      path: string,
      body?: unknown,
      options?: RequestOptions
    ): Promise<unknown> {
      return await this.request(method, path, raw => raw, body, options)
    }
  }
  const unused = (async () => {
    throw new Error('fetch was used')
  }) as unknown as typeof fetch
  const sender = (
    make: () => TimedRequest,
    told: { missed: number; refused: number } = { missed: 0, refused: 0 }
  ): Sender => {
    const client = new Sender({
      baseUrl: 'http://x/api/v1',
      fetch: unused,
      timedRequest: make,
      requestDeadlineMs: 60,
      onDeadlineMissed: () => {
        told.missed++
      }
    })
    client.onSessionRefused = () => {
      told.refused++
    }
    return client
  }
  const failureOf = async (work: Promise<unknown>): Promise<unknown> =>
    await work.then(
      () => undefined,
      (error: unknown) => error
    )

  it('reads a long answer on a slow link to its end, though it takes far longer than the deadline', async function () {
    const json = JSON.stringify(Array.from({ length: 8 }, (_, i) => i))
    const slow = request(200, json.match(/.{1,3}/g)!, 30)
    const client = sender(slow.make)
    const started = Date.now()
    expect(await client.send('GET', '/games')).deep.equals(JSON.parse(json))
    expect(Date.now() - started).greaterThan(120)
    expect(client.offline).equals(false)
  })

  it('takes no answer by the deadline, or a body that stops arriving, as no signal, and lets go of the request', async function () {
    for (const slow of [
      request(200, ['[1]'], 10, { never: true }),
      request(200, ['[1,', '2]'], 20, { stallAfter: 1 })
    ]) {
      const told = { missed: 0, refused: 0 }
      const client = sender(slow.make, told)
      const failure = await failureOf(client.send('GET', '/games'))
      expect(failure).property('code', 'offline')
      expect(client.offline).equals(true)
      expect(told.missed).equals(1)
      expect(slow.aborted(), 'nothing more of it is fetched').equals(true)
    }
  })

  it('keeps a refusal whose body stalls the server’s, and tells a refused session', async function () {
    const refused = request(409, ['{"code":'], 10, { stallAfter: 1 })
    const failure = await failureOf(sender(refused.make).send('GET', '/games'))
    expect(failure).instanceOf(HttpError)
    expect(failure).not.property('code', 'offline')
    const told = { missed: 0, refused: 0 }
    const out = request(
      401,
      [JSON.stringify({ code: 'unauthorized', message: 'No' })],
      5
    )
    await failureOf(sender(out.make, told).send('GET', '/me/roles'))
    expect(told.refused).equals(1)
  })

  it('throws the caller’s own cancel as its own, and a request that never left as no signal', async function () {
    const held = request(200, ['[1]'], 50)
    const client = sender(held.make)
    const controller = new AbortController()
    const sent = client.send(
      'POST',
      '/games/g1/events',
      { a: 1 },
      {
        signal: controller.signal,
        deadline: true
      }
    )
    controller.abort()
    const failure = await failureOf(sent)
    expect((failure as Error).name).equals('AbortError')
    expect(client.offline).equals(false)
    expect(held.sent).deep.equals(['{"a":1}'])
    const lost = request(200, [], 5, { error: true })
    const offline = sender(lost.make)
    expect(await failureOf(offline.send('GET', '/games'))).property(
      'code',
      'offline'
    )
    expect(offline.offline).equals(true)
  })

  it('takes a write whose body is still going up as the link working, though the upload takes longer than the deadline (5.harness-review.1)', async function () {
    // Five pieces of the body going up, 30 ms apart, then the answer.
    const slow = request(200, ['{"ok":true}'], 30, { uploads: 5 })
    const client = sender(slow.make)
    const started = Date.now()
    expect(
      await client.send(
        'POST',
        '/games/g1/events',
        { plays: [] },
        { deadline: true }
      )
    ).deep.equals({ ok: true })
    expect(Date.now() - started).greaterThan(150)
    expect(client.offline).equals(false)
  })

  it('keeps a push registration call that misses its deadline, or never leaves, from changing offline, and still tells the missed deadline', async function () {
    const registration = {
      platform: 'ios',
      address: 'apns-1',
      environment: 'development',
      messages: true,
      rsvpEvents: false
    } as const
    // No answer by the deadline: the iPhone just back from its prompt.
    const told = { missed: 0, refused: 0 }
    const stalled = request(200, ['{"id":"psh_1"}'], 10, { never: true })
    const client = sender(stalled.make, told)
    expect(await failureOf(client.registerPush(registration))).property(
      'code',
      'offline'
    )
    expect(
      await failureOf(client.updatePush('psh_1', { messages: false }))
    ).property('code', 'offline')
    expect(await failureOf(client.unregisterPush('psh_1'))).property(
      'code',
      'offline'
    )
    expect(client.offline).equals(false)
    expect(told.missed).equals(3)
    // A request that never left the device, the same.
    const lost = sender(request(200, [], 5, { error: true }).make)
    expect(await failureOf(lost.registerPush(registration))).property(
      'code',
      'offline'
    )
    expect(lost.offline).equals(false)
    // The app's own read on that link is still offline.
    expect(await failureOf(lost.send('GET', '/games'))).property(
      'code',
      'offline'
    )
    expect(lost.offline).equals(true)
    // An answered push call leaves it so; the app's next answer clears it.
    const answered = sender(request(200, ['{"id":"psh_2"}'], 5).make)
    answered.offline = true
    expect(await answered.registerPush(registration)).equals('psh_2')
    expect(answered.offline).equals(true)
  })

  it('leaves a request with a body of bytes to fetch', async function () {
    let fetched = false
    const client = new Sender({
      baseUrl: 'http://x/api/v1',
      fetch: async () => {
        fetched = true
        return new Response('{}', { status: 200 })
      },
      timedRequest: () => {
        throw new Error('the timed request was used')
      }
    })
    await client.send('PUT', '/upload', new Uint8Array([1, 2]))
    expect(fetched).equals(true)
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

describe('a build the server is newer than', function () {
  it('names its protocol on every call, and is told when a save is refused as too old', async function () {
    const stub = stubFetch(503, {
      code: 'unavailable',
      message: 'Update TeamStation to keep scoring games.',
      details: { reason: 'updateRequired' }
    })
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: stub.fetch
    })
    let told = 0
    client.onUpdateRequired = () => {
      told++
    }
    let failure: unknown
    try {
      await client.teams()
    } catch (error) {
      failure = error
    }
    expect(stub.calls[0].headers[PROTOCOL_HEADER]).equals(
      String(GAME_SOCKET_PROTOCOL)
    )
    expect(isUpdateRequired(failure)).equals(true)
    expect(failure).property(
      'message',
      'Update TeamStation to keep scoring games.'
    )
    expect(told).equals(1)
    const other = stubFetch(403, { code: 'forbidden', message: 'Not found' })
    const plain = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: other.fetch
    })
    plain.onUpdateRequired = () => {
      told++
    }
    try {
      await plain.teams()
    } catch (error) {
      expect(isUpdateRequired(error)).equals(false)
    }
    expect(told).equals(1)
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

  it('adds an existing player by id to a roster or a game, and reads a notice or a pending request', async () => {
    const entry = mintedRosterEntry(
      {
        firstName: 'Mookie',
        lastName: 'Betts',
        jersey: '50',
        positions: ['RF'],
        bats: 'right',
        throws: 'right'
      },
      700002
    )
    const added = stubFetch(201, { ...entry, notice: { requestId: 'inv_one' } })
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: added.fetch
    })
    const answer = await client.addExistingRosterPlayer('tem 1', {
      userId: 'usr_a',
      jersey: '50',
      positions: ['RF']
    })
    expect('entry' in answer && answer.noticeId).equals('inv_one')
    expect(added.calls[0].url).equals('/api/v1/teams/tem%201/roster-players')
    expect(JSON.parse(added.calls[0].body!)).deep.equals({
      userId: 'usr_a',
      jersey: '50',
      positions: ['RF']
    })
    const plain = stubFetch(200, entry)
    const kept = await new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: plain.fetch
    }).addExistingRosterPlayer('t', {
      userId: 'usr_a',
      jersey: null,
      positions: []
    })
    expect('entry' in kept && kept.noticeId).equals(null)
    const asked = stubFetch(202, { pending: { requestId: 'inv_two' } })
    expect(
      await new TeamStationClient({
        baseUrl: '/api/v1',
        fetch: asked.fetch
      }).addExistingGuest(
        'game 1',
        'home',
        { userId: 'usr_a', jersey: null, positions: [] },
        'tem 1'
      )
    ).deep.equals({ pendingRequestId: 'inv_two' })
    expect(JSON.parse(asked.calls[0].body!)).deep.equals({
      side: 'home',
      teamId: 'tem 1',
      userId: 'usr_a',
      jersey: null,
      positions: []
    })
    const bare = stubFetch(202, { pending: { requestId: 'inv_three' } })
    await new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: bare.fetch
    }).addExistingGuest('g', 'away', {
      userId: 'usr_a',
      jersey: null,
      positions: []
    })
    expect(JSON.parse(bare.calls[0].body!).teamId).equals(undefined)
  })

  it('asks for roster candidates on the users collection, and a cancelled one is not offline', async () => {
    const row = {
      userId: 'usr_a',
      gumboId: 1,
      externalIds: [],
      // Read in full, with the public label beside it.
      shortName: 'Mookie Betts',
      nameFormat: 'full',
      compactName: 'M Betts',
      compactFormat: 'initialLast',
      shortParts: { first: 'Mookie', last: 'Betts' },
      avatarUrl: null,
      bats: 'right',
      throws: null,
      teams: [{ teamId: 'tem_owls', name: 'Ridgeview Owls' }],
      affiliations: 'Guardians: Bob M · Ridgeview Owls',
      tier: 'mine'
    }
    // An older server sends no affiliation line, which reads as none, and a
    // cursor, which is no longer read.
    const { affiliations: _line, ...older } = row
    expect(
      await new TeamStationClient({
        baseUrl: '/api/v1',
        fetch: stubFetch(200, [{ ...older, cursor: 'abc' }]).fetch
      }).rosterCandidates({ teamId: 't' })
    ).deep.equals([{ ...row, affiliations: '' }])
    const stub = stubFetch(200, [row])
    const client = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: stub.fetch
    })
    expect(
      await client.rosterCandidates({
        teamId: 'tem 1',
        gameId: 'gam 1',
        q: 'mo be',
        limit: 30,
        capped: true
      })
    ).deep.equals([row])
    expect(stub.calls[0].url).equals(
      '/api/v1/users?forTeam=tem+1&forGame=gam+1&q=mo+be&capped=1&limit=30'
    )
    await client.rosterCandidates({ teamId: 't', q: '' })
    expect(stub.calls[1].url).equals('/api/v1/users?forTeam=t')
    const wrong = stubFetch(200, [{ ...row, tier: 'nearby' }])
    let refused: unknown
    await new TeamStationClient({ baseUrl: '/api/v1', fetch: wrong.fetch })
      .rosterCandidates({ teamId: 't' })
      .catch((error: unknown) => {
        refused = error
      })
    expect(refused).not.equals(undefined)

    const controller = new AbortController()
    controller.abort()
    const aborting = new TeamStationClient({
      baseUrl: '/api/v1',
      fetch: async () => {
        throw new DOMException('Aborted', 'AbortError')
      }
    })
    let aborted: unknown
    await aborting
      .rosterCandidates({ teamId: 't', signal: controller.signal })
      .catch((error: unknown) => {
        aborted = error
      })
    expect((aborted as Error).name).equals('AbortError')
    expect(aborting.offline).equals(false)
  })
})

describe('account selection client', () => {
  const group = { kind: 'team' as const, id: 'tem_demo' }
  const person = { userId: userIdOfGumbo(401), displayName: 'Mookie B' }
  it('encodes group, query and repeated exclusions and cleans minimal account results', async () => {
    const stub = stubFetch(200, [person])
    const api = new TeamStationClient({ baseUrl: '/api/v1', fetch: stub.fetch })
    expect(
      await api.searchPeopleAccounts(group, 'Mookie &', [
        person.userId,
        userIdOfGumbo(402)
      ])
    ).deep.equals([
      {
        ...person,
        avatarUrl: null,
        affiliations: ''
      }
    ])
    const url = new URL(stub.calls[0].url, 'https://example.test')
    expect(url.pathname).equals('/api/v1/users')
    expect(url.searchParams.get('q')).equals('Mookie &')
    expect(url.searchParams.get('forGroupKind')).equals('team')
    expect(url.searchParams.get('forGroupId')).equals(group.id)
    expect(url.searchParams.getAll('exclude')).deep.equals([
      person.userId,
      userIdOfGumbo(402)
    ])
    await api.searchPeopleAccounts(group, '')
    expect(stub.calls[1].url).not.contains('exclude=')
  })
  it('adds an account without needing an email and preserves roles and retry identity', async () => {
    const stub = stubFetch(200, { added: true, person })
    const api = new TeamStationClient({ baseUrl: '/api/v1', fetch: stub.fetch })
    const options = {
      admin: false,
      flags: ['coach' as const],
      idempotencyKey: 'account-selection-client'
    }
    expect(
      await api.addPersonAccount(group, person.userId, options)
    ).deep.equals({
      added: true,
      person: { ...person, email: undefined },
      invited: undefined
    })
    expect(stub.calls[0].method).equals('POST')
    expect(stub.calls[0].url).equals('/api/v1/manage/team/tem_demo/people')
    expect(JSON.parse(stub.calls[0].body!)).deep.equals({
      userId: person.userId,
      ...options
    })
    await api.addPersonAccount(group, person.userId)
    expect(JSON.parse(stub.calls[1].body!)).deep.equals({
      userId: person.userId
    })
  })
})

describe('writes a screen does not wait for (U37, U44)', function () {
  /** A client that records each call's options and answers what it is told. */
  class Recording extends TeamStationClient {
    calls: Array<{ method: string; path: string; options?: RequestOptions }> =
      []

    answer: unknown = {}
    protected override async request<T>(
      method: string,
      path: string,
      cleaner: (raw: unknown) => T,
      _body?: unknown,
      options?: RequestOptions
    ): Promise<T> {
      this.calls.push({ method, path, options })
      return cleaner(this.answer)
    }
  }
  const save: SaveLineupsBody = {
    side: 'home',
    base: 'd0',
    players: [],
    battingOrder: [],
    defense: {}
  }
  const player = {
    firstName: 'Mookie',
    lastName: 'Betts',
    jersey: '50',
    positions: ['RF' as const],
    bats: 'right' as const,
    throws: 'right' as const
  }
  const entry = mintedRosterEntry(player, 700002)

  it('forwards background to the request of each listed write, and nothing without it', async () => {
    const client = new Recording({ baseUrl: '/api/v1' })
    const background = { background: true }
    client.answer = {
      away: {
        teamId: 'a',
        teamName: 'A',
        start: null,
        changes: [],
        current: null
      },
      home: {
        teamId: 'h',
        teamName: 'H',
        start: null,
        changes: [],
        current: null
      },
      digest: 'd1'
    }
    await client.saveLineups('g1', save, background)
    await client.saveLineups('g1', save)
    client.answer = { away: [], home: [] }
    await client.setRostered(
      'g1',
      { side: 'home', userId: 'usr_a', rostered: false },
      background
    )
    client.answer = entry
    await client.createRosterPlayer('t1', player, background)
    await client.createGuestPlayer('g1', 'home', player, 't1', background)
    await client.addExistingRosterPlayer(
      't1',
      { userId: 'usr_a', jersey: null, positions: [] },
      { background: true, deviceNames: { usr_a: 'Mookie B' } }
    )
    await client.addExistingGuest(
      'g1',
      'home',
      { userId: 'usr_a', jersey: null, positions: [] },
      undefined,
      background
    )
    await client.renameGuestPlayer(
      'g1',
      'usr_a',
      { firstName: 'Mookie', lastName: 'Betts' },
      12,
      background
    )
    await client.renameGuestPlayer('g1', 'usr_a', {
      firstName: 'Mookie',
      lastName: ''
    })
    expect(client.calls.map(call => call.options)).deep.equals([
      { background: true },
      undefined,
      { background: true },
      { background: true },
      { background: true },
      { background: true, deviceNames: { usr_a: 'Mookie B' } },
      { background: true },
      { background: true, deviceNames: { '12': 'Mookie Betts' } },
      undefined
    ])
  })

  it('reads changedAt on a lineup save as an ISO time, and refuses anything else', () => {
    expect(
      asSaveLineupsBody({ ...save, changedAt: '2026-11-06T12:00:00.000Z' })
        .changedAt
    ).equals('2026-11-06T12:00:00.000Z')
    expect('changedAt' in asSaveLineupsBody(save)).equals(false)
    expect(() => asSaveLineupsBody({ ...save, changedAt: 'yesterday' })).throws(
      TypeError
    )
  })
})

describe('chat recovery API compatibility', () => {
  it('keeps legacy epoch URLs and independently requests precise box delivery', async () => {
    const answer = {
      latest: 0,
      needsRotation: false,
      noHolder: false,
      epochs: [],
      boxes: []
    }
    const stub = stubFetch(200, answer)
    const client = new TeamStationClient({
      baseUrl: 'https://example.test/api/v1',
      fetch: stub.fetch
    })
    await client.chatEpochs('cnv_one', 2)
    await client.chatEpochs('cnv_one', 2, {
      boxesAfter: '9007199254740993',
      boxLimit: 1
    })
    await client.chatEpochs('cnv_one', 2, { boxesAfter: '0' })
    expect(stub.calls.map(call => call.url)).deep.equals([
      'https://example.test/api/v1/chat/conversations/cnv_one/epochs?after=2',
      'https://example.test/api/v1/chat/conversations/cnv_one/epochs?after=2&boxesAfter=9007199254740993&boxLimit=1',
      'https://example.test/api/v1/chat/conversations/cnv_one/epochs?after=2&boxesAfter=0&boxLimit=100'
    ])
  })
  it('uses scoped history queues with distinct typed responses', async () => {
    const stub = stubFetch(200, { requests: [], nextCursor: null })
    const client = new TeamStationClient({
      baseUrl: 'https://example.test/api/v1',
      fetch: stub.fetch
    })
    expect(await client.chatHistoryGrants()).deep.equals({
      requests: [],
      nextCursor: null
    })
    await client.chatHistoryGrants('7', 2)
    expect(stub.calls[1].url).equals(
      'https://example.test/api/v1/chat/grants?scope=history&cursor=7&limit=2'
    )
    const posted = stubFetch(200, {
      filled: 0,
      results: [{ requestId: '7', status: 'partial', coveredThroughEpoch: 1 }]
    })
    const writer = new TeamStationClient({
      baseUrl: 'https://example.test/api/v1',
      fetch: posted.fetch
    })
    expect((await writer.postChatHistoryGrants([])).results[0].status).equals(
      'partial'
    )
    expect(posted.calls[0].url).equals(
      'https://example.test/api/v1/chat/grants?scope=history'
    )
    expect(posted.calls[0].method).equals('POST')
    expect(JSON.parse(posted.calls[0].body!)).deep.equals({ boxes: [] })
  })
})

describe('TV login phone-link request', () => {
  for (const appOrigin of [undefined, 'https://develop.teamstation.app']) {
    it(`serializes the ${appOrigin == null ? 'server-selected' : 'build-selected'} phone origin`, async () => {
      const response = {
        requestId: 'fixture-request',
        clientSecret: 'fixture-secret',
        displayCode: 'ABCD–EFGH',
        qrUrl: 'https://develop.teamstation.app/tv-login?token=fixture',
        expiresAt: 123456789
      }
      const stub = stubFetch(200, response)
      const client = new TeamStationClient({
        baseUrl: 'https://api.example.test/api/v1',
        fetch: stub.fetch
      })
      expect(await client.startTvLogin('Apple TV', appOrigin)).deep.equals(
        response
      )
      expect(stub.calls).length(1)
      expect(stub.calls[0].url).equals(
        'https://api.example.test/api/v1/auth/tv/start'
      )
      expect(stub.calls[0].method).equals('POST')
      expect(JSON.parse(stub.calls[0].body!)).deep.equals({
        platform: 'Apple TV',
        ...(appOrigin == null ? {} : { appOrigin })
      })
    })
  }
})

describe('a person’s tile, coloured by their id alone', function () {
  const ripken = userIdOfGumbo(30)
  const minimalGameDetail = {
    id: 'gam_1',
    nonMemberView: false,
    awayTeamId: 'tem_owls',
    homeTeamId: 'tem_hawks',
    awayTeamName: 'Demo Owls',
    homeTeamName: 'Demo Hawks',
    seasonId: null,
    startAt: '2026-05-10T18:00:00Z',
    endAt: null,
    venue: null,
    status: 'final',
    homeScore: 3,
    awayScore: 2,
    videos: [],
    ingestStatus: 'none',
    ingestMessage: null,
    canScore: false,
    replayable: true
  }
  const minimalGroupDetail = {
    nonMemberView: false,
    group: {
      id: 'tem_hawks',
      kind: 'team',
      name: 'Demo Hawks',
      locality: null,
      imageUrl: null
    },
    parents: [],
    children: [],
    competingTeams: [],
    participatingSeasons: [],
    games: [],
    canManage: false
  }

  it('carries no public label on any person, even from a server that sends one', function () {
    const entry = mintedRosterEntry({
      firstName: 'Cal',
      lastName: 'Ripken',
      jersey: null,
      positions: [],
      bats: null,
      throws: null
    })
    const label = { publicName: 'C R' }
    expect(asRosterEntry({ ...entry, ...label })).not.have.property(
      'publicName'
    )
    const user = {
      id: 'usr_111111111111111111112k',
      displayName: 'Cal Ripken',
      isAdmin: false
    }
    expect(
      asSession({ token: 't', expiresAt: '', user: { ...user, ...label } }).user
    ).not.have.property('publicName')
    expect(
      asAccountSettings({
        user: { ...user, ...label, avatarUrl: null },
        hasPassword: false,
        emails: []
      }).user
    ).not.have.property('publicName')
    const stream = {
      id: 'liv_1',
      gameId: 'gam_1',
      userId: ripken,
      ownerName: 'Cal Ripken',
      slot: 1,
      label: 'Home',
      keyPrefix: 'ts_0000',
      state: 'idle',
      opensAt: '2026-05-20T16:00:00.000Z',
      closesAt: null,
      videoId: null,
      lastError: null,
      status: null
    }
    expect(asLiveStream(stream)).not.have.property('ownerPublicName')
    expect(
      asPlayerDetail({
        userId: ripken,
        name: 'Cal Ripken',
        teams: [],
        ...label
      })
    ).not.have.property('publicName')
    expect(
      asChatBlock({
        userId: ripken,
        shortName: 'Cal R',
        avatarUrl: null,
        userIds: [ripken],
        createdAt: '2027-01-01T00:00:00Z',
        ...label
      })
    ).not.have.property('publicName')
    expect(
      asNodeAccount({
        userId: ripken,
        displayName: 'Cal Ripken',
        email: null,
        isNodeAdmin: false,
        suspended: false,
        loginEnabled: true,
        canRemoveNodeRole: true,
        avatarUrl: null,
        ...label
      })
    ).not.have.property('publicName')
    const person = asGameDetail({
      ...minimalGameDetail,
      umpires: {
        positions: [
          {
            slot: 'type:1',
            typeId: 'type',
            typeName: 'Plate',
            ordinal: 1,
            required: true,
            person: { userId: ripken, name: 'Cal Ripken', ...label }
          }
        ]
      }
    }).umpires?.positions[0].person
    expect(person).not.have.property('publicName')
    expect(person).deep.include({ userId: ripken, name: 'Cal Ripken' })
  })

  it('keeps the umpire block’s league when it is sent, and cleans a stored game without it', function () {
    const block = {
      positions: [
        {
          slot: 'type:1',
          typeId: 'type',
          typeName: 'Plate',
          ordinal: 1,
          required: true,
          person: null
        }
      ]
    }
    expect(
      asGameDetail({
        ...minimalGameDetail,
        umpires: { ...block, leagueId: 'lea_1' }
      }).umpires?.leagueId
    ).equals('lea_1')
    const stored = asGameDetail({ ...minimalGameDetail, umpires: block })
    expect(stored.umpires?.leagueId).equals(undefined)
    expect(() =>
      asGameDetail({ ...minimalGameDetail, umpires: { ...block, leagueId: 7 } })
    ).throws()
  })

  it('gives public staff their id, which picks their colour, and none from an older server', function () {
    const detail = (staff: unknown[]): ReturnType<typeof asGroupDetail> =>
      asGroupDetail({ ...minimalGroupDetail, staff })
    const coach = { name: 'Cal R', roles: ['coach'] }
    expect(detail([coach]).staff[0]).deep.include({ userId: '' })
    const sent = detail([{ ...coach, userId: ripken, publicName: 'C R' }])
      .staff[0]
    expect(sent).deep.include({ userId: ripken })
    expect(sent).not.have.property('publicName')
  })
})

describe('the request deadline', function () {
  /** A client that sends any request, for the deadline's rules. */
  class Sender extends TeamStationClient {
    async send(
      method: string,
      path: string,
      body?: unknown,
      options?: RequestOptions
    ): Promise<unknown> {
      return await this.request(method, path, raw => raw, body, options)
    }
  }
  /**
   * A server that answers after `answerMs`, or never, and lets go of a
   * request the client aborts as `fetch` does.
   */
  const slow = (
    answerMs: number | null,
    seen: Array<{ method: string; signal: boolean }> = []
  ): typeof fetch =>
    (async (_url: unknown, init: RequestInit) => {
      seen.push({ method: String(init.method), signal: init.signal != null })
      if (init.signal?.aborted === true)
        throw new DOMException('Aborted', 'AbortError')
      return await new Promise<Response>((resolve, reject) => {
        init.signal?.addEventListener('abort', () => {
          reject(new DOMException('Aborted', 'AbortError'))
        })
        if (answerMs != null)
          setTimeout(() => {
            resolve(new Response(JSON.stringify({ ok: true })))
          }, answerMs)
      })
    }) as unknown as typeof fetch
  const client = (fetch: typeof globalThis.fetch, deadline = 20): Sender =>
    new Sender({
      baseUrl: 'http://x/api/v1',
      fetch,
      requestDeadlineMs: deadline
    })

  it('is ten seconds', async function () {
    const { REQUEST_DEADLINE_MS, UPLOAD_BODY_CHARS } = await import('./api')
    expect(REQUEST_DEADLINE_MS).equals(10_000)
    expect(UPLOAD_BODY_CHARS).equals(64 * 1024)
  })

  it('throws offline and sets offline when no answer begins by the deadline, and a later answer clears it', async function () {
    let answer: number | null = null
    const sender = client((async (url: unknown, init: RequestInit) => {
      const fetch = slow(answer)
      return await fetch(url as string, init)
    }) as unknown as typeof globalThis.fetch)
    const told: boolean[] = []
    sender.subscribeOffline(offline => told.push(offline))
    let failure: unknown
    try {
      await sender.myRoles()
    } catch (error) {
      failure = error
    }
    expect(failure).instanceOf(HttpError)
    expect(failure).property('code', 'offline')
    expect(sender.offline).equals(true)
    // An answer before the deadline is the server reached.
    answer = 5
    expect(await sender.send('GET', '/me/roles')).deep.equals({ ok: true })
    expect(sender.offline).equals(false)
    expect(told).deep.equals([true, false])
  })

  it('throws offline and sets offline when an answer begins and its body stalls past the deadline (3.harness-review.2)', async function () {
    const stalled =
      (status: number): typeof fetch =>
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              // The status and a first chunk, then nothing more.
              controller.enqueue(new TextEncoder().encode('{"ok":'))
            }
          }),
          { status }
        )
    const sender = client(stalled(200))
    let failure: unknown
    try {
      await sender.send('GET', '/games/g1/events')
    } catch (error) {
      failure = error
    }
    expect(failure).property('code', 'offline')
    expect(sender.offline).equals(true)
    // A refusal whose body stalls is still the server's.
    const refused = client(stalled(409))
    failure = undefined
    try {
      await refused.send('GET', '/games/g1/events')
    } catch (error) {
      failure = error
    }
    expect(failure).instanceOf(HttpError)
    expect(failure).not.property('code', 'offline')
    expect(refused.offline).equals(false)
  })

  it('throws the caller’s own cancel during the body as its own, never as no signal (1.harness-review.2)', async function () {
    const streaming = (async (_url: unknown, init: RequestInit) =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.enqueue(new TextEncoder().encode('{"ok":'))
            // The caller's cancel ends the body it is reading.
            init.signal?.addEventListener('abort', () => {
              controller.error(new DOMException('Aborted', 'AbortError'))
            })
          }
        }),
        { status: 200 }
      )) as unknown as typeof fetch
    const sender = client(streaming, 1000)
    const controller = new AbortController()
    const sent = sender.send('GET', '/games/g1/events', undefined, {
      signal: controller.signal
    })
    setTimeout(() => {
      controller.abort()
    }, 10)
    const failure = await sent.then(
      () => undefined,
      (error: unknown) => error
    )
    expect(failure).not.instanceOf(HttpError)
    expect((failure as Error).name).equals('AbortError')
    expect(sender.offline).equals(false)
  })

  it('tells onDeadlineMissed when no answer begins by the deadline, or a body stalls, and never for an answer in time', async function () {
    let missed = 0
    let answer: number | null = null
    const told = (fetch: typeof globalThis.fetch): Sender =>
      new Sender({
        baseUrl: 'http://x/api/v1',
        fetch,
        // Far longer than the 5 ms answer below, so a loaded runner keeps it.
        requestDeadlineMs: 200,
        onDeadlineMissed: () => {
          missed++
        }
      })
    const headers = told((async (url: unknown, init: RequestInit) => {
      const fetch = slow(answer)
      return await fetch(url as string, init)
    }) as unknown as typeof globalThis.fetch)
    await headers.send('GET', '/me/roles').catch(() => undefined)
    expect(missed).equals(1)
    answer = 5
    expect(await headers.send('GET', '/me/roles')).deep.equals({ ok: true })
    expect(missed).equals(1)
    const body = told(
      async () =>
        new Response(
          new ReadableStream({
            start(controller) {
              controller.enqueue(new TextEncoder().encode('{"ok":'))
            }
          })
        )
    )
    await body.send('GET', '/games/g1/events').catch(() => undefined)
    expect(missed).equals(2)
  })

  it('answers offline when the onDeadlineMissed listener throws', async function () {
    const sender = new Sender({
      baseUrl: 'http://x/api/v1',
      fetch: slow(null),
      requestDeadlineMs: 20,
      onDeadlineMissed: () => {
        throw new Error('the native module is gone')
      }
    })
    let failure: unknown
    try {
      await sender.send('GET', '/me/roles')
    } catch (error) {
      failure = error
    }
    expect(failure).property('code', 'offline')
  })

  it('reads a body that keeps arriving past the deadline to its end, and is not offline (4.harness-review.1)', async function () {
    const chunks = ['{"rows":[', '1,', '2,', '3', ']}']
    const trickle = (async () =>
      new Response(
        new ReadableStream({
          async start(controller) {
            // Each chunk well inside the deadline, all of them well past it.
            for (const chunk of chunks) {
              await new Promise(resolve => setTimeout(resolve, 12))
              controller.enqueue(new TextEncoder().encode(chunk))
            }
            controller.close()
          }
        })
      )) as unknown as typeof fetch
    const sender = client(trickle)
    expect(await sender.send('GET', '/games/g1/events')).deep.equals({
      rows: [1, 2, 3]
    })
    expect(sender.offline).equals(false)
  })

  it('gives a body the platform cannot stream a deadline that grows with its length (4.harness-review.1)', async function () {
    const { bodyOf, SLOWEST_BODY_BYTES_PER_SECOND } = await import('./api')
    const late = (length: number | null, ms: number): Response =>
      ({
        body: null,
        headers: new Headers(
          length == null ? {} : { 'content-length': String(length) }
        ),
        text: async () =>
          await new Promise<string>(resolve =>
            setTimeout(() => {
              resolve('{}')
            }, ms)
          )
      }) as unknown as Response
    // Short: the deadline alone.
    expect(
      await bodyOf(late(null, 40), 10).then(
        () => 'read',
        () => 'offline'
      )
    ).equals('offline')
    // Long: the deadline and the time its length takes at the slowest rate.
    const bytes = SLOWEST_BODY_BYTES_PER_SECOND / 10
    expect(await bodyOf(late(bytes, 40), 10)).equals('{}')
    expect(await bodyOf(late(null, 1), 10)).equals('{}')
  })

  it('reads a body as a whole where the runtime has no TextDecoder to stream it with', async function () {
    const { bodyOf } = await import('./api')
    let streamed = 0
    const response = {
      body: {
        getReader: () => {
          streamed++
          throw new Error('read as a stream')
        }
      },
      headers: new Headers(),
      text: async () => await Promise.resolve('{"ok":true}')
    } as unknown as Response
    const held = Object.getOwnPropertyDescriptor(globalThis, 'TextDecoder')
    Reflect.deleteProperty(globalThis, 'TextDecoder')
    try {
      expect(await bodyOf(response, 1000)).equals('{"ok":true}')
    } finally {
      if (held != null) Object.defineProperty(globalThis, 'TextDecoder', held)
    }
    expect(streamed).equals(0)
    // With one, the same body streams.
    await bodyOf(response, 1000).catch(() => undefined)
    expect(streamed).equals(1)
  })

  it('keeps a caller’s own cancel its own, never offline', async function () {
    const sender = client(slow(null))
    const controller = new AbortController()
    const asked = sender.send('GET', '/users?forTeam=t1', undefined, {
      signal: controller.signal
    })
    controller.abort()
    let failure: unknown
    try {
      await asked
    } catch (error) {
      failure = error
    }
    expect(failure).not.instanceOf(HttpError)
    expect(sender.offline).equals(false)
    // A signal already cancelled is cancelled at once, also its own.
    const done = new AbortController()
    done.abort()
    let again: unknown
    try {
      await sender.send('GET', '/me/roles', undefined, { signal: done.signal })
    } catch (error) {
      again = error
    }
    expect(again).not.instanceOf(HttpError)
    expect(sender.offline).equals(false)
  })

  it('gives an upload none: bytes, and JSON over 64 KiB', async function () {
    const seen: Array<{ method: string; signal: boolean }> = []
    const sender = client(slow(60, seen))
    expect(
      await sender.send(
        'PUT',
        '/chat/attachments/a/parts/0',
        new Uint8Array(4),
        {
          deadline: true
        }
      )
    ).deep.equals({ ok: true })
    const picture = { image: 'x'.repeat(64 * 1024 + 1) }
    expect(
      await sender.send('POST', '/me/picture', picture, { deadline: true })
    ).deep.equals({ ok: true })
    expect(sender.offline).equals(false)
    expect(seen.map(each => each.signal)).deep.equals([false, false])
  })

  it('gives a small write the queue sends the deadline', async function () {
    const sender = client(slow(null))
    let failure: unknown
    try {
      await sender.send(
        'POST',
        '/games/g1/events',
        { mode: 'live' },
        {
          deadline: true
        }
      )
    } catch (error) {
      failure = error
    }
    expect(failure).property('code', 'offline')
    expect(sender.offline).equals(true)
  })

  it('gives a write outside the queue none: a schedule preview answers after it, and is not offline', async function () {
    const sender = client(slow(60))
    expect(
      await sender.send('POST', '/leagues/l1/schedule-previews', { weeks: 1 })
    ).deep.equals({ ok: true })
    expect(sender.offline).equals(false)
  })

  it('reads a league umpire chat’s kind, and refuses a kind it does not know', function () {
    expect(asChatKind('leagueUmpires')).equals('leagueUmpires')
    expect(asChatKind('leagueOrg')).equals('leagueOrg')
    expect(() => asChatKind('leagueReferees')).throws()
  })
})

describe('the ingest refusals a camera row shows', function () {
  it('knows each refusal by how it begins, and nothing else', function () {
    for (const prefix of STREAM_REFUSAL_PREFIXES) {
      expect(isStreamRefusal(`${prefix} More.`), prefix).equals(true)
    }
    expect(isStreamRefusal('The stream ended')).equals(false)
    expect(
      isStreamRefusal('TeamStation takes HEVC. This stream is H.264.')
    ).equals(false)
    expect(isStreamRefusal(null)).equals(false)
    expect(isStreamRefusal(undefined)).equals(false)
  })
})
