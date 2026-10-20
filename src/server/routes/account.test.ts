import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import {
  type AccountSettings,
  asAccountSettings
} from '../../common/accountSettings'
import { asPlayerDetail, asSession, TeamStationClient } from '../../common/api'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import {
  type AccountHarness,
  accountHarness,
  accountTestPicture
} from '../../test/accountHarness'
import {
  testPasswordCosts,
  testPasswordKdf,
  testPasswordParameters
} from '../../test/passwordFixtures'
import { createEmailCode } from '../auth/emailCodes'
import { readPasswordRecord } from '../auth/passwords'
import { hashToken, makeToken } from '../auth/tokens'

const ROOT = '/me/account'
describe('account settings HTTP API', function () {
  this.timeout(60000)
  let h: AccountHarness
  it('clears only the signed-in account picture reference and preserves a shared catalog object used by another account', async () => {
    const prefix = 'sports/fixture-shared-baseball'
    h.objects.set(prefix + '-96.png', Buffer.from('synthetic catalog object'))
    await h.db
      .updateTable('users')
      .set({
        picture_catalog_id: 'baseball',
        avatar_path: prefix,
        avatar_source: 'upload'
      })
      .where('id', 'in', [userIdOfGumbo(101), userIdOfGumbo(102)])
      .execute()
    const cleared = await h.request('DELETE', ROOT + '/photo')
    expect(cleared.status).equals(200)
    expect(asAccountSettings(await cleared.json()).user.avatarUrl).equals(null)
    expect(
      (
        await h.db
          .selectFrom('users')
          .select('avatar_path')
          .where('id', '=', userIdOfGumbo(102))
          .executeTakeFirstOrThrow()
      ).avatar_path
    ).equals(prefix)
    expect(h.objects.has(prefix + '-96.png')).equals(true)
    h.objects.delete(prefix + '-96.png')
    await h.db
      .updateTable('users')
      .set({ picture_catalog_id: null, avatar_path: null, avatar_source: null })
      .where('id', '=', userIdOfGumbo(102))
      .execute()
  })
  before(async () => {
    h = await accountHarness()
  })
  beforeEach(async () => {
    await h.resetLimits()
    h.controls.failMail = false
    h.controls.failPut = false
  })
  after(async () => {
    await h?.close()
  })
  const read = async (): Promise<AccountSettings> =>
    asAccountSettings(await (await h.request('GET', ROOT)).json())
  const requestEmail = async (
    email: string,
    replaceEmailId?: string,
    user = 101
  ): Promise<{ requestId: string; code: string }> => {
    const response = await h.request(
      'POST',
      ROOT + '/emails/request',
      { email, replaceEmailId },
      user
    )
    expect(response.status).equals(202)
    const body = (await response.json()) as { requestId: string }
    return { ...body, code: h.mail.get(email.trim().toLowerCase())! }
  }
  const confirm = async (
    request: { requestId: string; code: string },
    user = 101
  ): Promise<Response> =>
    await h.request('POST', ROOT + '/emails/confirm', request, user)

  it('requires a person session and keeps credential material out of reads', async () => {
    expect((await h.request('GET', ROOT, undefined, null)).status).equals(401)
    expect(
      (
        await h.request(
          'PUT',
          ROOT + '/photo',
          { image: accountTestPicture },
          null
        )
      ).status
    ).equals(401)
    const token = makeToken()
    await h.db
      .insertInto('api_tokens')
      .values({
        id: makeId('apiToken'),
        user_id: userIdOfGumbo(101),
        token_hash: hashToken(token),
        label: 'fixture',
        scopes: []
      })
      .execute()
    expect((await h.request('GET', ROOT, undefined, token)).status).equals(403)
    const state = await read()
    expect(state.user.email).equals('alex@example.com')
    expect(state.hasPassword).equals(false)
    expect(JSON.stringify(state)).not.includes('clientHash')
    expect(state.passwordParameters).equals(null)
  })
  it('saves names consistently for account, player and roster readers', async () => {
    for (const displayName of ['', ' '.repeat(2), 'a'.repeat(121)]) {
      expect(
        (await h.request('PUT', ROOT + '/name', { displayName })).status
      ).equals(400)
    }
    const response = await h.request('PUT', ROOT + '/name', {
      displayName: '  Alex   Rodriguez  ',
      userId: userIdOfGumbo(102)
    })
    expect(response.status).equals(200)
    expect((await read()).user.displayName).equals('Alex Rodriguez')
    const player = asPlayerDetail(
      await (
        await h.request('GET', '/players/usr_111111111111111111112k')
      ).json()
    )
    expect(player.name).equals('Alex R')
    const team = await (
      await h.request('GET', '/teams/tem_account/roster')
    ).json()
    expect(JSON.stringify(team)).includes('Alex R')
    const other = await h.db
      .selectFrom('users')
      .select('display_name')
      .where('id', '=', userIdOfGumbo(102))
      .executeTakeFirstOrThrow()
    expect(other.display_name).equals('Lou Gehrig')
    expect(
      (await h.request('PUT', ROOT + '/name', { displayName: 'Alex' })).status
    ).equals(200)
    expect(
      (
        await h.db
          .selectFrom('users')
          .select('last_name')
          .where('id', '=', userIdOfGumbo(101))
          .executeTakeFirstOrThrow()
      ).last_name
    ).equals(null)
  })
  it('uploads both profile renditions through the Space and preserves pictures on failure', async () => {
    expect(
      (await h.request('PUT', ROOT + '/photo', { image: accountTestPicture }))
        .status
    ).equals(200)
    let state = await read()
    expect(state.user.avatarUrl).includes(h.space.endpoint)
    expect(h.objects.size).equals(2)
    expect([...h.objects.keys()].some(key => key.endsWith('-96.png'))).equals(
      true
    )
    expect([...h.objects.keys()].some(key => key.endsWith('-192.png'))).equals(
      true
    )
    expect((await fetch(state.user.avatarUrl!)).status).equals(200)
    const original = (
      await h.db
        .selectFrom('users')
        .selectAll()
        .where('id', '=', userIdOfGumbo(101))
        .executeTakeFirstOrThrow()
    ).avatar_path
    expect(
      (await h.request('PUT', ROOT + '/photo', { image: accountTestPicture }))
        .status
    ).equals(200)
    expect(h.objects.size).equals(2)
    for (const image of [
      { ...accountTestPicture, contentType: 'text/plain' },
      { ...accountTestPicture, base64: 'not base64' },
      { contentType: 'image/png', base64: accountTestPicture.base64 }
    ]) {
      expect((await h.request('PUT', ROOT + '/photo', { image })).status).oneOf(
        [400, 415]
      )
    }
    expect(
      (
        await h.request('PUT', ROOT + '/photo', {
          image: {
            contentType: 'image/webp',
            base64: Buffer.alloc(10 * 1024 * 1024 + 1).toString('base64')
          }
        })
      ).status
    ).equals(413)
    h.space.accessKeyId = ''
    expect(
      (await h.request('PUT', ROOT + '/photo', { image: accountTestPicture }))
        .status
    ).equals(503)
    h.space.accessKeyId = 'test-key'
    // Force upload, and prove no DB reference changes when the Space refuses it.
    await h.db
      .updateTable('users')
      .set({ avatar_sha256: null })
      .where('id', '=', userIdOfGumbo(101))
      .execute()
    h.controls.failPut = true
    expect(
      (await h.request('PUT', ROOT + '/photo', { image: accountTestPicture }))
        .status
    ).equals(503)
    expect(
      (
        await h.db
          .selectFrom('users')
          .select('avatar_path')
          .where('id', '=', userIdOfGumbo(101))
          .executeTakeFirstOrThrow()
      ).avatar_path
    ).equals(original)
    h.controls.failPut = false
    expect(
      (
        await h.request('PUT', ROOT + '/photo', {
          image: { contentType: 'image/png', base64: 'iVBORw0KGgo=' }
        })
      ).status
    ).equals(415)
    state = await read()
    expect(state.user.avatarUrl).not.equals(null)
  })
  const passwordClient = (): TeamStationClient =>
    new TeamStationClient({
      baseUrl: h.origin + '/api/v1',
      token: h.tokens.get(101),
      passwordKdf: testPasswordKdf,
      passwordCosts: testPasswordCosts,
      passwordTargetMs: 1
    })
  it('sets and changes passwords with saved parameters and no raw HTTP password', async () => {
    const client = passwordClient()
    for (const password of ['short', 'a'.repeat(1025), '😀'.repeat(257)]) {
      try {
        await client.setAccountPassword(password)
        expect.fail('accepted invalid password')
      } catch (error) {
        expect(String(error)).matches(/8 characters|1024 UTF-8 bytes/)
      }
    }
    expect(
      (await h.request('PUT', ROOT + '/password', { password: makeToken() }))
        .status
    ).equals(400)
    await client.setAccountPassword('Initial invented password')
    const held = await h.db
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', userIdOfGumbo(101))
      .executeTakeFirstOrThrow()
    const record = readPasswordRecord(held.password_hash)!
    expect(record.server.iterations).equals(record.client.iterations * 4)
    expect(record.server.salt).not.equals(record.client.salt)
    try {
      await client.setAccountPassword('next invented password', 'wrong')
      expect.fail('accepted wrong password')
    } catch (error) {
      expect(String(error)).includes('current password is incorrect')
    }
    const next = 'é'.repeat(100)
    await client.setAccountPassword(next, 'Initial invented password')
    try {
      await client.signInWithPassword(
        'alex@example.com',
        'Initial invented password'
      )
      expect.fail('old password accepted')
    } catch (error) {
      expect(String(error)).includes('Wrong e-mail')
    }
    const login = await client.signInWithPassword('alex@example.com', next)
    const profileAvatar = (await read()).user.avatarUrl
    if (profileAvatar == null) expect(login.user.avatarUrl).equals(null)
    else {
      // Sign-in uses the tile rendition; the account page uses the profile.
      expect(
        new URL(login.user.avatarUrl!).pathname.replace(/-96\.png$/, '')
      ).equals(new URL(profileAvatar).pathname.replace(/-192\.png$/, ''))
      expect((await fetch(login.user.avatarUrl!)).status).equals(200)
    }
    const wait = await h.request(
      'POST',
      '/auth/email-code',
      { email: 'alex@example.com' },
      null
    )
    expect(wait.status).equals(202)
    const codeLogin = await h.request(
      'POST',
      '/auth/email-code/verify',
      { email: 'alex@example.com', code: h.mail.get('alex@example.com') },
      null
    )
    expect(codeLogin.status).equals(200)
    const audits = await h.db
      .selectFrom('audit_log')
      .select(['before', 'after'])
      .execute()
    expect(JSON.stringify(audits)).not.includes(next)
    expect(JSON.stringify(audits)).not.includes(record.hash)
  })
  it('bounds password attempts persistently', async () => {
    const body = {
      clientHash: 'ab'.repeat(32),
      clientParameters: testPasswordParameters,
      currentClientHash: 'cd'.repeat(32)
    }
    for (let n = 0; n < 10; n++)
      expect((await h.request('PUT', ROOT + '/password', body)).status).equals(
        400
      )
    expect((await h.request('PUT', ROOT + '/password', body)).status).equals(
      429
    )
  })
  it('accepts new emails only after verification and selects or replaces primary atomically', async () => {
    const pending = await requestEmail('  Another@Example.com  ')
    expect((await read()).emails.map(e => e.email)).not.includes(
      'another@example.com'
    )
    expect(
      (
        await h.request(
          'POST',
          '/auth/password',
          { email: 'another@example.com', clientHash: 'ab'.repeat(32) },
          null
        )
      ).status
    ).equals(401)
    expect((await confirm({ ...pending, code: 'wrong' })).status).equals(400)
    expect((await confirm(pending, 102)).status).equals(400)
    expect((await confirm(pending)).status).equals(200)
    expect((await confirm(pending)).status).equals(400)
    const extra = (await read()).emails.find(
      e => e.email === 'another@example.com'
    )!
    expect(
      (await h.request('PUT', ROOT + '/emails/primary', { emailId: extra.id }))
        .status
    ).equals(200)
    expect((await read()).user.email).equals(extra.email)
    const signed = await h.request(
      'POST',
      '/auth/password',
      {
        email: 'alex@example.com',
        clientHash: await testPasswordKdf(
          'é'.repeat(100),
          (await read()).passwordParameters!.client
        )
      },
      null
    )
    expect(asSession(await signed.json()).user.email).equals(extra.email)
    const link = await createEmailCode(h.db, 'alex@example.com', 'login')
    const linkLogin = await h.request(
      'POST',
      '/auth/link/verify',
      { token: link.token },
      null
    )
    expect(linkLogin.status).equals(200)
    const linked = asSession(await linkLogin.json())
    expect(linked.user.email).equals(extra.email)
    expect(linked.user.avatarUrl).includes(h.space.endpoint)
    const claimLogin = await h.request(
      'POST',
      '/auth/request/claim',
      { requestId: link.id, clientSecret: link.clientSecret },
      null
    )
    expect(claimLogin.status).equals(200)
    const claimed = asSession(await claimLogin.json())
    expect(claimed.user.email).equals(extra.email)
    expect(claimed.user.avatarUrl).includes(h.space.endpoint)
    const replacement = await requestEmail('replacement@example.com', extra.id)
    expect((await read()).user.email).equals(extra.email)
    expect((await confirm(replacement)).status).equals(200)
    const state = await read()
    expect(state.user.email).equals('replacement@example.com')
    expect(state.emails.filter(e => e.isPrimary)).length(1)
    expect(state.emails.some(e => e.email === extra.email)).equals(false)
    expect(
      (
        await h.request(
          'POST',
          '/auth/password',
          { email: extra.email, clientHash: 'ab'.repeat(32) },
          null
        )
      ).status
    ).equals(401)
    expect(
      (
        await h.request(
          'POST',
          '/auth/password',
          {
            email: 'replacement@example.com',
            clientHash: await testPasswordKdf(
              'é'.repeat(100),
              (await read()).passwordParameters!.client
            )
          },
          null
        )
      ).status
    ).equals(200)
    const row = await h.db
      .selectFrom('user_emails')
      .select('verified_at')
      .where('id', '=', extra.id)
      .executeTakeFirstOrThrow()
    expect(row.verified_at).not.equals(null)
  })
  it('rejects invalid, duplicate and foreign email ids', async () => {
    for (const email of [
      'bad',
      'a@b',
      'a b@example.com',
      'a'.repeat(250) + '@example.com'
    ])
      expect(
        (await h.request('POST', ROOT + '/emails/request', { email })).status
      ).equals(400)
    for (const email of ['ALEX@example.com', 'CASEY@example.com'])
      expect(
        (await h.request('POST', ROOT + '/emails/request', { email })).status
      ).equals(409)
    expect(
      (
        await h.request('POST', ROOT + '/emails/request', {
          email: 'valid@example.com',
          replaceEmailId: 'email_102'
        })
      ).status
    ).equals(400)
    expect(
      (
        await h.request('PUT', ROOT + '/emails/primary', {
          emailId: 'email_102'
        })
      ).status
    ).equals(400)
    expect(
      (await h.request('POST', ROOT + '/emails/confirm', {})).status
    ).equals(400)
  })
  it('invalidates resends, expired and exhausted codes and isolates login requests', async () => {
    const older = await requestEmail('resend@example.com')
    const newer = await requestEmail('resend@example.com')
    expect((await confirm(older)).status).equals(400)
    for (let i = 0; i < 5; i++)
      expect((await confirm({ ...newer, code: 'wrong' })).status).equals(400)
    expect((await confirm(newer)).status).equals(400)
    const expired = await requestEmail('expired@example.com')
    await h.db
      .updateTable('email_codes')
      .set({ expires_at: new Date(0) })
      .where('id', '=', expired.requestId)
      .execute()
    expect((await confirm(expired)).status).equals(400)
    const login = await createEmailCode(h.db, 'isolated@example.com', 'login')
    expect(
      (await confirm({ requestId: login.id, code: login.code })).status
    ).equals(400)
    const verification = await createEmailCode(
      h.db,
      'bound@example.com',
      'verify',
      { next: JSON.stringify({ userId: userIdOfGumbo(101) }) }
    )
    expect(
      (
        await h.request(
          'POST',
          '/auth/link/verify',
          { token: verification.token },
          null
        )
      ).status
    ).equals(401)
    expect(
      (await confirm({ requestId: verification.id, code: verification.code }))
        .status
    ).equals(200)
    const claim = await h.request(
      'POST',
      '/auth/request/claim',
      { requestId: verification.id, clientSecret: verification.clientSecret },
      null
    )
    expect(claim.status).equals(202)
    const malformed = await createEmailCode(
      h.db,
      'malformed@example.com',
      'verify',
      { next: 'invalid' }
    )
    expect(
      (await confirm({ requestId: malformed.id, code: malformed.code })).status
    ).equals(400)
    const unbound = await createEmailCode(h.db, 'unbound@example.com', 'verify')
    expect(
      (await confirm({ requestId: unbound.id, code: unbound.code })).status
    ).equals(400)
    expect(
      (await confirm({ requestId: 'absent', code: 'wrong' })).status
    ).equals(400)
  })
  it('commits every wrong concurrent guess, allows one confirmation, and one primary', async () => {
    const guesses = await requestEmail('guesses@example.com')
    const responses = await Promise.all(
      Array.from(
        { length: 6 },
        async () => await confirm({ ...guesses, code: 'wrong' })
      )
    )
    expect(responses.every(r => r.status === 400)).equals(true)
    const row = await h.db
      .selectFrom('email_codes')
      .select('attempts')
      .where('id', '=', guesses.requestId)
      .executeTakeFirstOrThrow()
    expect(row.attempts).equals(5)
    const good = await requestEmail('race@example.com')
    expect(
      (await Promise.all([confirm(good), confirm(good)]))
        .map(r => r.status)
        .sort((a, b) => a - b)
    ).deep.equals([200, 400])
    const addresses = (await read()).emails
    const switches = await Promise.all(
      addresses.map(
        async address =>
          await h.request('PUT', ROOT + '/emails/primary', {
            emailId: address.id
          })
      )
    )
    expect(switches.every(r => r.status === 200)).equals(true)
    expect((await read()).emails.filter(e => e.isPrimary)).length(1)
  })
  it('checks conflicts again at confirmation and keeps the original address', async () => {
    const mine = await requestEmail('claim@example.com', 'email_101')
    const theirs = await requestEmail('claim@example.com', undefined, 102)
    expect((await confirm(mine)).status).equals(400)
    expect((await confirm(theirs, 102)).status).equals(200)
    const changed = await requestEmail('claimedlater@example.com', 'email_101')
    await h.db
      .insertInto('user_emails')
      .values({
        id: makeId('userEmail'),
        user_id: userIdOfGumbo(102),
        email: 'claimedlater@example.com',
        source: 'manual'
      })
      .execute()
    expect((await confirm(changed)).status).equals(409)
    expect(
      (await read()).emails.some(e => e.email === 'alex@example.com')
    ).equals(true)
  })
  it('reports delivery failure, bounds requests, and creates a primary for an empty account', async () => {
    h.controls.failMail = true
    expect(
      (
        await h.request('POST', ROOT + '/emails/request', {
          email: 'delivery@example.com'
        })
      ).status
    ).equals(503)
    h.controls.failMail = false
    for (let i = 0; i < 5; i++) await requestEmail('limited@example.com')
    expect(
      (
        await h.request('POST', ROOT + '/emails/request', {
          email: 'limited@example.com'
        })
      ).status
    ).equals(429)
    await h.db
      .deleteFrom('user_emails')
      .where('user_id', '=', userIdOfGumbo(102))
      .execute()
    const first = await requestEmail('first@example.com', undefined, 102)
    expect((await confirm(first, 102)).status).equals(200)
    const state = asAccountSettings(
      await (await h.request('GET', ROOT, undefined, 102)).json()
    )
    expect(state.emails).length(1)
    expect(state.emails[0].isPrimary).equals(true)
  })
  it('the public client serializes each account operation', async () => {
    const client = new TeamStationClient({
      baseUrl: h.origin + '/api/v1',
      token: h.tokens.get(102),
      passwordKdf: testPasswordKdf,
      passwordCosts: testPasswordCosts,
      passwordTargetMs: 1
    })
    expect((await client.accountSettings()).user.id).equals(userIdOfGumbo(102))
    expect((await client.setAccountName('Casey Mize')).user.displayName).equals(
      'Casey Mize'
    )
    expect(
      (await client.setAccountPhoto(accountTestPicture)).user.avatarUrl
    ).not.equals(null)
    expect((await client.setAccountPassword(makeToken())).hasPassword).equals(
      true
    )
    const pending = await client.requestAccountEmail('client@example.com')
    const state = await client.confirmAccountEmail(
      pending.requestId,
      h.mail.get('client@example.com')!
    )
    const added = state.emails.find(e => e.email === 'client@example.com')!
    expect((await client.setAccountPrimaryEmail(added.id)).user.email).equals(
      added.email
    )
  })
})
