import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { type Page, TeamStationClient } from '../../common/api'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import type { ActivityRow } from '../../common/userManagement'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { userAgents } from '../../test/userAgents'
import { recordCredentialUse, USER_API_KEY_PREFIX } from '../auth/sessions'
import { hashToken, makeToken } from '../auth/tokens'
import { USER_MANAGEMENT_LIMIT } from '../routes/nodeAdministration'

type ActivityPage = Page<ActivityRow> & { recordedSince?: string | null }
const NODE = 105
const base = Date.UTC(2030, 0, 1)

/** An API key of the node administrator's, which reads no person's activity. */
async function adminKey(f: GroupFixture): Promise<string> {
  const key = USER_API_KEY_PREFIX + makeToken()
  await f.h.db
    .insertInto('user_api_keys')
    .values({
      id: makeId('userApiKey'),
      user_id: userIdOfGumbo(105),
      name: 'export',
      token_hash: hashToken(key),
      secret_sealed: 'sealed',
      permissions: ['team:read'],
      created_at: new Date()
    })
    .execute()
  return key
}

describe('node activity: recent logins and sessions', function () {
  this.timeout(60000)
  let f: GroupFixture
  beforeEach(async () => {
    f = await groupFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })

  /** A sign-in at `at`, newer than every one the fixture made. */
  const login = async (
    user: number,
    at: Date | string,
    patch: { userAgent?: string; deviceName?: string } = {}
  ): Promise<string> => {
    const id = makeId('authSession')
    await f.h.db
      .insertInto('auth_sessions')
      .values({
        id,
        user_id: userIdOfGumbo(user),
        token_hash: hashToken(makeToken()),
        user_agent: patch.userAgent ?? userAgents.macChrome,
        device_name: patch.deviceName ?? null,
        created_at: sql`${typeof at === 'string' ? at : at.toISOString()}::timestamptz`,
        expires_at: new Date(base + 365 * 86400000)
      })
      .execute()
    return id
  }
  const read = async (
    path: string,
    user: number | string | null = NODE
  ): Promise<{ status: number; body: ActivityPage }> => {
    const response = await f.h.request('GET', path, undefined, user)
    return {
      status: response.status,
      body: (await response.json()) as ActivityPage
    }
  }
  const walk = async (list: string, limit?: number): Promise<string[][]> => {
    const pages: string[][] = []
    let cursor: string | null = null
    do {
      const query = new URLSearchParams()
      if (limit != null) query.set('limit', String(limit))
      if (cursor != null) query.set('cursor', cursor)
      const { status, body } = await read(`/node/${list}?${query.toString()}`)
      expect(status).equals(200)
      pages.push(body.items.map(row => row.id))
      cursor = body.nextCursor
    } while (cursor != null)
    return pages
  }

  it('pages every login, newest first, 50 at a time, repeats and ties included', async () => {
    const ours: string[] = []
    // 120 logins a minute apart, the newest first; one person signs in
    // three times, and two pairs share a time to the microsecond.
    for (let i = 0; i < 120; i++) {
      const at = new Date(base - Math.floor(i / 2) * 60_000)
      ours.push(await login(i < 3 ? 101 : 102 + (i % 4), at))
    }
    const pages = await walk('logins')
    expect(pages.slice(0, 2).map(page => page.length)).deep.equals([50, 50])
    const all = pages.flat()
    expect(new Set(all).size).equals(all.length)
    const total = await f.h.db
      .selectFrom('auth_sessions')
      .select(eb => eb.fn.countAll<string>().as('n'))
      .executeTakeFirstOrThrow()
    expect(all.length).equals(Number(total.n))
    // Ours are the newest, by time and then by id, as the server orders ids.
    const { rows } = await sql<{ id: string }>`
      select id from auth_sessions where id in (${sql.join(ours)})
      order by created_at desc, id collate "C" desc`.execute(f.h.db)
    expect(all.slice(0, 120)).deep.equals(rows.map(row => row.id))
    const first = (await read('/node/logins')).body.items
    expect(
      first.filter(row => row.userId === userIdOfGumbo(101))
    ).to.have.length(3)
    expect(first[0]).to.include({
      userId: userIdOfGumbo(101),
      device: 'Mac',
      appType: 'Web'
    })
    expect(first[0].at).equals(new Date(base).toISOString())
  })

  it('keeps rows a microsecond apart on either side of a page’s end', async () => {
    const newer = await login(101, '2030-01-01T00:00:00.123456Z')
    const older = await login(102, '2030-01-01T00:00:00.123200Z')
    const one = await read('/node/logins?limit=1')
    expect(one.body.items.map(row => row.id)).deep.equals([newer])
    const two = await read(
      `/node/logins?limit=1&cursor=${one.body.nextCursor!}`
    )
    expect(two.body.items.map(row => row.id)).deep.equals([older])
  })

  it('neither repeats nor skips a row when logins arrive between pages', async () => {
    for (let i = 0; i < 6; i++) await login(101, new Date(base - i * 60_000))
    const first = await read('/node/logins?limit=3')
    await login(102, new Date(base + 60_000))
    await login(103, new Date(base + 120_000))
    const second = await read(
      `/node/logins?limit=3&cursor=${first.body.nextCursor!}`
    )
    const times = [...first.body.items, ...second.body.items].map(row => row.at)
    expect(times).deep.equals(
      Array.from({ length: 6 }, (_, i) =>
        new Date(base - i * 60_000).toISOString()
      )
    )
  })

  it('shows the account’s latest use of anything, and its best address', async () => {
    const user = userIdOfGumbo(103)
    const phone = await login(103, new Date(base), {
      userAgent: userAgents.nativeAndroid,
      deviceName: 'Samsung SM-S911B'
    })
    await f.h.db
      .updateTable('auth_sessions')
      .set({ last_used_at: new Date(base + 60_000) })
      .where('id', '=', phone)
      .execute()
    await f.h.db
      .insertInto('api_tokens')
      .values({
        id: makeId('apiToken'),
        user_id: user,
        label: 'scoreboard',
        token_hash: hashToken(makeToken()),
        created_at: new Date(base),
        last_used_at: new Date(base + 120_000)
      })
      .execute()
    await f.h.db
      .insertInto('user_api_keys')
      .values({
        id: makeId('userApiKey'),
        user_id: user,
        name: 'export',
        token_hash: hashToken(makeToken()),
        secret_sealed: 'sealed',
        permissions: ['team:read'],
        created_at: new Date(base),
        last_used_at: new Date(base + 180_000)
      })
      .execute()
    // An unverified address is never shown over a verified primary.
    await f.h.db
      .insertInto('user_emails')
      .values({
        id: makeId('userEmail'),
        user_id: user,
        email: 'aaa-unverified@example.com',
        is_primary: false,
        verified_at: null,
        created_at: new Date(0)
      })
      .execute()
    const row = (await read('/node/logins?limit=1')).body.items[0]
    expect(row).to.include({
      id: phone,
      lastActiveAt: new Date(base + 180_000).toISOString(),
      email: 'fixture103@example.com',
      device: 'Samsung SM-S911B',
      appType: 'Android'
    })
  })

  it('lists device sessions newest first, and says since when', async () => {
    const tablet = await login(101, new Date(base))
    const laptop = await login(102, new Date(base))
    const use = async (
      session: string,
      user: number,
      ms: number
    ): Promise<void> => {
      await recordCredentialUse(
        f.h.db,
        {
          userId: userIdOfGumbo(user),
          isAdmin: false,
          sessionId: session,
          scopes: []
        },
        new Date(base + ms)
      )
    }
    await use(tablet, 101, 0)
    await use(laptop, 102, 10 * 60_000)
    await use(tablet, 101, 30 * 60_000)
    await use(tablet, 101, 150 * 60_000)
    const { body } = await read('/node/sessions')
    expect(body.items.slice(0, 3).map(row => [row.userId, row.at])).deep.equals(
      [
        [userIdOfGumbo(101), new Date(base + 150 * 60_000).toISOString()],
        [userIdOfGumbo(102), new Date(base + 10 * 60_000).toISOString()],
        [userIdOfGumbo(101), new Date(base).toISOString()]
      ]
    )
    expect(body.recordedSince).to.be.a('string')
    const pages = await walk('sessions', 2)
    expect(new Set(pages.flat()).size).equals(pages.flat().length)
    const later = await read(
      `/node/sessions?limit=1&cursor=${(await read('/node/sessions?limit=1')).body.nextCursor!}`
    )
    expect(later.body).not.to.have.property('recordedSince')
  })

  it('names the device model a native app signs in with', async () => {
    // The app on an iPhone: React Native's requests go out through CFNetwork.
    const phone = new TeamStationClient({
      baseUrl: f.h.origin + '/api/v1',
      deviceModel: 'iPhone',
      fetch: async (url, init) => {
        const headers = new Headers(init?.headers)
        headers.set('user-agent', userAgents.nativeApple)
        return await fetch(url, { ...init, headers })
      }
    })
    await phone.requestEmailCode('fixture104@example.com')
    const signedIn = await phone.signInWithCode(
      'fixture104@example.com',
      f.h.mail.get('fixture104@example.com')!
    )
    const row = (await read('/node/logins?limit=1')).body.items[0]
    expect(row).to.include({
      userId: signedIn.user.id,
      device: 'iPhone',
      appType: 'iOS'
    })
  })

  it('answers one address a minute’s worth of pages, then 429', async () => {
    const { limit } = USER_MANAGEMENT_LIMIT
    for (let i = 0; i < limit; i++)
      expect((await read('/node/logins?limit=1')).status).equals(200)
    const refused = await f.h.request('GET', '/node/sessions', undefined, NODE)
    expect(refused.status).equals(429)
    // Another view of `/users` is not User Management's, and still answers.
    expect(
      (await f.h.request('GET', '/users?view=administration', undefined, NODE))
        .status
    ).equals(200)
  })

  it('answers node administrators only, and refuses a query it does not take', async () => {
    const key = await adminKey(f)
    for (const list of ['logins', 'sessions']) {
      expect((await read(`/node/${list}`, 101)).status).equals(403)
      expect((await read(`/node/${list}`, null)).status).equals(401)
      expect((await read(`/node/${list}`, key)).status).equals(403)
      for (const query of [
        'limit=0',
        'limit=101',
        'limit=abc',
        'limit=1&limit=2',
        'cursor=forged',
        `cursor=${Buffer.from('2030-01-01T00:00:00.000000Z').toString('base64url')}`,
        'paged=1'
      ])
        expect((await read(`/node/${list}?${query}`)).status).equals(400)
    }
  })
})
