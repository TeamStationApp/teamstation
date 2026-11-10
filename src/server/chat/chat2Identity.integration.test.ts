import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { conversationIdentity } from '../../app/chat/chatIdentityModel'
import { ChatEngine } from '../../app/chat/engine/engine'
import type { ChatKeyStore } from '../../app/chat/keyRecord'
import {
  asChatConversation,
  type ChatConversation,
  TeamStationClient
} from '../../common/api'
import type { SpaceSettings } from '../media/spacesHls'
import { type ChatFixture, openChatFixture } from './chatTestFixture'
import { scopeIdentities, scopeKey, seasonTitle, titlesOf } from './titles'

const space: SpaceSettings = {
  endpoint: 'https://media.example.test',
  region: 'test',
  bucket: 'synthetic-images',
  accessKeyId: '00000000000000000000',
  secretAccessKey: '0000000000000000000000000000000000000000',
  pathStyle: true
}

function expectImage(url: string | null | undefined, prefix: string): void {
  expect(url).a('string')
  const parsed = new URL(url!)
  expect(parsed.hostname).equals('media.example.test')
  expect(parsed.pathname.endsWith(`/${prefix}-96.png`)).equals(true)
  expect(parsed.searchParams.has('X-Amz-Signature')).equals(true)
}

describe('chat identity metadata through authorized routes', function () {
  this.timeout(120000)
  let fixture: ChatFixture

  before(async function () {
    const opened = await openChatFixture('chat2_identity', { space })
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
    await fixture.db
      .updateTable('teams')
      .set({ logo_path: 'fixtures/team' })
      .where('id', '=', fixture.seed.teams.hawks)
      .execute()
    await fixture.db
      .updateTable('seasons')
      .set({ logo_path: 'fixtures/season' })
      .where('id', '=', fixture.seed.seasonId)
      .execute()
    await fixture.db
      .updateTable('leagues')
      .set({ logo_path: 'fixtures/league' })
      .where('id', '=', fixture.seed.leagueId)
      .execute()
    await fixture.db
      .updateTable('users')
      .set({ avatar_path: 'fixtures/person' })
      .where('id', 'in', [fixture.id('Ha'), fixture.id('Hs')])
      .execute()
  })

  after(async function () {
    await fixture?.close()
  })

  const list = async (who: string): Promise<ChatConversation[]> => {
    const answer = await fixture.call(who, 'GET', '/chat/conversations')
    expect(answer.status).equals(200)
    return (answer.body as unknown[]).map(asChatConversation)
  }

  it('batches and deduplicates only supplied scopes, with each scope own name, title name and logo', async function () {
    let queries = 0
    const traced = fixture.db.withPlugin({
      transformQuery(args) {
        queries += 1
        return args.node
      },
      async transformResult(args) {
        return args.result
      }
    })
    expect(await scopeIdentities(traced, [])).deep.equals(new Map())
    expect(queries).equals(0)
    const scopes = [
      { type: 'team' as const, id: fixture.seed.teams.hawks },
      { type: 'team' as const, id: fixture.seed.teams.hawks },
      { type: 'season' as const, id: fixture.seed.seasonId },
      { type: 'league' as const, id: fixture.seed.leagueId }
    ]
    const identities = await scopeIdentities(traced, scopes)
    expect(queries).equals(3)
    expect(identities.size).equals(3)
    for (const [index, prefix] of ['team', 'season', 'league'].entries()) {
      const scope = scopes[index === 0 ? 0 : index + 1]
      const identity = identities.get(scopeKey(scope.type, scope.id))!
      expect(identity.logoPath).equals(`fixtures/${prefix}`)
      expect(identity.name).not.equals('')
    }
    const team = identities.get(scopeKey('team', fixture.seed.teams.hawks))!
    const season = identities.get(scopeKey('season', fixture.seed.seasonId))!
    const league = identities.get(scopeKey('league', fixture.seed.leagueId))!
    expect(team.scopeName).equals(team.name)
    expect(team.leagueId).equals(null)
    expect(league.scopeName).equals(league.name)
    expect(league.leagueId).equals(null)
    // A season is titled with its league's name, read in the same query.
    expect(season.scopeName).equals(seasonTitle(season.name, league.name))
    expect(season.scopeName).not.equals(season.name)
    expect(season.leagueId).equals(fixture.seed.leagueId)
    expect(identities.has(scopeKey('team', fixture.seed.teams.eagles))).equals(
      false
    )

    // Titles are made from the same map, with no read of their own.
    queries = 0
    const titles = titlesOf(
      [
        {
          id: 'staff',
          kind: 'teamStaff',
          scopeType: 'team',
          scopeId: fixture.seed.teams.hawks
        },
        {
          id: 'news',
          kind: 'seasonAnnouncements',
          scopeType: 'season',
          scopeId: fixture.seed.seasonId
        },
        {
          id: 'org',
          kind: 'leagueOrg',
          scopeType: 'league',
          scopeId: fixture.seed.leagueId
        },
        {
          id: 'gone',
          kind: 'teamFans',
          scopeType: 'team',
          scopeId: 'tem_missing'
        },
        { id: 'dm', kind: 'dm', scopeType: null, scopeId: null }
      ],
      identities
    )
    expect(queries).equals(0)
    expect(Object.fromEntries(titles)).deep.equals({
      staff: `${team.scopeName} Staff`,
      news: `${season.scopeName} Announcements`,
      org: `${league.scopeName} Org`,
      gone: 'Chat Fans',
      dm: null
    })
    const absent = await scopeIdentities(traced, [
      scopes[0],
      { type: 'team', id: 'tem_missing' }
    ])
    expect(absent.has(scopeKey('team', fixture.seed.teams.hawks))).equals(true)
    expect(absent.has('team:tem_missing')).equals(false)
  })

  it('reads each scope table once for a list, its titles, scope names, pictures and season leagues', async function () {
    const executor = fixture.db.getExecutor()
    const execute = executor.executeQuery.bind(executor)
    let byId: string[] = []
    executor.executeQuery = async (query, queryId) => {
      // A read of the conversations' own scope rows, by their ids; the
      // role checks read child scopes by parent ("league_id" in …), which
      // is not this.
      const table =
        /\bfrom "(teams|seasons|leagues)"(?: .*)? where (?:"\1"\.)?"id" in /.exec(
          query.sql
        )
      if (table != null) byId.push(table[1])
      return await execute(query, queryId)
    }
    const suffix = / (Staff|All Staff|Members|Fans|Announcements|Org)$/
    try {
      const league = await list('L')
      expect(league.some(row => row.scope?.type === 'season')).equals(true)
      expect(league.some(row => row.scope?.type === 'league')).equals(true)
      expect(byId.filter(table => table === 'seasons').length).equals(1)
      expect(byId.filter(table => table === 'leagues').length).equals(1)
      expect(byId.filter(table => table === 'teams').length).equals(0)
      byId = []
      const team = await list('Hc')
      expect(team.some(row => row.scope?.type === 'team')).equals(true)
      expect(byId.filter(table => table === 'teams').length).equals(1)
      // Title and scope name come from the same read, so they agree.
      for (const row of [...league, ...team]) {
        if (row.scope == null) continue
        expect(row.title?.replace(suffix, '')).equals(row.scopeName)
      }
    } finally {
      executor.executeQuery = execute
    }
  })

  it('shares group metadata across its audience rows and exposes no inaccessible scopes or storage fields', async function () {
    const staff = await list('Hc')
    const teamRows = staff.filter(row => row.scope?.type === 'team')
    expect(teamRows.length).equals(3)
    expect(new Set(teamRows.map(row => row.avatarUrl)).size).equals(1)
    for (const row of teamRows) {
      expect(row.avatarName).equals(row.scopeName)
      expectImage(row.avatarUrl, 'fixtures/team')
      expect(row).not.has.property('avatarPath')
      expect(row.scope!.id).equals(fixture.seed.teams.hawks)
    }
    for (const row of await list('L')) {
      if (row.scope?.type === 'season') {
        const season = await fixture.db
          .selectFrom('seasons')
          .select('name')
          .where('id', '=', fixture.seed.seasonId)
          .executeTakeFirstOrThrow()
        expect(row.avatarName).equals(season.name)
        expectImage(row.avatarUrl, 'fixtures/season')
      } else if (row.scope?.type === 'league') {
        expectImage(row.avatarUrl, 'fixtures/league')
      }
    }
    expect(await list('Z')).deep.equals([])
    expect(
      (
        await fixture.call(
          'Z',
          'GET',
          `/chat/conversations/${teamRows[0].id}/members`
        )
      ).status
    ).equals(404)
  })

  it('returns current DM participant images on create/list and removes a departed profile image', async function () {
    const answer = await fixture.call('Hc', 'POST', '/chat/dms', {
      userIds: [fixture.id('Ha'), fixture.id('Hs')]
    })
    expect(answer.status).equals(201)
    const made = asChatConversation(answer.body)
    expect(made.avatarName).equals(null)
    expect(made.avatarUrl).equals(null)
    expect(made.people.length).equals(2)
    for (const person of made.people)
      expectImage(person.avatarUrl, 'fixtures/person')
    const relisted = (await list('Hc')).find(row => row.id === made.id)!
    expect(
      relisted.people.map(person => [
        person.userId,
        person.shortName,
        person.left
      ])
    ).deep.equals(
      made.people.map(person => [person.userId, person.shortName, person.left])
    )
    expect(
      (await fixture.call('Ha', 'DELETE', `/chat/dms/${made.id}/members/me`))
        .status
    ).equals(200)
    const people = (await list('Hc')).find(row => row.id === made.id)!.people
    expect(people.find(person => person.userId === fixture.id('Ha'))).includes({
      left: true,
      avatarUrl: null
    })
    const current = people.find(person => person.userId === fixture.id('Hs'))!
    expect(current.left).equals(false)
    expectImage(current.avatarUrl, 'fixtures/person')
  })

  it('carries server identities and blank zero-post previews into engine list items without activating or reading history', async function () {
    const calls: string[] = []
    const client = new TeamStationClient({
      baseUrl: fixture.api,
      token: fixture.tokenOf('Hc'),
      fetch: async (input, init) => {
        calls.push(
          typeof input === 'string'
            ? input
            : input instanceof URL
              ? input.href
              : input.url
        )
        return await fetch(input, init)
      }
    })
    const store: ChatKeyStore = {
      load: async () => undefined,
      save: async () => {},
      wipe: async () => {},
      exists: async () => false
    }
    const engine = new ChatEngine({
      client,
      store,
      userId: fixture.id('Hc'),
      device: { name: 'Synthetic browser', platform: 'web' }
    })
    try {
      const items = await engine.refresh()
      const group = items.find(item => item.scope?.type === 'team')!
      expect(group.avatarName).equals(group.scopeName)
      expectImage(group.avatarUrl, 'fixtures/team')
      expect(group.preview).equals('')
      const dm = items.find(item => item.kind === 'dm')!
      expect(conversationIdentity(dm).tiles.length).equals(1)
      expect(conversationIdentity(dm).tiles[0].key).equals(
        String(fixture.id('Hs'))
      )
      expect(
        calls.some(path => /\/(?:messages|read|epochs)(?:\?|$)/.test(path))
      ).equals(false)
    } finally {
      engine.stop()
    }
  })
})
