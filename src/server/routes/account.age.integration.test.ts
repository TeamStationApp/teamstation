import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'

import { type AgeView, asAgeView } from '../../common/age'
import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { hashToken } from '../auth/tokens'

const ROUTE = '/me/account/age'

/** Today's year and month in UTC, `months` back. */
function monthsAgo(months: number): { year: number; month: number } {
  const now = new Date()
  const total = now.getUTCFullYear() * 12 + now.getUTCMonth() - months
  return { year: Math.floor(total / 12), month: (total % 12) + 1 }
}

describe('the account age', function () {
  this.timeout(60000)
  let h: AccountHarness
  const me = userIdOfGumbo(101)
  before(async () => {
    h = await accountHarness()
  })
  beforeEach(async () => {
    await h.resetLimits()
    await h.db
      .updateTable('users')
      .set({
        birth_year: null,
        birth_month: null,
        is_adult: false,
        age_source: null,
        age_set_at: null
      })
      .where('id', 'in', [userIdOfGumbo(101), userIdOfGumbo(102)])
      .execute()
    await h.db.deleteFrom('audit_log').execute()
  })
  after(async () => {
    await h?.close()
  })

  const read = async (user = 101): Promise<AgeView> => {
    const response = await h.request('GET', ROUTE, undefined, user)
    expect(response.status).equals(200)
    return asAgeView(await response.json())
  }
  const answer = async (body: unknown, user = 101): Promise<Response> =>
    await h.request('PUT', ROUTE, body, user)
  const answered = async (body: unknown): Promise<AgeView> => {
    const response = await answer(body)
    expect(response.status, JSON.stringify(body)).equals(200)
    return asAgeView(await response.json())
  }
  const reason = async (response: Response): Promise<unknown> =>
    ((await response.json()) as { details?: { reason?: unknown } }).details
      ?.reason

  it('is for a signed-in person, and never an API key', async () => {
    expect((await h.request('GET', ROUTE, undefined, null)).status).equals(401)
    expect(
      (await h.request('PUT', ROUTE, { adult: true }, null)).status
    ).equals(401)
    await h.db
      .insertInto('user_api_keys')
      .values({
        id: makeId('userApiKey'),
        user_id: me,
        name: 'Age key',
        token_hash: hashToken('tsk_age_account'),
        secret_sealed: 'v1.unused',
        permissions: ['account:read', 'account:write']
      })
      .execute()
    for (const [method, body] of [
      ['GET', undefined],
      ['PUT', { adult: true }]
    ] as const) {
      expect(
        (await h.request(method, ROUTE, body, 'tsk_age_account')).status
      ).equals(403)
    }
    expect((await read()).band).equals('unknown')
  })

  it('answers unknown until the person gives a birth month, then the band, how and when', async () => {
    expect(await read()).deep.equals({
      band: 'unknown',
      birthYear: null,
      birthMonth: null,
      isAdult: false,
      ageSource: null,
      ageSetAt: null
    })
    const birth = monthsAgo(15 * 12 + 2)
    const started = Date.now()
    const age = await answered(birth)
    expect(age.band).equals('minor')
    expect(age.birthYear).equals(birth.year)
    expect(age.birthMonth).equals(birth.month)
    expect(age.isAdult).equals(false)
    expect(age.ageSource).equals('self')
    expect(Date.parse(age.ageSetAt!)).within(started - 1000, Date.now())
    expect(await read()).deep.equals(age)
    expect((await read(102)).band).equals('unknown')
    const audit = await h.db
      .selectFrom('audit_log')
      .select(['entity_type', 'entity_id', 'before', 'after'])
      .where('entity_type', '=', 'age')
      .execute()
    expect(audit).deep.equals([
      {
        entity_type: 'age',
        entity_id: me,
        before: { band: 'unknown' },
        after: { band: 'minor' }
      }
    ])
  })

  it('takes 18 or older, and Apple’s 18 or older alone', async () => {
    const adult = await answered({ adult: true })
    expect(adult.band).equals('adult')
    expect(adult.isAdult).equals(true)
    expect(adult.ageSource).equals('self')
    expect(adult.birthYear).equals(null)

    await h.db
      .updateTable('users')
      .set({ is_adult: false, age_source: null, age_set_at: null })
      .where('id', '=', me)
      .execute()
    const apple = await answered({ apple: { lowerBound: 18 } })
    expect(apple.band).equals('adult')
    expect(apple.ageSource).equals('apple')
  })

  it('takes only the first answer, and none over an age somebody else set', async () => {
    await answered({ adult: true })
    const second = await answer(monthsAgo(14 * 12))
    expect(second.status).equals(409)
    expect(await reason(second)).equals('ageSet')
    expect((await read()).band).equals('adult')

    // A coach or guardian gave this person a birth month before they ever
    // answered: the person cannot override it.
    const teen = monthsAgo(14 * 12)
    await h.db
      .updateTable('users')
      .set({ birth_year: teen.year, birth_month: teen.month })
      .where('id', '=', userIdOfGumbo(102))
      .execute()
    for (const body of [{ adult: true }, monthsAgo(30 * 12)]) {
      const response = await answer(body, 102)
      expect(response.status).equals(409)
      expect(await reason(response)).equals('ageSet')
    }
    expect((await read(102)).band).equals('minor')
  })

  it('keeps an answer under 13', async () => {
    const child = await answered(monthsAgo(11 * 12))
    expect(child.band).equals('under13')
    const again = await answer({ adult: true })
    expect(again.status).equals(409)
    expect((await read()).band).equals('under13')
  })

  it('refuses an answer outside the Apple range it comes with', async () => {
    const sixteen = monthsAgo(16 * 12 + 1)
    const range = { lowerBound: 13, upperBound: 15 }
    const outside = await answer({ ...sixteen, apple: range })
    expect(outside.status).equals(400)
    expect(await reason(outside)).equals('outsideAppleRange')
    const adult = await answer({ adult: true, apple: range })
    expect(adult.status).equals(400)
    expect(await reason(adult)).equals('outsideAppleRange')
    expect((await read()).band).equals('unknown')

    // A lower bound of 13 with no upper bound means 13 to 17.
    const eighteen = await answer({
      ...monthsAgo(18 * 12 + 1),
      apple: { lowerBound: 13 }
    })
    expect(eighteen.status).equals(400)
    const fourteen = await answered({
      ...monthsAgo(14 * 12 + 1),
      apple: range
    })
    expect(fourteen.band).equals('minor')
    expect(fourteen.ageSource).equals('apple')
  })

  it('accepts a seventeen-year-old under a lower bound of 13 alone', async () => {
    const age = await answered({
      ...monthsAgo(17 * 12 + 1),
      apple: { lowerBound: 13 }
    })
    expect(age.band).equals('minor')
  })

  it('refuses any other body and stores nothing', async () => {
    const now = new Date()
    for (const body of [
      {},
      [],
      'adult',
      { adult: false },
      { adult: true, year: 2000, month: 1 },
      { year: 999, month: 1 },
      { year: 2000, month: 0 },
      { year: 2000, month: 13 },
      { year: 2000 },
      { year: now.getUTCFullYear() + 1, month: 1 },
      { year: 2000, month: 1, day: 4 },
      { apple: { lowerBound: 13 } },
      { apple: { lowerBound: 15, upperBound: 13 } },
      { apple: { lowerBound: 18, extra: 1 } }
    ]) {
      const response = await answer(body)
      expect(response.status, JSON.stringify(body)).equals(400)
    }
    if (now.getUTCMonth() < 11) {
      const next = await answer({
        year: now.getUTCFullYear(),
        month: now.getUTCMonth() + 2
      })
      expect(next.status).equals(400)
    }
    expect((await read()).band).equals('unknown')
  })
})
