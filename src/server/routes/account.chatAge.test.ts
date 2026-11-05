import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import { asChatAge, type ChatAge } from '../../common/chatAge'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { hashToken, makeToken } from '../auth/tokens'

const ROUTE = '/me/account/chat-age'

describe('the account chat age confirmation', function () {
  this.timeout(60000)
  let h: AccountHarness
  before(async () => {
    h = await accountHarness()
  })
  beforeEach(async () => {
    await h.resetLimits()
    await h.db
      .updateTable('users')
      .set({ chat_age_confirmed_at: null, chat_age_source: null })
      .where('id', 'in', [userIdOfGumbo(101), userIdOfGumbo(102)])
      .execute()
  })
  after(async () => {
    await h?.close()
  })

  const read = async (user = 101): Promise<ChatAge> => {
    const response = await h.request('GET', ROUTE, undefined, user)
    expect(response.status).equals(200)
    return asChatAge(await response.json())
  }
  const confirm = async (source: unknown, user = 101): Promise<Response> =>
    await h.request('PUT', ROUTE, { source }, user)

  it('is for a signed-in person, and never a machine actor or an API key', async () => {
    expect((await h.request('GET', ROUTE, undefined, null)).status).equals(401)
    expect(
      (await h.request('PUT', ROUTE, { source: 'self' }, null)).status
    ).equals(401)
    const token = makeToken()
    await h.db
      .insertInto('api_tokens')
      .values({
        id: makeId('apiToken'),
        user_id: userIdOfGumbo(101),
        token_hash: hashToken(token),
        label: 'chat age fixture',
        scopes: []
      })
      .execute()
    expect((await h.request('GET', ROUTE, undefined, token)).status).equals(403)
    await h.db
      .insertInto('user_api_keys')
      .values({
        id: makeId('userApiKey'),
        user_id: userIdOfGumbo(101),
        name: 'Chat age key',
        token_hash: hashToken('tsk_chat_age_account'),
        secret_sealed: 'v1.unused',
        permissions: ['account:read', 'account:write']
      })
      .execute()
    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { source: 'self' }]
    ] as const) {
      expect(
        (await h.request(method, ROUTE, body, 'tsk_chat_age_account')).status
      ).equals(403)
    }
    expect((await read()).confirmed).equals(false)
  })

  it('answers unconfirmed until the person confirms, then how and when', async () => {
    expect(await read()).deep.equals({
      confirmed: false,
      source: null,
      confirmedAt: null
    })
    const before = Date.now()
    const response = await confirm('self')
    expect(response.status).equals(200)
    const confirmed = asChatAge(await response.json())
    expect(confirmed.confirmed).equals(true)
    expect(confirmed.source).equals('self')
    expect(Date.parse(confirmed.confirmedAt!)).within(before - 1000, Date.now())
    expect(await read()).deep.equals(confirmed)
    // Another account is untouched.
    expect((await read(102)).confirmed).equals(false)
  })

  it('records an Apple confirmation, and keeps the first one through a later call', async () => {
    const first = asChatAge(await (await confirm('apple')).json())
    expect(first.source).equals('apple')
    const again = await confirm('self')
    expect(again.status).equals(200)
    expect(asChatAge(await again.json())).deep.equals(first)
    expect(await read()).deep.equals(first)
  })

  it('marks the account updated when it confirms, and not on a later call', async () => {
    const past = new Date('2026-01-01T00:00:00.000Z')
    const updatedAt = async (): Promise<number> => {
      const row = await h.db
        .selectFrom('users')
        .select('updated_at')
        .where('id', '=', userIdOfGumbo(101))
        .executeTakeFirstOrThrow()
      return new Date(row.updated_at).getTime()
    }
    const setUpdated = async (): Promise<void> => {
      await h.db
        .updateTable('users')
        .set({ updated_at: past })
        .where('id', '=', userIdOfGumbo(101))
        .execute()
    }
    await setUpdated()
    expect((await confirm('self')).status).equals(200)
    const confirmedAt = Date.parse((await read()).confirmedAt ?? '')
    expect(await updatedAt()).equals(confirmedAt)
    await setUpdated()
    expect((await confirm('apple')).status).equals(200)
    expect(await updatedAt()).equals(past.getTime())
  })

  it('refuses any other body and stores nothing', async () => {
    for (const body of [
      {},
      { source: 'adult' },
      { source: 'self', age: 13 },
      [],
      'self'
    ]) {
      const response = await h.request('PUT', ROUTE, body)
      expect(response.status, JSON.stringify(body)).equals(400)
    }
    expect((await read()).confirmed).equals(false)
  })

  it('keeps a source and its time together in the table', async () => {
    let refused = false
    await h.db
      .updateTable('users')
      .set({ chat_age_source: 'self' })
      .where('id', '=', userIdOfGumbo(101))
      .execute()
      .catch(() => {
        refused = true
      })
    expect(refused).equals(true)
  })
})
