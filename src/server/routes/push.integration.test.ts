import { randomBytes } from 'node:crypto'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, beforeEach, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import { userIdOfGumbo } from '../../common/userId'
import { type AccountHarness, accountHarness } from '../../test/accountHarness'
import { createSession } from '../auth/sessions'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { TESS_HEADER } from '../middleware/withAuth'
import {
  liveRegistrations,
  type PushAddress,
  type PushMessage,
  type PushResult,
  type PushTransports,
  sendPush
} from '../push/send'
import { MAX_REGISTRATIONS_PER_USER, pushRoutes } from './push'

const ROUTE = '/me/push-registrations'
const WEB_KEY = 'BExampleVapidPublicKey_base64url'

/** A browser subscription with fresh keys at `endpoint`. */
const subscription = (
  endpoint = 'https://fcm.googleapis.com/fcm/send/abc:def'
): { endpoint: string; keys: { p256dh: string; auth: string } } => ({
  endpoint,
  keys: {
    p256dh: Buffer.concat([Buffer.from([4]), randomBytes(64)]).toString(
      'base64url'
    ),
    auth: randomBytes(16).toString('base64url')
  }
})

/** A transport for every platform that records what it was given. */
function recording(
  answer: (to: PushAddress) => PushResult = () => ({
    status: 'sent'
  })
): { transports: PushTransports; sent: Array<[string, PushMessage]> } {
  const sent: Array<[string, PushMessage]> = []
  const transport = {
    send: async (to: PushAddress, message: PushMessage) => {
      sent.push([to.id, message])
      return answer(to)
    }
  }
  return {
    transports: { ios: transport, android: transport, web: transport },
    sent
  }
}

const alert: PushMessage = {
  platform: 'ios',
  pushType: 'alert',
  priority: 10,
  payload: { aps: { alert: { body: 'Hello' } } }
}
const anyMessage = (to: PushAddress): PushMessage =>
  to.platform === 'ios'
    ? alert
    : to.platform === 'android'
      ? { platform: 'android', priority: 'high', data: { t: 'event' } }
      : { platform: 'web', payload: '{"t":"event"}' }

describe('push registrations', function () {
  this.timeout(60000)
  let h: AccountHarness
  let db: Kysely<Database>
  const P1 = userIdOfGumbo(101)
  const P2 = userIdOfGumbo(102)

  before(async () => {
    h = await accountHarness(undefined, undefined, '127.0.0.1', (app, f) => {
      app.use('/api/v1', pushRoutes(f.db, { webPushKey: WEB_KEY }))
      app.use(
        '/api/v1/without-web-push',
        pushRoutes(f.db, { webPushKey: null })
      )
    })
    db = h.db
  })
  beforeEach(async () => {
    await db.deleteFrom('push_registrations').execute()
  })
  after(async () => {
    await h?.close()
  })

  const register = async (
    body: unknown,
    user: number | string | null = 101
  ): Promise<Response> => await h.request('POST', ROUTE, body, user)
  const registered = async (
    body: unknown,
    user: number | string = 101
  ): Promise<string> => {
    const response = await register(body, user)
    expect(response.status, await response.clone().text()).equals(200)
    return ((await response.json()) as { id: string }).id
  }
  interface Row {
    id: string
    userId: string
    platform: string
    addressKey: string
    address: string
    environment: string
    tokenHash: string
  }
  const rows = async (): Promise<Row[]> =>
    await db
      .selectFrom('push_registrations')
      .innerJoin(
        'auth_sessions',
        'auth_sessions.id',
        'push_registrations.session_id'
      )
      .select([
        'push_registrations.id as id',
        'push_registrations.user_id as userId',
        'push_registrations.platform as platform',
        'push_registrations.address_key as addressKey',
        'push_registrations.address as address',
        'push_registrations.environment as environment',
        'auth_sessions.token_hash as tokenHash'
      ])
      .orderBy('push_registrations.id')
      .execute()

  it('registers a phone’s token under the posting session', async function () {
    const token = '00ab'.repeat(16)
    const id = await registered({
      platform: 'ios',
      address: token,
      environment: 'development'
    })
    expect(id.startsWith('psh_')).equals(true)
    expect(await rows()).deep.equals([
      {
        id,
        userId: P1,
        platform: 'ios',
        addressKey: token,
        address: token,
        environment: 'development',
        tokenHash: hashToken(h.tokens.get(101)!)
      }
    ])
    // Android says no environment: production.
    const android = await registered({
      platform: 'android',
      address: 'fcm-token:APA91b-example_token'
    })
    const row = (await rows()).find(item => item.id === android)
    expect(row?.environment).equals('production')
  })

  it('moves a token posted again to the posting session and person', async function () {
    const token = 'debug-00000000-0000-4000-8000-000000000001'
    const first = await registered({ platform: 'android', address: token })
    const again = await registered({ platform: 'android', address: token }, 102)
    expect(again).equals(first)
    expect(await rows()).deep.equals([
      {
        id: first,
        userId: P2,
        platform: 'android',
        addressKey: token,
        address: token,
        environment: 'production',
        tokenHash: hashToken(h.tokens.get(102)!)
      }
    ])
    // The same token on another platform is another registration.
    const ios = await registered({ platform: 'ios', address: token })
    expect(ios).not.equals(first)
  })

  it('keeps one row for a web subscription re-posted with new keys', async function () {
    const first = subscription()
    const id = await registered({ platform: 'web', address: first })
    expect((await rows())[0].addressKey).equals(first.endpoint)
    expect(JSON.parse((await rows())[0].address)).deep.equals(first)

    // As JSON text this time, fields in another order, the keys rotated.
    const rotated = subscription()
    const text = JSON.stringify({
      keys: { auth: rotated.keys.auth, p256dh: rotated.keys.p256dh },
      expirationTime: null,
      endpoint: rotated.endpoint
    })
    expect(await registered({ platform: 'web', address: text }, 102)).equals(id)
    const [row] = await rows()
    expect(row.userId).equals(P2)
    expect(row.addressKey).equals(rotated.endpoint)
    expect(row.address).equals(JSON.stringify(rotated))

    // Another endpoint is another browser.
    const other = await registered({
      platform: 'web',
      address: subscription(
        'https://updates.push.services.mozilla.com/wpush/v2/x'
      )
    })
    expect(other).not.equals(id)
    expect(await rows()).length(2)
  })

  it('refuses an address it cannot post to, and stores nothing', async function () {
    const good = subscription()
    const bodies: unknown[] = [
      { platform: 'blackberry', address: '00ab'.repeat(16) },
      { platform: 'ios', address: 'short' },
      { platform: 'ios', address: 'spaces are not a token' },
      { platform: 'android', address: 42 },
      { platform: 'ios', address: '00ab'.repeat(16), environment: 'staging' },
      { platform: 'web', address: 'not json' },
      {
        platform: 'web',
        address: { ...good, endpoint: 'http://fcm.googleapis.com/x' }
      },
      {
        platform: 'web',
        address: { ...good, endpoint: 'https://push.example.test/x' }
      },
      {
        platform: 'web',
        address: { ...good, endpoint: 'https://fcm.googleapis.com:8443/x' }
      },
      { platform: 'web', address: { ...good, endpoint: 'not a url' } },
      {
        platform: 'web',
        address: { ...good, keys: { ...good.keys, auth: 'AAAA' } }
      },
      {
        platform: 'web',
        address: {
          ...good,
          keys: {
            ...good.keys,
            p256dh: randomBytes(65).fill(1, 0, 1).toString('base64url')
          }
        }
      },
      {
        platform: 'web',
        address: { ...good, keys: { ...good.keys, auth: '!!!' } }
      },
      'ios'
    ]
    for (const body of bodies)
      expect((await register(body)).status, JSON.stringify(body)).equals(400)
    expect(await rows()).deep.equals([])
  })

  it('is for a signed-in session only: never anonymous, an API key or Tess', async function () {
    const body = { platform: 'ios', address: '00ab'.repeat(16) }
    expect((await register(body, null)).status).equals(401)
    expect(
      (await h.request('GET', '/push/web-key', undefined, null)).status
    ).equals(401)
    await db
      .insertInto('user_api_keys')
      .values({
        id: makeId('userApiKey'),
        user_id: P1,
        name: 'Push key',
        token_hash: hashToken('tsk_push_registrations'),
        secret_sealed: 'v1.unused',
        permissions: ['account:read', 'account:write']
      })
      .execute()
    expect((await register(body, 'tsk_push_registrations')).status).equals(403)
    expect(
      (
        await h.request(
          'GET',
          '/push/web-key',
          undefined,
          'tsk_push_registrations'
        )
      ).status
    ).equals(403)
    const viaTess = await fetch(`${h.origin}/api/v1${ROUTE}`, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${h.tokens.get(101)!}`,
        'content-type': 'application/json',
        [TESS_HEADER]: '1'
      },
      body: JSON.stringify(body)
    })
    expect(viaTess.status).equals(403)
    expect(
      ((await viaTess.json()) as { details?: unknown }).details
    ).deep.equals({
      reason: 'sessionRequired'
    })
    expect(await rows()).deep.equals([])
  })

  it('hands browsers the VAPID key, or 404 while Web Push is off', async function () {
    const on = await h.request('GET', '/push/web-key')
    expect(on.status).equals(200)
    expect(await on.json()).deep.equals({ publicKey: WEB_KEY })
    const off = await h.request('GET', '/without-web-push/push/web-key')
    expect(off.status).equals(404)
  })

  it('deletes one of the caller’s own, and only theirs', async function () {
    const mine = await registered({
      platform: 'ios',
      address: '00ab'.repeat(16)
    })
    const theirs = await registered(
      { platform: 'ios', address: '00cd'.repeat(16) },
      102
    )
    expect((await h.request('DELETE', `${ROUTE}/${theirs}`)).status).equals(404)
    expect((await h.request('DELETE', `${ROUTE}/psh_missing`)).status).equals(
      404
    )
    expect((await h.request('DELETE', `${ROUTE}/${mine}`)).status).equals(204)
    expect((await rows()).map(row => row.id)).deep.equals([theirs])
  })

  it('keeps a person’s newest registrations, pushing out the least recently posted', async function () {
    const tokens = Array.from(
      { length: MAX_REGISTRATIONS_PER_USER },
      (_, i) => `fcm-token:cap-${String(i).padStart(2, '0')}`
    )
    const ids: string[] = []
    for (const token of tokens)
      ids.push(await registered({ platform: 'android', address: token }))
    // Posted a minute apart, the first longest ago.
    for (const [i, id] of ids.entries())
      await db
        .updateTable('push_registrations')
        .set({ seen_at: new Date(Date.now() - (ids.length - i) * 60_000) })
        .where('id', '=', id)
        .execute()
    const theirs = await registered(
      { platform: 'ios', address: '00cd'.repeat(16) },
      102
    )
    // The first posted again is the newest now; the second is the oldest.
    expect(
      await registered({ platform: 'android', address: tokens[0] })
    ).equals(ids[0])
    const added = await registered({
      platform: 'web',
      address: subscription('https://fcm.googleapis.com/fcm/send/cap')
    })
    const kept = (await rows()).filter(row => row.userId === P1)
    expect(kept).length(MAX_REGISTRATIONS_PER_USER)
    expect(kept.map(row => row.id).sort()).deep.equals(
      [...ids.filter(id => id !== ids[1]), added].sort()
    )
    // Somebody else's are not counted against them.
    expect((await rows()).map(row => row.id)).includes(theirs)
  })

  describe('delivery', function () {
    it('sends nothing more to an address refused for good, until the device posts it again', async function () {
      const token = '00ef'.repeat(16)
      const refused = await registered({
        platform: 'ios',
        address: token,
        environment: 'production'
      })
      const good = await registered({
        platform: 'android',
        address: 'fcm-token:good'
      })
      const lines: string[] = []
      const { transports, sent } = recording(to =>
        to.id === refused
          ? {
              status: 'rejected',
              reason: 'BadDeviceToken for a production token'
            }
          : { status: 'sent' }
      )
      const send = async (): Promise<unknown> =>
        await sendPush(db, [P1], anyMessage, transports, line =>
          lines.push(line)
        )
      expect(await send()).deep.equals({
        sent: 1,
        skipped: 0,
        failed: 0,
        rejected: 1,
        removed: 0,
        unreached: []
      })
      // Kept, with its environment, for whoever reads the log; but marked.
      expect((await rows()).map(row => row.id).sort()).deep.equals(
        [refused, good].sort()
      )
      expect(lines).deep.equals([
        `push: ios ${refused} rejected: BadDeviceToken for a production token`
      ])
      const marked = await db
        .selectFrom('push_registrations')
        .select('rejected_at')
        .where('id', '=', refused)
        .executeTakeFirstOrThrow()
      expect(marked.rejected_at).instanceOf(Date)
      expect((await liveRegistrations(db, [P1])).map(to => to.id)).deep.equals([
        good
      ])

      // The next message goes to the good device alone.
      sent.length = 0
      expect(await send()).to.include({ sent: 1, rejected: 0 })
      expect(sent.map(([id]) => id)).deep.equals([good])

      // Posted again (a build for the other environment): sent to again.
      expect(
        await registered({
          platform: 'ios',
          address: token,
          environment: 'development'
        })
      ).equals(refused)
      expect(
        (await liveRegistrations(db, [P1])).map(to => to.id).sort()
      ).deep.equals([refused, good].sort())
    })

    it('reaches only devices whose sessions are live', async function () {
      const kept = await registered({
        platform: 'ios',
        address: '00ab'.repeat(16)
      })
      const revokedSession = await createSession(db, P1, 'push-revoked')
      const revoked = await registered(
        { platform: 'android', address: 'fcm-token:revoked-device' },
        revokedSession.token
      )
      const expiredSession = await createSession(db, P1, 'push-expired')
      const expired = await registered(
        { platform: 'web', address: subscription() },
        expiredSession.token
      )
      const other = await registered(
        { platform: 'ios', address: '00cd'.repeat(16) },
        102
      )
      const live = async (): Promise<string[]> =>
        (await liveRegistrations(db, [P1])).map(row => row.id).sort()
      expect(await live()).deep.equals([kept, revoked, expired].sort())

      await db
        .updateTable('auth_sessions')
        .set({ revoked_at: new Date() })
        .where('token_hash', '=', hashToken(revokedSession.token))
        .execute()
      await db
        .updateTable('auth_sessions')
        .set({ expires_at: new Date(Date.now() - 1000) })
        .where('token_hash', '=', hashToken(expiredSession.token))
        .execute()
      expect(await live()).deep.equals([kept])

      const { transports, sent } = recording()
      const report = await sendPush(db, [P1, P2], anyMessage, transports)
      expect(report).deep.equals({
        sent: 2,
        skipped: 0,
        failed: 0,
        rejected: 0,
        removed: 0,
        unreached: []
      })
      expect(sent.map(([id]) => id).sort()).deep.equals([kept, other].sort())
      // The ended sessions' rows are kept, not pruned.
      expect(await rows()).length(4)
      expect(await liveRegistrations(db, [])).deep.equals([])
    })

    it('goes when its session is deleted', async function () {
      const session = await createSession(db, P1, 'push-deleted')
      await registered(
        { platform: 'ios', address: '00ef'.repeat(16) },
        session.token
      )
      await db
        .deleteFrom('auth_sessions')
        .where('token_hash', '=', hashToken(session.token))
        .execute()
      expect(await rows()).deep.equals([])
    })

    it('prunes a gone address, counts failures, and skips what it cannot send', async function () {
      const gone = await registered({
        platform: 'web',
        address: subscription()
      })
      const failing = await registered({
        platform: 'android',
        address: 'fcm-token:failing'
      })
      const throwing = await registered({
        platform: 'android',
        address: 'fcm-token:throwing'
      })
      const quiet = await registered({
        platform: 'ios',
        address: '00ab'.repeat(16)
      })
      const lines: string[] = []
      const { transports, sent } = recording(to => {
        if (to.id === gone) return { status: 'gone', reason: 'HTTP 410' }
        if (to.id === failing) return { status: 'failed', reason: 'HTTP 500' }
        if (to.id === throwing) throw new Error('boom')
        return { status: 'sent' }
      })
      const report = await sendPush(
        db,
        [P1],
        to => (to.id === quiet ? null : anyMessage(to)),
        transports,
        line => lines.push(line)
      )
      expect(report).deep.equals({
        sent: 0,
        skipped: 1,
        failed: 2,
        rejected: 0,
        removed: 1,
        unreached: []
      })
      expect(sent.map(([id]) => id).sort()).deep.equals(
        [gone, failing, throwing].sort()
      )
      expect((await rows()).map(row => row.id).sort()).deep.equals(
        [failing, throwing, quiet].sort()
      )
      expect(lines.sort()).deep.equals(
        [
          `push: android ${failing} failed: HTTP 500`,
          `push: android ${throwing} threw: Error: boom`,
          `push: web ${gone} gone: HTTP 410`
        ].sort()
      )
    })

    it('counts a person whose only send threw as unreached', async function () {
      const throwing = await registered({
        platform: 'android',
        address: 'fcm-token:only-throwing'
      })
      const lines: string[] = []
      const { transports } = recording(() => {
        throw new Error('the socket closed')
      })
      expect(
        await sendPush(db, [P1], anyMessage, transports, line =>
          lines.push(line)
        )
      ).deep.equals({
        sent: 0,
        skipped: 0,
        failed: 1,
        rejected: 0,
        removed: 0,
        unreached: [P1]
      })
      expect(lines).deep.equals([
        `push: android ${throwing} threw: Error: the socket closed`
      ])
    })

    it('names the people only failures kept it from', async function () {
      const failing = await registered({
        platform: 'android',
        address: 'fcm-token:p1-failing'
      })
      const alsoFailing = await registered({
        platform: 'web',
        address: subscription('https://fcm.googleapis.com/fcm/send/p1')
      })
      const p2Failing = await registered(
        { platform: 'android', address: 'fcm-token:p2-failing' },
        102
      )
      await registered({ platform: 'ios', address: '00ab'.repeat(16) }, 102)
      const { transports } = recording(to =>
        [failing, alsoFailing, p2Failing].includes(to.id)
          ? { status: 'failed', reason: 'HTTP 503' }
          : { status: 'sent' }
      )
      const report = await sendPush(
        db,
        [P1, P2],
        anyMessage,
        transports,
        () => undefined
      )
      // P2's phone was sent to though their other device failed.
      expect(report).deep.equals({
        sent: 1,
        skipped: 0,
        failed: 3,
        rejected: 0,
        removed: 0,
        unreached: [P1]
      })
    })

    it('skips a platform with no transport, or a message for another platform', async function () {
      const ios = await registered({
        platform: 'ios',
        address: '00ab'.repeat(16)
      })
      const android = await registered({
        platform: 'android',
        address: 'fcm-token:skip'
      })
      await registered({ platform: 'web', address: subscription() })
      const { transports, sent } = recording()
      const report = await sendPush(
        db,
        [P1],
        to => (to.id === android ? alert : anyMessage(to)),
        { ios: transports.ios }
      )
      expect(report).deep.equals({
        sent: 1,
        skipped: 2,
        failed: 0,
        rejected: 0,
        removed: 0,
        unreached: []
      })
      expect(sent.map(([id]) => id)).deep.equals([ios])
    })

    it('keeps an address registered again while the old one was being sent', async function () {
      const token = 'fcm-token:moved'
      const id = await registered({ platform: 'android', address: token })
      const { transports } = recording(() => ({
        status: 'gone',
        reason: 'UNREGISTERED'
      }))
      const report = await sendPush(
        db,
        [P1],
        anyMessage,
        {
          android: {
            send: async (to, message) => {
              // The device posts its subscription again, now as another address.
              await db
                .updateTable('push_registrations')
                .set({ address: 'fcm-token:moved-again' })
                .where('id', '=', id)
                .execute()
              return await transports.android!.send(to, message)
            }
          }
        },
        () => undefined
      )
      expect(report).deep.equals({
        sent: 0,
        skipped: 0,
        failed: 0,
        rejected: 0,
        removed: 0,
        unreached: []
      })
      expect((await rows()).map(row => row.id)).deep.equals([id])
    })

    it('never throws when the database cannot be read, and counts everybody unreached', async function () {
      const lines: string[] = []
      const broken = {
        selectFrom: () => {
          throw new Error('no database')
        }
      } as unknown as Kysely<Database>
      expect(
        await sendPush(broken, [P1, P1], anyMessage, {}, line =>
          lines.push(line)
        )
      ).deep.equals({
        sent: 0,
        skipped: 0,
        failed: 0,
        rejected: 0,
        removed: 0,
        unreached: [P1]
      })
      expect(lines).deep.equals([
        'push: reading registrations failed: Error: no database'
      ])
    })
  })
})
