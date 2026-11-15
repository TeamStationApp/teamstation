import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import {
  actorForToken,
  createSession,
  purgeExpiredSessions,
  recordCredentialUse
} from './sessions'
import { hashToken, makeToken } from './tokens'

const babe = userIdOfGumbo(101)
const lou = userIdOfGumbo(102)
const at = (minutes: number, seconds = 0): Date =>
  new Date(Date.UTC(2026, 10, 1, 12) + minutes * 60_000 + seconds * 1000)

describe('device sessions', function () {
  this.timeout(60000)
  let h: AccountHarness
  beforeEach(async () => {
    h = await accountHarness()
    // The harness's own sign-ins were used while it was set up; these tests
    // start from no sessions at all.
    await h.db.deleteFrom('device_sessions').execute()
  })
  afterEach(async () => {
    await h?.close()
  })
  const signIn = async (userId = babe): Promise<string> =>
    (await createSession(h.db, userId, 'device test')).sessionId
  const use = async (
    sessionId: string,
    when: Date,
    userId = babe
  ): Promise<void> => {
    await recordCredentialUse(
      h.db,
      { userId, isAdmin: false, sessionId, scopes: [] },
      when
    )
  }
  const starts = async (sessionId?: string): Promise<string[]> =>
    (
      await h.db
        .selectFrom('device_sessions')
        .select('started_at')
        .$if(sessionId != null, q =>
          q.where('auth_session_id', '=', sessionId!)
        )
        .orderBy('started_at')
        .execute()
    ).map(row => new Date(row.started_at).toISOString())

  it('starts on a first use and after an hour or more, not under one', async () => {
    const device = await signIn()
    await use(device, at(0))
    expect(await starts(device)).deep.equals([at(0).toISOString()])
    await use(device, at(59, 59))
    expect(await starts(device)).deep.equals([at(0).toISOString()])
    // An hour from the use written last, to the second: a new session.
    await use(device, at(119, 59))
    await use(device, at(299, 59))
    expect(await starts(device)).deep.equals([
      at(0).toISOString(),
      at(119, 59).toISOString(),
      at(299, 59).toISOString()
    ])
  })

  it('judges each sign-in alone, so one device never keeps another going', async () => {
    const phone = await signIn()
    const browser = await signIn()
    // Thirty minutes apart, alternating: each device's own gap is an hour.
    await use(phone, at(0))
    await use(browser, at(30))
    await use(phone, at(60))
    await use(browser, at(90))
    expect(await starts(phone)).deep.equals([
      at(0).toISOString(),
      at(60).toISOString()
    ])
    expect(await starts(browser)).deep.equals([
      at(30).toISOString(),
      at(90).toISOString()
    ])
    const owners = await h.db
      .selectFrom('device_sessions')
      .select('user_id')
      .distinct()
      .execute()
    expect(owners.map(row => row.user_id)).deep.equals([babe])
  })

  it('needs no new login: an old sign-in starts a session on its next use', async () => {
    const device = await signIn(lou)
    await use(device, at(0), lou)
    await use(device, at(60 * 24 * 7), lou)
    expect(await starts(device)).to.have.length(2)
  })

  it('starts one session for requests that arrive together', async () => {
    const device = await signIn()
    await Promise.all(
      Array.from({ length: 8 }, async () => {
        await use(device, at(0))
      })
    )
    expect(await starts(device)).to.have.length(1)
  })

  it('counts every authenticated request, and no machine credential', async () => {
    const session = await createSession(h.db, babe, 'device test')
    await actorForToken(h.db, session.token)
    expect(await starts(session.sessionId)).to.have.length(1)
    await actorForToken(h.db, session.token, { recordUse: false })
    expect(await starts(session.sessionId)).to.have.length(1)
    const token = makeToken()
    await h.db
      .insertInto('api_tokens')
      .values({
        id: makeId('apiToken'),
        user_id: babe,
        label: 'machine',
        token_hash: hashToken(token),
        created_at: new Date()
      })
      .execute()
    await actorForToken(h.db, token)
    expect(await starts()).to.have.length(1)
  })

  it('goes with its sign-in when the nightly purge removes it', async () => {
    const device = await signIn()
    await use(device, at(0))
    await h.db
      .updateTable('auth_sessions')
      .set({ expires_at: at(-60) })
      .where('id', '=', device)
      .execute()
    expect(await purgeExpiredSessions(h.db, at(0))).equals(1)
    expect(await starts(device)).deep.equals([])
  })
})
