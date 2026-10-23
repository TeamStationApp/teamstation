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
import { scopeAvatars } from './avatars'
import {
  type ChatFixture,
  openChatFixture,
  TEST_MEDIA
} from './chatTestFixture'
import { scopeNames } from './titles'

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

  it('batches and deduplicates only supplied scopes, with each scene own image and name', async function () {
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
    expect(await scopeAvatars(traced, space, [])).deep.equals(new Map())
    expect(queries).equals(0)
    const scopes = [
      { type: 'team' as const, id: fixture.seed.teams.hawks },
      { type: 'team' as const, id: fixture.seed.teams.hawks },
      { type: 'season' as const, id: fixture.seed.seasonId },
      { type: 'league' as const, id: fixture.seed.leagueId }
    ]
    const avatars = await scopeAvatars(traced, space, scopes)
    expect(queries).equals(3)
    expect(avatars.size).equals(3)
    for (const [index, prefix] of ['team', 'season', 'league'].entries()) {
      const scope = scopes[index === 0 ? 0 : index + 1]
      const avatar = avatars.get(`${scope.type}:${scope.id}`)!
      expectImage(avatar.url, `fixtures/${prefix}`)
      expect(avatar.name).not.equals('')
    }
    // The names its chats are titled by come from the same rows.
    const names = await scopeNames(fixture.db, scopes)
    expect(names.size).equals(3)
    for (const [key, name] of names)
      expect(avatars.get(key)?.scopeName).equals(name)
    expect(
      avatars.get(`season:${fixture.seed.seasonId}`)!.scopeName
    ).not.equals(avatars.get(`season:${fixture.seed.seasonId}`)!.name)
    expect(avatars.has(`team:${fixture.seed.teams.eagles}`)).equals(false)
    const absent = await scopeAvatars(traced, TEST_MEDIA.space, [
      scopes[0],
      { type: 'team', id: 'tem_missing' }
    ])
    expect(absent.get(`team:${fixture.seed.teams.hawks}`)?.url).equals(null)
    expect(absent.has('team:tem_missing')).equals(false)
  })

  it('reads a scope row once for its chat names and picture, beside its titles', async function () {
    const executor = fixture.db.getExecutor()
    const execute = executor.executeQuery.bind(executor)
    const named: string[] = []
    executor.executeQuery = async (query, queryId) => {
      const table = /^select .*"name".* from "(teams|seasons|leagues)"/.exec(
        query.sql
      )
      if (table != null) named.push(table[1])
      return await execute(query, queryId)
    }
    try {
      const rows = await list('L')
      expect(rows.some(row => row.scope?.type === 'season')).equals(true)
      expect(rows.some(row => row.scope?.type === 'league')).equals(true)
    } finally {
      executor.executeQuery = execute
    }
    // The titles read the names once; the names and pictures once more.
    expect(named.filter(table => table === 'seasons').length).equals(2)
    expect(named.filter(table => table === 'leagues').length).equals(2)
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
