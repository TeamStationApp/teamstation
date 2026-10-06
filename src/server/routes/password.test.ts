import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { asArgonParameters } from '../../common/passwordProtocol'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import {
  signInTestAccount,
  testPasswordCosts,
  testPasswordKdf,
  testPasswordParameters
} from '../../test/passwordFixtures'
import { createEmailCode } from '../auth/emailCodes'
import {
  createPasswordRecord,
  nativeArgon,
  readPasswordRecord
} from '../auth/passwords'

const legacy = '$2b$11$legacy-fixture-not-a-live-password'
const proof = 'ab'.repeat(32)
const body = (): {
  clientHash: string
  clientParameters: typeof testPasswordParameters
} => ({
  clientHash: proof,
  clientParameters: testPasswordParameters
})
describe('password hashing and email-reset HTTP protocol', function () {
  this.timeout(60000)
  let h: AccountHarness
  before(async () => {
    h = await accountHarness()
  })
  after(async () => {
    await h?.close()
  })
  beforeEach(async () => {
    await h.resetLimits()
    h.controls.failMail = false
    await h.db
      .updateTable('users')
      .set({ password_hash: legacy, login_enabled: true, merged_into: null })
      .where('id', '=', 101)
      .execute()
  })
  const reset = async (): Promise<{
    requestId: string
    email: string
    code: string
  }> => {
    const response = await h.request('POST', '/me/account/password/reset', {})
    expect(response.status).equals(202)
    return {
      ...((await response.json()) as { requestId: string; email: string }),
      code: h.mail.get('alex@example.com')!
    }
  }
  const stored = async (): Promise<string | null> =>
    (
      await h.db
        .selectFrom('users')
        .select('password_hash')
        .where('id', '=', 101)
        .executeTakeFirstOrThrow()
    ).password_hash
  const update = async (reset?: {
    requestId: string
    code: string
  }): Promise<Response> =>
    await h.request('PUT', '/me/account/password', { ...body(), reset })
  const waitForPasswordAttempt = async (): Promise<void> => {
    for (let attempt = 0; attempt < 200; attempt++) {
      const charged = await h.db
        .selectFrom('rate_events')
        .select('at')
        .where('scope', '=', 'account.password')
        .where('key', '=', '101')
        .executeTakeFirst()
      if (charged != null) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error('Password authorization did not start')
  }
  it('releases database locks during password hashing and rejects a superseded credential', async () => {
    await h.db
      .updateTable('users')
      .set({ password_hash: null })
      .where('id', '=', 101)
      .execute()
    let finished = false
    const pending = h
      .request('PUT', '/me/account/password', {
        ...body(),
        clientParameters: { ...testPasswordParameters, iterations: 128 }
      })
      .then(response => {
        finished = true
        return response
      })
    try {
      await waitForPasswordAttempt()
      const others = await Promise.all([
        ...Array.from(
          { length: 9 },
          async () =>
            await h.request('PUT', '/me/account/name', { displayName: 'Demo' })
        ),
        h.request('GET', '/me/account', undefined, 102)
      ])
      expect(others.map(r => r.status)).deep.equals(Array(10).fill(200))
      expect(
        finished,
        'unrelated requests must finish before the expensive hash'
      ).equals(false)
      await h.db
        .updateTable('users')
        .set({ password_hash: legacy })
        .where('id', '=', 101)
        .execute()
      expect((await pending).status).equals(400)
      expect(await stored()).equals(legacy)
    } finally {
      await pending
    }
  })
  it('revalidates reset expiry after hashing without consuming an invalid authorization', async () => {
    const resetAuth = await reset()
    const pending = h.request('PUT', '/me/account/password', {
      ...body(),
      reset: resetAuth,
      clientParameters: { ...testPasswordParameters, iterations: 128 }
    })
    try {
      await waitForPasswordAttempt()
      await h.db
        .updateTable('email_codes')
        .set({ expires_at: new Date(0) })
        .where('id', '=', resetAuth.requestId)
        .execute()
      expect((await pending).status).equals(400)
      expect(await stored()).equals(legacy)
      const code = await h.db
        .selectFrom('email_codes')
        .select('consumed_at')
        .where('id', '=', resetAuth.requestId)
        .executeTakeFirstOrThrow()
      expect(code.consumed_at).equals(null)
    } finally {
      await pending
    }
  })
  it('authenticates old saved costs and requires the new floor only when replacing them', async () => {
    const old = {
      ...testPasswordParameters,
      memoryKiB: 65536,
      iterations: 16,
      parallelism: 1
    }
    const server = { ...old, iterations: 64, salt: 'ff'.repeat(16) }
    const oldSecret = 'old lowercase password'
    const clientHash = await testPasswordKdf(oldSecret, old)
    const storedOld = JSON.stringify({
      schema: 1,
      client: old,
      server,
      hash: await nativeArgon(Buffer.from(clientHash, 'hex'), server)
    })
    await h.db
      .updateTable('users')
      .set({ password_hash: storedOld })
      .where('id', '=', 101)
      .execute()
    const client = new TeamStationClient({
      baseUrl: h.origin + '/api/v1',
      token: h.tokens.get(101),
      passwordKdf: testPasswordKdf,
      passwordTargetMs: 1
    })
    expect(
      (await client.signInWithPassword('alex@example.com', oldSecret)).user.id
    ).equals(101)
    for (const patch of [
      { memoryKiB: 19456 },
      { iterations: 5 },
      { parallelism: 1 },
      { iterations: 1025 }
    ]) {
      const response = await h.request('PUT', '/me/account/password', {
        clientHash: proof,
        currentClientHash: clientHash,
        clientParameters: { ...testPasswordParameters, ...patch }
      })
      expect(response.status).equals(400)
      expect(await stored()).equals(storedOld)
    }
    await client.setAccountPassword(
      'new lowercase passphrase',
      oldSecret,
      undefined,
      Promise.resolve(testPasswordCosts)
    )
    expect(readPasswordRecord(await stored())!.client).includes(
      testPasswordCosts
    )
    expect(
      (
        await client.signInWithPassword(
          'alex@example.com',
          'new lowercase passphrase'
        )
      ).user.id
    ).equals(101)
  })
  it('requires a fresh email code for legacy upgrade, stores parameters and refuses plaintext', async () => {
    expect((await update()).status).equals(400)
    expect(
      (
        await h.request(
          'POST',
          '/auth/password',
          { email: 'alex@example.com', password: 'raw' },
          null
        )
      ).status
    ).equals(400)
    const pending = await reset()
    expect((await update({ ...pending, code: 'incorrect' })).status).equals(400)
    expect(await stored()).equals(legacy)
    expect((await update(pending)).status).equals(200)
    const record = readPasswordRecord(await stored())!
    expect(record.client).deep.equals(testPasswordParameters)
    expect(record.server.iterations).equals(24)
    expect(await stored()).not.includes(proof)
    expect((await update(pending)).status).equals(400)
    const response = await h.request(
      'POST',
      '/auth/password/parameters',
      { email: ' ALEX@example.com ' },
      null
    )
    expect(asArgonParameters(await response.json())).deep.equals(
      testPasswordParameters
    )
    expect(
      (
        await h.request(
          'POST',
          '/auth/password',
          { email: 'alex@example.com', clientHash: proof },
          null
        )
      ).status
    ).equals(200)
    const row = await h.db
      .selectFrom('email_codes')
      .select('approved_at')
      .where('id', '=', pending.requestId)
      .executeTakeFirstOrThrow()
    expect(row.approved_at).equals(null)
  })
  it('rejects exhausted, expired, wrong-owner, purpose and superseded reset codes', async () => {
    let pending = await reset()
    for (let i = 0; i < 5; i++)
      expect((await update({ ...pending, code: 'wrong' })).status).equals(400)
    expect((await update(pending)).status).equals(400)
    await h.resetLimits()
    pending = await reset()
    expect(
      (
        await h.request(
          'PUT',
          '/me/account/password',
          { ...body(), reset: pending },
          102
        )
      ).status
    ).equals(400)
    await h.db
      .updateTable('email_codes')
      .set({ expires_at: new Date(0) })
      .where('id', '=', pending.requestId)
      .execute()
    expect((await update(pending)).status).equals(400)
    pending = await reset()
    const newer = await reset()
    expect((await update(pending)).status).equals(400)
    const login = await createEmailCode(h.db, 'alex@example.com', 'login')
    expect(
      (await update({ requestId: login.id, code: login.code })).status
    ).equals(400)
    expect((await update(newer)).status).equals(200)
  })
  it('invalidates reset authorization when credentials or email ownership change', async () => {
    let pending = await reset()
    await h.db
      .updateTable('users')
      .set({ password_hash: legacy + 'changed' })
      .where('id', '=', 101)
      .execute()
    expect((await update(pending)).status).equals(400)
    pending = await reset()
    await h.db
      .updateTable('user_emails')
      .set({ email: 'changed@example.com' })
      .where('user_id', '=', 101)
      .execute()
    expect((await update(pending)).status).equals(400)
    await h.db
      .updateTable('user_emails')
      .set({ email: 'alex@example.com' })
      .where('user_id', '=', 101)
      .execute()
    for (const context of ['invalid JSON', 'null', '{}']) {
      pending = await reset()
      await h.db
        .updateTable('email_codes')
        .set({ next_path: context })
        .where('id', '=', pending.requestId)
        .execute()
      expect((await update(pending)).status).equals(400)
    }
  })
  it('consumes a reset only once across simultaneous submissions and handles mail failure', async () => {
    const pending = await reset()
    const responses = await Promise.all([update(pending), update(pending)])
    expect(responses.filter(r => r.status === 200)).length(1)
    expect(responses.filter(r => [400, 503].includes(r.status))).length(1)
    // A competing hash may be rejected busy; after completion the code is spent.
    expect((await update(pending)).status).equals(400)
    h.controls.failMail = true
    expect(
      (await h.request('POST', '/me/account/password/reset', {})).status
    ).equals(503)
    const codes = await h.db
      .selectFrom('email_codes')
      .select('consumed_at')
      .where('purpose', '=', 'reset')
      .where('consumed_at', 'is', null)
      .execute()
    expect(codes).length(0)
  })
  it('resets an Argon2 password and keeps saved costs despite different client defaults', async () => {
    await h.db
      .updateTable('users')
      .set({ password_hash: null })
      .where('id', '=', 101)
      .execute()
    const client = new TeamStationClient({
      baseUrl: h.origin + '/api/v1',
      token: h.tokens.get(101),
      passwordKdf: testPasswordKdf,
      passwordCosts: testPasswordCosts,
      passwordTargetMs: 1
    })
    await client.setAccountPassword('original invented password')
    const pending = await client.requestPasswordReset()
    await client.setAccountPassword('reset invented password', undefined, {
      requestId: pending.requestId,
      code: h.mail.get('alex@example.com')!
    })
    expect(
      await signInTestAccount(h.origin + '/api/v1', {
        email: 'alex@example.com',
        password: 'reset invented password'
      })
    ).to.be.a('string')
    const other = new TeamStationClient({
      baseUrl: h.origin + '/api/v1',
      passwordKdf: testPasswordKdf,
      passwordCosts: { ...testPasswordCosts, iterations: 3 }
    })
    expect(
      (
        await other.signInWithPassword(
          'alex@example.com',
          'reset invented password'
        )
      ).user.id
    ).equals(101)
  })
  it('accepts reset codes sent to a mixed-case stored address', async () => {
    await h.db
      .updateTable('user_emails')
      .set({ email: 'Alex@Example.com' })
      .where('user_id', '=', 101)
      .execute()
    try {
      const response = await h.request('POST', '/me/account/password/reset', {})
      expect(response.status).equals(202)
      const pending = (await response.json()) as { requestId: string }
      expect(
        (
          await update({
            requestId: pending.requestId,
            code: h.mail.get('Alex@Example.com')!
          })
        ).status
      ).equals(200)
    } finally {
      await h.db
        .updateTable('user_emails')
        .set({ email: 'alex@example.com' })
        .where('user_id', '=', 101)
        .execute()
    }
  })
  it('treats an empty credential as passwordless and explains a missing reset email', async () => {
    await h.db
      .updateTable('users')
      .set({ password_hash: '' })
      .where('id', '=', 101)
      .execute()
    const account = (await (await h.request('GET', '/me/account')).json()) as {
      hasPassword: boolean
      passwordNeedsUpgrade: boolean
    }
    expect(account.hasPassword).equals(false)
    expect(account.passwordNeedsUpgrade).equals(false)
    await h.db.deleteFrom('user_emails').where('user_id', '=', 101).execute()
    try {
      const response = await h.request('POST', '/me/account/password/reset', {})
      expect(response.status).equals(400)
      expect(JSON.stringify(await response.json())).includes(
        'Add and verify an email'
      )
    } finally {
      await h.db
        .insertInto('user_emails')
        .values({
          id: 'restored-email',
          user_id: 101,
          email: 'alex@example.com',
          is_primary: true
        })
        .execute()
    }
  })
  it('returns stable decoys for unknown and legacy users and bounds concurrent public attempts', async () => {
    const metadata = async (email: string): Promise<Response> =>
      await h.request('POST', '/auth/password/parameters', { email }, null)
    expect(await (await metadata('missing@example.com')).json()).deep.equals(
      await (await metadata('missing@example.com')).json()
    )
    expect(
      Object.keys(
        asArgonParameters(await (await metadata('alex@example.com')).json())
      )
    ).deep.equals(Object.keys(testPasswordParameters))
    expect((await metadata('x'.repeat(255))).status).equals(400)
    const invalid = await createPasswordRecord(proof, testPasswordParameters)
    await h.db
      .updateTable('users')
      .set({ password_hash: invalid, login_enabled: false })
      .where('id', '=', 101)
      .execute()
    expect(
      (
        await h.request(
          'POST',
          '/auth/password',
          { email: 'alex@example.com', clientHash: proof },
          null
        )
      ).status
    ).equals(401)
    await h.resetLimits()
    const replies = await Promise.all(
      Array.from(
        { length: 12 },
        async () =>
          await h.request(
            'POST',
            '/auth/password',
            { email: 'missing@example.com', clientHash: proof },
            null
          )
      )
    )
    expect(replies.filter(r => r.status === 401)).length(10)
    expect(replies.filter(r => r.status === 429)).length(2)
  })
})
