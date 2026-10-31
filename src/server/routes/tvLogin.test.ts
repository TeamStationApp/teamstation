import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'

import { TeamStationClient } from '../../common/api'
import { makeId } from '../../common/ids'
import {
  asTvLoginRequest,
  normalizeTvCode,
  type TvLoginRequest,
  tvTokenOfUrl
} from '../../common/tvLogin'
import { userIdOfGumbo } from '../../common/userId'
import { migration099TvLogin } from '../../migrate/migrations/099tvLogin'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import type { Actor } from '../auth/sessions'
import { hashToken, makeToken } from '../auth/tokens'
import { requireTvHuman, tvApprovalHash } from '../auth/tvLogin'

describe('TV device approval', function () {
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
  })
  async function start(): Promise<TvLoginRequest> {
    const r = await h.request(
      'POST',
      '/auth/tv/start',
      { platform: 'Apple TV' },
      null
    )
    expect(r.status).equals(200)
    return asTvLoginRequest(await r.json())
  }
  const claim = async (r: TvLoginRequest): Promise<Response> =>
    await h.request(
      'POST',
      '/auth/tv/claim',
      { requestId: r.requestId, clientSecret: r.clientSecret },
      null
    )
  it('rehearses migration rollback and reapply with populated accounts', async () => {
    await sql.raw(migration099TvLogin.down).execute(h.db)
    await sql.raw(migration099TvLogin.up).execute(h.db)
    expect(
      (await h.db.selectFrom('users').select('id').execute()).length
    ).greaterThan(0)
    await start()
  })
  it('supports the typed API lifecycle and leaves the pending client unsigned', async () => {
    const tv = new TeamStationClient({ baseUrl: h.origin + '/api/v1' })
    const human = new TeamStationClient({
      baseUrl: h.origin + '/api/v1',
      token: h.tokens.get(101)
    })
    const request = await tv.startTvLogin('Google TV')
    expect(
      await tv.claimTvLogin(request.requestId, request.clientSecret)
    ).deep.equals({ ready: false })
    const token = new URL(request.qrUrl).searchParams.get('token')!
    expect((await human.inspectTvLogin(token)).platform).equals('Google TV')
    await human.approveTvLogin({ code: request.displayCode })
    const session = await tv.claimTvLogin(
      request.requestId,
      request.clientSecret
    )
    expect(session).has.property('token')
    expect(tv.token).equals(undefined)
  })
  it('issues grouped alphabetic codes, stores only hashes and gives one 180-day session', async () => {
    const r = await start()
    expect(r.displayCode).matches(/^[A-Z]{4}–[A-Z]{4}$/)
    expect(r.expiresAt - Date.now()).within(115000, 120000)
    const stored = await h.db
      .selectFrom('tv_login_requests')
      .selectAll()
      .where('id', '=', r.requestId)
      .executeTakeFirstOrThrow()
    expect(JSON.stringify(stored)).not.includes(r.clientSecret)
    expect((await claim(r)).status).equals(202)
    expect(
      (
        await h.request('POST', '/auth/tv/approve', {
          code: r.displayCode.toLowerCase()
        })
      ).status
    ).equals(204)
    const responses = await Promise.all([claim(r), claim(r)])
    expect(responses.map(x => x.status).sort((a, b) => a - b)).deep.equals([
      200, 401
    ])
    const sessions = await h.db
      .selectFrom('auth_sessions')
      .selectAll()
      .where('device_name', '=', 'Apple TV')
      .execute()
    expect(sessions).length(1)
    expect(new Date(sessions[0].expires_at).getTime() - Date.now()).within(
      179 * 86400000,
      180 * 86400000
    )
  })
  it('QR inspection does not approve; repeated approval is idempotent and another account is refused', async () => {
    const r = await start()
    const token = new URL(r.qrUrl).searchParams.get('token')!
    const inspect = await h.request('POST', '/auth/tv/inspect', { token })
    expect(inspect.status).equals(200)
    expect(await inspect.json()).includes({
      platform: 'Apple TV',
      location: null
    })
    expect((await claim(r)).status).equals(202)
    for (let i = 0; i < 2; i++)
      expect(
        (await h.request('POST', '/auth/tv/approve', { token })).status
      ).equals(204)
    expect(
      (await h.request('POST', '/auth/tv/approve', { token }, 102)).status
    ).equals(409)
    expect((await claim(r)).status).equals(200)
    expect(
      (await h.request('POST', '/auth/tv/approve', { token })).status
    ).equals(401)
  })
  it('refuses expired, unknown, unsigned and malformed approvals', async () => {
    const r = await start()
    expect(
      (
        await h.request(
          'POST',
          '/auth/tv/approve',
          { code: r.displayCode },
          null
        )
      ).status
    ).equals(401)
    expect(
      (await h.request('POST', '/auth/tv/approve', { code: '12345678' })).status
    ).equals(400)
    expect(
      (await h.request('POST', '/auth/tv/approve', { code: 'ZZZZZZZZ' })).status
    ).equals(401)
    await h.db
      .updateTable('tv_login_requests')
      .set({ expires_at: new Date(0) })
      .where('id', '=', r.requestId)
      .execute()
    expect((await claim(r)).status).equals(401)
    expect(
      (await h.request('POST', '/auth/tv/approve', { code: r.displayCode }))
        .status
    ).equals(401)
    expect(
      (await h.request('POST', '/auth/tv/start', { platform: 'unknown' }, null))
        .status
    ).equals(400)
  })
  it('does not count pending polls as guesses but rate limits wrong secrets', async () => {
    const r = await start()
    for (let i = 0; i < 12; i++) expect((await claim(r)).status).equals(202)
    for (let i = 0; i < 10; i++)
      expect((await claim({ ...r, clientSecret: 'wrong' })).status).equals(401)
    expect((await claim({ ...r, clientSecret: 'wrong' })).status).equals(429)
  })
  it('refuses machine and Tess approvals through mounted authentication middleware', async () => {
    const r = await start()
    const token = new URL(r.qrUrl).searchParams.get('token')!
    const machine = makeToken()
    await h.db
      .insertInto('api_tokens')
      .values({
        id: makeId('apiToken'),
        user_id: userIdOfGumbo(101),
        label: 'fixture',
        token_hash: hashToken(machine),
        scopes: []
      })
      .execute()
    for (const action of ['approve', 'inspect']) {
      expect(
        (await h.request('POST', `/auth/tv/${action}`, { token }, machine))
          .status
      ).equals(403)
      const response = await fetch(`${h.origin}/api/v1/auth/tv/${action}`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${h.tokens.get(101)!}`,
          'x-teamstation-tess': '1',
          'content-type': 'application/json'
        },
        body: JSON.stringify({ token })
      })
      expect(response.status).equals(403)
    }
    expect((await claim(r)).status).equals(202)
  })
  it('limits request generation and approval guessing', async () => {
    for (let i = 0; i < 20; i++) await start()
    expect(
      (
        await h.request(
          'POST',
          '/auth/tv/start',
          { platform: 'Apple TV' },
          null
        )
      ).status
    ).equals(429)
    for (let i = 0; i < 30; i++)
      expect(
        (await h.request('POST', '/auth/tv/approve', { code: 'ZZZZZZZZ' }))
          .status
      ).equals(401)
    expect(
      (await h.request('POST', '/auth/tv/approve', { code: 'ZZZZZZZZ' })).status
    ).equals(429)
  })
  it('requires a human session at the service boundary', () => {
    const human: Actor = {
      userId: '1',
      isAdmin: false,
      sessionId: 'fixture',
      scopes: []
    }
    expect(() => {
      requireTvHuman(human)
    }).not.throws()
    for (const patch of [
      { sessionId: undefined },
      { apiTokenId: 'machine' },
      { viaTess: true as const },
      { apiKey: { id: 'key', permissions: new Set<never>() } }
    ])
      expect(() => {
        requireTvHuman({ ...human, ...patch })
      }).throws()
  })
  it('normalizes eight letters and accepts only the approved HTTPS QR origin', () => {
    expect(normalizeTvCode('abcd efgh')).equals('ABCDEFGH')
    expect(normalizeTvCode('12345678')).equals(null)
    expect(() => tvApprovalHash({})).throws()
    expect(() => tvApprovalHash({ code: 'ABCDEFGH', token: 'x' })).throws()
    expect(() => tvApprovalHash({ token: 'x' })).throws()
    const token = 'a'.repeat(43)
    const origin = 'https://app.example.test'
    expect(tvTokenOfUrl(`${origin}/tv-login?token=${token}`, origin)).equals(
      token
    )
    for (const url of [
      'invalid',
      `http://app.example.test/tv-login?token=${token}`,
      `${origin}/other?token=${token}`,
      `${origin}/tv-login?token=x`
    ])
      expect(tvTokenOfUrl(url, origin)).equals(null)
  })
})
