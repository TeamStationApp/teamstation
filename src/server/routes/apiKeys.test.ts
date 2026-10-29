import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'
import { Pool } from 'pg'

import { asApiKey, asApiKeys, MAX_API_KEYS } from '../../common/apiKeys'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import {
  actorForToken,
  createSession,
  keyAllows,
  signOutEverywhere
} from '../auth/sessions'
import { hashToken, makeToken } from '../auth/tokens'
import { openSecret } from '../live/secrets'
import { TESS_HEADER } from '../middleware/withAuth'
import { apiKeyRoutes } from './apiKeys'

/**
 * `/me/api-keys`: the API keys a person makes under Account, and how a key
 * signs in. Run against a scratch database with the account routes mounted,
 * so a key's bearer can be tried against `GET /me/account`.
 */
const SECRET = 'api-key-test-session-secret'

describe('user API keys', function () {
  this.timeout(60000)

  let h: AccountHarness | undefined
  let machineToken = ''
  const person = userIdOfGumbo(101)

  before(async function () {
    const admin = new Pool({ connectionString: testDatabaseUrl })
    try {
      await admin.query('select 1')
    } catch {
      this.skip()
      return
    } finally {
      await admin.end()
    }
    let secret = SECRET
    h = await accountHarness(undefined, undefined, undefined, (app, { db }) => {
      app.use('/api/v1', (req, res, next) => {
        // Lets one case take the server secret away.
        if (req.header('x-test-no-secret') != null) secret = ''
        else secret = SECRET
        next()
      })
      app.use(
        '/api/v1',
        apiKeyRoutes(db, {
          get sessionSecret() {
            return secret
          }
        })
      )
    })
    machineToken = makeToken()
    await h.db
      .insertInto('api_tokens')
      .values({
        id: makeId('apiToken'),
        user_id: person,
        label: 'Distributor',
        token_hash: hashToken(machineToken)
      })
      .execute()
  })

  after(async function () {
    await h?.close()
  })

  beforeEach(async function () {
    if (h == null) return
    await h.resetLimits()
    await h.db
      .updateTable('user_api_keys')
      .set({ revoked_at: new Date() })
      .where('revoked_at', 'is', null)
      .execute()
  })

  const harness = (): AccountHarness => {
    if (h == null) throw new Error('No harness')
    return h
  }

  const create = async (
    body: unknown,
    user: number | string = 101
  ): Promise<Response> =>
    await harness().request('POST', '/me/api-keys', body, user)

  it('creates a key, lists it oldest first, and keeps only its hash and seal', async function () {
    const first = await create({
      name: '  Agent  ',
      permissions: ['schedule:write']
    })
    expect(first.status).equals(201)
    const key = asApiKey(await first.json())
    expect(key.name).equals('Agent')
    expect(key.secret).to.match(/^tsk_[A-Za-z0-9_-]{43}$/)
    expect(key.permissions).deep.equals(['schedule:read', 'schedule:write'])
    const second = asApiKey(
      await (await create({ name: 'Agent', permissions: ['team:read'] })).json()
    )

    const listed = asApiKeys(
      await (await harness().request('GET', '/me/api-keys')).json()
    )
    expect(listed.keys.map(each => each.id)).deep.equals([key.id, second.id])
    expect(listed.keys[0].secret).equals(key.secret)

    const row = await harness()
      .db.selectFrom('user_api_keys')
      .selectAll()
      .where('id', '=', key.id)
      .executeTakeFirstOrThrow()
    expect(row.token_hash).equals(hashToken(key.secret ?? ''))
    expect(row.secret_sealed).not.include(key.secret ?? '')
    expect(openSecret(SECRET, row.secret_sealed)).equals(key.secret)
    expect(() => openSecret('another secret', row.secret_sealed)).to.throw()
  })

  it('signs in with the key as the person, within its permissions', async function () {
    const key = asApiKey(
      await (
        await create({ name: 'Reader', permissions: ['account:read'] })
      ).json()
    )
    const actor = await actorForToken(harness().db, key.secret ?? '')
    expect(actor?.userId).equals(person)
    expect(actor?.apiKey?.id).equals(key.id)
    expect(keyAllows(actor, 'account:read')).equals(true)
    expect(keyAllows(actor, 'account:write')).equals(false)
    expect(keyAllows(undefined, 'account:write')).equals(true)
    const used = await harness()
      .db.selectFrom('user_api_keys')
      .select('last_used_at')
      .where('id', '=', key.id)
      .executeTakeFirstOrThrow()
    expect(used.last_used_at).not.equals(null)
    expect(await actorForToken(harness().db, 'tsk_unknown')).equals(undefined)
    // Used again within the minute: the time stays as it was.
    await actorForToken(harness().db, key.secret ?? '')
    const again = await harness()
      .db.selectFrom('user_api_keys')
      .select('last_used_at')
      .where('id', '=', key.id)
      .executeTakeFirstOrThrow()
    expect(again.last_used_at).deep.equals(used.last_used_at)
    // A session token that happens to begin like a key is still a session.
    const lookalike = 'tsk_a session token, not a key'
    await harness()
      .db.insertInto('auth_sessions')
      .values({
        id: makeId('authSession'),
        user_id: person,
        token_hash: hashToken(lookalike),
        expires_at: new Date(Date.now() + 3_600_000)
      })
      .execute()
    const session = await actorForToken(harness().db, lookalike)
    expect(session?.userId).equals(person)
    expect(session?.apiKey).equals(undefined)
    // A session's use is written once a minute too.
    const usedAt = async (): Promise<unknown> =>
      (
        await harness()
          .db.selectFrom('auth_sessions')
          .select('last_used_at')
          .where('token_hash', '=', hashToken(lookalike))
          .executeTakeFirstOrThrow()
      ).last_used_at
    const first = await usedAt()
    expect(first).not.equals(null)
    await actorForToken(harness().db, lookalike)
    expect(await usedAt()).deep.equals(first)
  })

  it('refuses a blank name, a long name, no permission and an unknown one', async function () {
    for (const body of [
      { name: '   ', permissions: ['team:read'] },
      { name: 'x'.repeat(81), permissions: ['team:read'] },
      { name: 'Agent', permissions: [] },
      { name: 'Agent', permissions: ['videos:read'] },
      { name: 'Agent' }
    ])
      expect((await create(body)).status, JSON.stringify(body)).equals(400)
    expect(
      (await create({ name: 'x'.repeat(80), permissions: ['team:read'] }))
        .status
    ).equals(201)
  })

  it('holds at most twenty keys an account', async function () {
    for (let i = 0; i < MAX_API_KEYS; i++) {
      await harness().resetLimits()
      expect(
        (await create({ name: `Key ${i}`, permissions: ['team:read'] })).status
      ).equals(201)
    }
    const over = await create({ name: 'One more', permissions: ['team:read'] })
    expect(over.status).equals(409)
  })

  it('makes at most ten keys in fifteen minutes', async function () {
    for (let i = 0; i < 10; i++)
      expect(
        (await create({ name: `Key ${i}`, permissions: ['team:read'] })).status
      ).equals(201)
    expect(
      (await create({ name: 'Eleventh', permissions: ['team:read'] })).status
    ).equals(429)
  })

  it('makes no key while the server has no secret to seal it with', async function () {
    const response = await fetch(`${harness().origin}/api/v1/me/api-keys`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${harness().tokens.get(101) ?? ''}`,
        'content-type': 'application/json',
        'x-test-no-secret': '1'
      },
      body: JSON.stringify({ name: 'Agent', permissions: ['team:read'] })
    })
    expect(response.status).equals(503)
  })

  it('revokes a key, after which its bearer is refused', async function () {
    const key = asApiKey(
      await (
        await create({ name: 'Short lived', permissions: ['account:read'] })
      ).json()
    )
    const secret = key.secret ?? ''
    expect(
      (await harness().request('GET', '/me/account', undefined, secret)).status
    ).equals(200)
    expect(
      (await harness().request('DELETE', `/me/api-keys/${key.id}`)).status
    ).equals(204)
    expect(
      (await harness().request('GET', '/me/account', undefined, secret)).status
    ).equals(401)
    expect(
      (await harness().request('DELETE', `/me/api-keys/${key.id}`)).status
    ).equals(404)
    const listed = asApiKeys(
      await (await harness().request('GET', '/me/api-keys')).json()
    )
    expect(listed.keys).deep.equals([])
  })

  it("cannot see or revoke another account's key", async function () {
    const key = asApiKey(
      await (await create({ name: 'Mine', permissions: ['team:read'] })).json()
    )
    expect(
      (
        await harness().request(
          'DELETE',
          `/me/api-keys/${key.id}`,
          undefined,
          102
        )
      ).status
    ).equals(404)
    const theirs = asApiKeys(
      await (
        await harness().request('GET', '/me/api-keys', undefined, 102)
      ).json()
    )
    expect(theirs.keys).deep.equals([])
  })

  it('tells no cache to keep a secret', async function () {
    const made = await create({ name: 'Agent', permissions: ['team:read'] })
    expect(made.headers.get('cache-control')).equals('no-store')
    const listed = await harness().request('GET', '/me/api-keys')
    expect(listed.headers.get('cache-control')).equals('no-store')
  })

  it('answers only a signed-in person: not a machine token, a key or Tess', async function () {
    const key = asApiKey(
      await (
        await create({ name: 'Agent', permissions: ['account:write'] })
      ).json()
    )
    const session = harness().tokens.get(101) ?? ''
    const calls: Array<[string, string, unknown]> = [
      ['GET', '/me/api-keys', undefined],
      ['POST', '/me/api-keys', { name: 'More', permissions: ['team:read'] }],
      ['DELETE', `/me/api-keys/${key.id}`, undefined]
    ]
    for (const [method, route, body] of calls) {
      for (const token of [machineToken, key.secret ?? ''])
        expect(
          (await harness().request(method, route, body, token)).status,
          `${method} ${route}`
        ).equals(403)
      const viaTess = await fetch(`${harness().origin}/api/v1${route}`, {
        method,
        headers: {
          authorization: `Bearer ${session}`,
          [TESS_HEADER]: '1',
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      expect(viaTess.status, `Tess ${method} ${route}`).equals(403)
    }
    expect(
      (await harness().request('GET', '/me/api-keys', undefined, null)).status
    ).equals(401)
  })

  it('names the key, never its secret, in the audit of a write made with it', async function () {
    const key = asApiKey(
      await (
        await create({ name: 'Writer', permissions: ['account:write'] })
      ).json()
    )
    const renamed = await harness().request(
      'PUT',
      '/me/account/name',
      { displayName: 'Babe Ruth' },
      key.secret
    )
    expect(renamed.status).equals(200)
    // The audit row is written after the answer.
    let row:
      | { user_api_key_id: string | null; after: unknown; before: unknown }
      | undefined
    for (let i = 0; i < 50 && row == null; i++) {
      row = await harness()
        .db.selectFrom('audit_log')
        .select(['user_api_key_id', 'after', 'before'])
        .where('path', '=', '/api/v1/me/account/name')
        .where('user_api_key_id', '=', key.id)
        .executeTakeFirst()
      if (row == null) await new Promise(resolve => setTimeout(resolve, 20))
    }
    expect(row?.user_api_key_id).equals(key.id)
    expect(JSON.stringify(row)).not.include(key.secret ?? '')
  })

  it('stops every key when the account is signed out everywhere', async function () {
    const key = asApiKey(
      await (
        await create({ name: 'Everywhere', permissions: ['team:read'] })
      ).json()
    )
    const extra = await createSession(harness().db, person, 'test')
    const signedOut = await signOutEverywhere(harness().db, person)
    expect(signedOut.apiKeys).equals(1)
    expect(await actorForToken(harness().db, key.secret ?? '')).equals(
      undefined
    )
    expect(await actorForToken(harness().db, extra.token)).equals(undefined)
    expect(await signOutEverywhere(harness().db, [])).deep.equals({
      sessions: 0,
      apiTokens: 0,
      apiKeys: 0,
      oauthGrants: 0
    })
    // Sign the fixture person back in for the cases after this one.
    harness().tokens.set(
      101,
      (await createSession(harness().db, person, 'test')).token
    )
  })

  it('refuses a key whose account is disabled or merged', async function () {
    const key = asApiKey(
      await (
        await create({ name: 'Closed', permissions: ['team:read'] })
      ).json()
    )
    const db = harness().db
    await db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', person)
      .execute()
    try {
      expect(await actorForToken(db, key.secret ?? '')).equals(undefined)
    } finally {
      await db
        .updateTable('users')
        .set({ disabled_at: null })
        .where('id', '=', person)
        .execute()
    }
    expect((await actorForToken(db, key.secret ?? ''))?.userId).equals(person)
  })
})
