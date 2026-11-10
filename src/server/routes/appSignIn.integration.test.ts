import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { authRoutes } from './auth'
import { inviteRoutes } from './invites'

/**
 * A sign-in asked for in an app, through the real routers against a real
 * database: the app names its link host, the e-mail's link goes there and
 * names this server, and a host the server does not sign in is refused before
 * anything is counted, looked up or sent.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_appsignin_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const PUBLIC_URL = 'https://gs.example'
const APP1 = 'https://app1.example.test'
const LINK =
  /^https:\/\/app1\.example\.test\/signin\/([A-Za-z0-9_-]+)\?server=https%3A%2F%2Fgs\.example$/

describe('signing in from an app', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const sent: Array<{ email: string; code: string; link?: string }> = []

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)
    await db
      .insertInto('invites')
      .values({
        id: 'inv_join',
        code: 'joinapp',
        scope_type: 'team',
        scope_id: 'tem_nowhere',
        created_by: null,
        label: null,
        max_uses: null,
        expires_at: null,
        revoked_at: null,
        created_at: new Date(),
        for_email: null,
        request_id: null
      })
      .execute()

    const app = express()
    app.use(express.json())
    app.use(withActor(db))
    app.use(withAudit(db))
    const sendCode = async (
      email: string,
      code: string,
      link?: string
    ): Promise<void> => {
      sent.push({ email, code, link })
    }
    const options = { sendCode, publicUrl: PUBLIC_URL, appOrigins: [APP1] }
    app.use('/api/v1', authRoutes(db, options))
    app.use('/api/v1', inviteRoutes(db, options))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    const address = server.address() as AddressInfo
    base = `http://127.0.0.1:${address.port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  async function post(
    path: string,
    body: unknown
  ): Promise<{ status: number; body: Record<string, unknown> }> {
    const response = await fetch(`${base}${path}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body)
    })
    const text = await response.text()
    return {
      status: response.status,
      body: text === '' ? {} : (JSON.parse(text) as Record<string, unknown>)
    }
  }

  async function appOriginOf(email: string): Promise<string | null> {
    if (db == null) throw new Error('no database')
    const row = await db
      .selectFrom('email_codes')
      .select('app_origin')
      .where('email', '=', email)
      .orderBy('created_at', 'desc')
      .executeTakeFirstOrThrow()
    return row.app_origin
  }

  it('mails a link to the app’s host that names this server', async function () {
    const asked = await post('/auth/email-code', {
      email: 'alex.lee@example.com',
      origin: 'ios',
      appOrigin: APP1
    })
    expect(asked.status).equals(202)
    const mail = sent[sent.length - 1]
    expect(mail.email).equals('alex.lee@example.com')
    expect(mail.link).match(LINK)
    expect(await appOriginOf('alex.lee@example.com')).equals(APP1)
  })

  it('refuses a host it does not sign in, and sends nothing', async function () {
    const before = sent.length
    for (const email of ['alex.lee@example.com', 'nobody@example.com']) {
      const asked = await post('/auth/email-code', {
        email,
        appOrigin: 'https://evil.example.test'
      })
      expect(asked.status).equals(400)
      expect(JSON.stringify(asked.body)).contains('appOrigin')
    }
    expect(sent.length).equals(before)
  })

  it('keeps a web sign-in’s link on this server', async function () {
    const asked = await post('/auth/email-code', {
      email: 'web.user@example.com'
    })
    expect(asked.status).equals(202)
    expect(sent[sent.length - 1].link).match(
      /^https:\/\/gs\.example\/signin\/[A-Za-z0-9_-]+$/
    )
    expect(await appOriginOf('web.user@example.com')).equals(null)
  })

  it('does the same for a sign-in through an invite', async function () {
    const asked = await post('/join/joinapp/email-code', {
      email: 'joiner@example.com',
      origin: 'android',
      appOrigin: APP1
    })
    expect(asked.status).equals(202)
    expect(sent[sent.length - 1].link).match(LINK)
    expect(await appOriginOf('joiner@example.com')).equals(APP1)

    const before = sent.length
    const refused = await post('/join/joinapp/email-code', {
      email: 'joiner@example.com',
      appOrigin: 'https://evil.example.test'
    })
    expect(refused.status).equals(400)
    expect(sent.length).equals(before)

    const web = await post('/join/joinapp/email-code', {
      email: 'joiner2@example.com'
    })
    expect(web.status).equals(202)
    expect(sent[sent.length - 1].link).match(/^https:\/\/gs\.example\/signin\//)
  })

  it('leaves the asker’s own poll waiting when it spends its link, and approves it for another device', async function () {
    const ask = async (
      email: string
    ): Promise<{ requestId: string; clientSecret: string; token: string }> => {
      const asked = await post('/auth/email-code', { email, appOrigin: APP1 })
      const { requestId, clientSecret } = asked.body as {
        requestId: string
        clientSecret: string
      }
      const token = LINK.exec(sent[sent.length - 1].link ?? '')?.[1] ?? ''
      return { requestId, clientSecret, token }
    }
    const poll = async (asked: {
      requestId: string
      clientSecret: string
    }): Promise<number> =>
      (
        await post('/auth/request/claim', {
          requestId: asked.requestId,
          clientSecret: asked.clientSecret
        })
      ).status

    // The app that asked opens the link itself, and says so.
    const own = await ask('poller@example.com')
    const spent = await post('/auth/link/verify', {
      token: own.token,
      deviceName: 'Bench iPad',
      requestId: own.requestId
    })
    expect(spent.status).equals(200)
    expect(await poll(own)).equals(202)

    // Another device's app opens it: the asker is signed in too.
    const other = await ask('poller2@example.com')
    const elsewhere = await post('/auth/link/verify', {
      token: other.token,
      deviceName: 'Second iPad'
    })
    expect(elsewhere.status).equals(200)
    expect(await poll(other)).equals(200)

    // A request id that is not this link's changes nothing.
    const third = await ask('poller3@example.com')
    await post('/auth/link/verify', {
      token: third.token,
      requestId: own.requestId
    })
    expect(await poll(third)).equals(200)
  })

  it('names an account an approved request makes with the typed name, which the code then forgets', async function () {
    if (db == null) throw new Error('no database')
    // The invite's team, so joining it can make the membership.
    await db
      .insertInto('teams')
      .values({ id: 'tem_nowhere', name: 'Demo Padres' })
      .execute()
    const asked = await post('/join/joinapp/email-code', {
      email: 'gwynn@example.com',
      displayName: 'Tony Gwynn',
      appOrigin: APP1
    })
    expect(asked.status).equals(202)
    const { requestId, clientSecret } = asked.body as {
      requestId: string
      clientSecret: string
    }
    const typedName = async (): Promise<string | null> =>
      (
        await db!
          .selectFrom('email_codes')
          .select('display_name')
          .where('id', '=', requestId)
          .executeTakeFirstOrThrow()
      ).display_name
    expect(await typedName()).equals('Tony Gwynn')

    // Opened on another device, which settles the account; the app that
    // asked then claims the approved request.
    const token = LINK.exec(sent[sent.length - 1].link ?? '')?.[1]
    const elsewhere = await post('/auth/link/verify', { token })
    expect(elsewhere.status).equals(200)
    expect(await typedName()).equals(null)
    const claimed = await post('/auth/request/claim', {
      requestId,
      clientSecret
    })
    expect(claimed.status).equals(200)
    const user = claimed.body.user as { id: string; displayName: string }
    expect(user.displayName).equals('Tony Gwynn')
    expect(user.id).equals((elsewhere.body.user as { id: string }).id)
    expect(await typedName()).equals(null)
  })

  it('gives a device that spends its link the named, long session', async function () {
    if (db == null) throw new Error('no database')
    await post('/auth/email-code', {
      email: 'device@example.com',
      appOrigin: APP1
    })
    const token = LINK.exec(sent[sent.length - 1].link ?? '')?.[1]
    expect(token).not.equals(undefined)
    const signedIn = await post('/auth/link/verify', {
      token,
      deviceName: ' Bench iPad '
    })
    expect(signedIn.status).equals(200)
    const device = await db
      .selectFrom('auth_sessions')
      .select(['device_name', 'created_at', 'expires_at'])
      .where('device_name', '=', 'Bench iPad')
      .executeTakeFirstOrThrow()
    const days =
      (new Date(device.expires_at).getTime() -
        new Date(device.created_at).getTime()) /
      86400000
    expect(Math.round(days)).equals(180)

    await post('/auth/email-code', { email: 'browser@example.com' })
    const browserToken = /\/signin\/([A-Za-z0-9_-]+)$/.exec(
      sent[sent.length - 1].link ?? ''
    )?.[1]
    const browser = await post('/auth/link/verify', { token: browserToken })
    expect(browser.status).equals(200)
    const session = await db
      .selectFrom('auth_sessions')
      .innerJoin('user_emails', 'user_emails.user_id', 'auth_sessions.user_id')
      .select([
        'auth_sessions.device_name',
        'auth_sessions.created_at',
        'auth_sessions.expires_at'
      ])
      .where('user_emails.email', '=', 'browser@example.com')
      .executeTakeFirstOrThrow()
    expect(session.device_name).equals(null)
    const browserDays =
      (new Date(session.expires_at).getTime() -
        new Date(session.created_at).getTime()) /
      86400000
    expect(Math.round(browserDays)).lessThan(180)
  })

  it('preserves the game, video and tab through email links and approved requests', async function () {
    const next = '/games/gam_example?tab=watch&video=vid_example&t=42'
    const asked = await post('/auth/email-code', {
      email: 'returning@example.com',
      next,
      appOrigin: APP1
    })
    expect(asked.status).equals(202)
    const token = LINK.exec(sent[sent.length - 1].link ?? '')?.[1]
    const signedIn = await post('/auth/link/verify', { token })
    expect(signedIn.status).equals(200)
    expect(signedIn.body.next).equals(next)
    const claimed = await post('/auth/request/claim', asked.body)
    expect(claimed.status).equals(200)
    expect(claimed.body.next).equals(next)
  })

  it('does not return an external destination after sign-in', async function () {
    await post('/auth/email-code', {
      email: 'safe-return@example.com',
      next: '//outside.example.test',
      appOrigin: APP1
    })
    const token = LINK.exec(sent[sent.length - 1].link ?? '')?.[1]
    const signedIn = await post('/auth/link/verify', { token })
    expect(signedIn.status).equals(200)
    expect(signedIn.body.next).equals(undefined)
  })
})
