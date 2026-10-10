import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import path from 'node:path'

import express from 'express'
import type { Kysely } from 'kysely'
import { Pool } from 'pg'

import { makeId } from '../common/ids'
import { migrations } from '../migrate/migrations'
import { migrateUp } from '../migrate/runner'
import { testDatabaseUrl } from '../migrate/testDatabase'
import { createSession } from '../server/auth/sessions'
import { makeToken } from '../server/auth/tokens'
import type { Database } from '../server/db/database'
import { makeDatabase } from '../server/db/database'
import { jsonBody } from '../server/jsonBody'
import type { MediaContext } from '../server/media/mediaContext'
import type { SpaceSettings } from '../server/media/spacesHls'
import { withAudit } from '../server/middleware/withAudit'
import { withActor } from '../server/middleware/withAuth'
import { errorHandler } from '../server/middleware/withErrors'
import { accountRoutes } from '../server/routes/account'
import { authRoutes } from '../server/routes/auth'
import { meRoutes } from '../server/routes/me'
import { playerRoutes } from '../server/routes/players'
import { teamRoutes } from '../server/routes/teams'
import { traceHttp } from './httpTrace'

/**
 * More routes for one fixture, mounted after every API route the harness
 * mounts itself and before the web app's catch-all, so a path they answer is
 * never handed `index.html`.
 */
export type MountExtra = (
  app: express.Express,
  fixture: { db: Kysely<Database>; media: MediaContext }
) => void

/** Real DB, real routes, real image uploads; external mail and S3 terminate locally. */
export async function accountHarness(
  webRoot?: string,
  configure?: (
    app: express.Express,
    fixture: {
      tokens: Map<number, string>
      db: Kysely<Database>
      space: SpaceSettings
      media: {
        space: SpaceSettings
        ffmpegPath: string
        mediaRoot: string
        mediaSecret: string
        publicUrl: string
      }
      sendCode: (email: string, code: string) => Promise<void>
    }
  ) => void,
  bindHost = '127.0.0.1',
  mountExtra?: MountExtra
): Promise<AccountHarness> {
  const name = `account_test_${Date.now()}_${Math.floor(Math.random() * 100000)}`
  const admin = new Pool({ connectionString: testDatabaseUrl })
  // Deliberately fail, never skip: this feature's coverage needs PostgreSQL.
  await admin.query(`create database ${name}`)
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  const pool = new Pool({ connectionString: url })
  await migrateUp(pool, migrations)
  await pool.end()
  const db = makeDatabase(url)
  for (const [id, label] of [
    [101, 'Babe Ruth'],
    [102, 'Lou Gehrig']
  ] as const) {
    await db
      .insertInto('users')
      .values({
        id,
        legacyId: `usr_account_${id}`,
        display_name: label,
        login_enabled: true,
        first_name: label.split(' ')[0],
        last_name: label.split(' ')[1]
      })
      .execute()
    await db
      .insertInto('user_emails')
      .values({
        id: `email_${id}`,
        user_id: id,
        email: id === 101 ? 'alex@example.com' : 'casey@example.com',
        is_primary: true,
        verified_at: new Date(),
        source: 'manual'
      })
      .execute()
  }
  await db
    .insertInto('teams')
    .values({ id: 'tem_account', name: 'Demo Hawks' })
    .execute()
  await db
    .insertInto('memberships')
    .values({
      id: makeId('membership'),
      user_id: 101,
      team_id: 'tem_account',
      role: 'member',
      is_player: true
    })
    .execute()
  const tokens = new Map<number, string>()
  for (const id of [101, 102])
    tokens.set(id, (await createSession(db, id, 'account-test')).token)
  const controls = { failMail: false, failPut: false }
  const objects = new Map<string, Buffer>()
  const objectServer = createServer((req, res) => {
    const key = new URL(req.url ?? '/', 'http://localhost').pathname
    if (req.method === 'PUT') {
      const chunks: Buffer[] = []
      req.on('data', chunk => chunks.push(Buffer.from(chunk)))
      req.on('end', () => {
        if (controls.failPut) {
          res.writeHead(503)
          res.end('Unavailable')
          return
        }
        objects.set(key, Buffer.concat(chunks))
        res.writeHead(200)
        res.end()
      })
    } else {
      const bytes = objects.get(key)
      if (bytes != null && req.headers.range === 'bytes=0-0') {
        res.writeHead(206, {
          'content-range': `bytes 0-0/${bytes.length}`,
          'content-length': '1'
        })
        res.end(bytes.subarray(0, 1))
        return
      }
      res.writeHead(bytes == null ? 404 : 200, { 'content-type': 'image/png' })
      res.end(bytes)
    }
  })
  objectServer.listen(0, bindHost)
  await new Promise<void>(resolve => objectServer.once('listening', resolve))
  const space = {
    endpoint: `http://${bindHost}:${(objectServer.address() as AddressInfo).port}`,
    region: 'test',
    bucket: 'account-test',
    accessKeyId: 'test-key',
    secretAccessKey: makeToken(),
    pathStyle: true
  }
  const mail = new Map<string, string>()
  const links = new Map<string, string>()
  const invitations = new Map<string, object>()
  const sendCode = async (
    email: string,
    code: string,
    link?: string
  ): Promise<void> => {
    if (controls.failMail) throw new Error('Test mail failure')
    mail.set(email, code)
    if (link != null) links.set(email, link)
  }
  const media = {
    space,
    ffmpegPath: process.env.TS_FFMPEG ?? 'ffmpeg',
    mediaRoot: '.',
    mediaSecret: makeToken(),
    publicUrl: ''
  }
  const app = express()
  app.use(withActor(db))
  app.use(jsonBody)
  app.use(withAudit(db))
  configure?.(app, { tokens, db, space, media, sendCode })
  app.use('/api/v1', accountRoutes(db, { ...media, sendCode }))
  app.use(
    '/api/v1',
    authRoutes(db, { space, sendCode, publicUrl: 'http://localhost' })
  )
  app.use('/api/v1', meRoutes(db))
  app.use('/api/v1', teamRoutes(db, media))
  app.use('/api/v1', playerRoutes(db, media))
  mountExtra?.(app, { db, media })
  if (webRoot != null) {
    app.get('/api/v1/health', (_req, res) => {
      res.json({ ok: true, version: 'test', dictation: false })
    })
    app.use(express.static(webRoot, { dotfiles: 'allow' }))
    app.get('/{*path}', (_req, res) => {
      res.sendFile(path.join(webRoot, 'index.html'), { dotfiles: 'allow' })
    })
  }
  app.use(errorHandler)
  const server = app.listen(0, bindHost)
  await new Promise<void>(resolve => server.once('listening', resolve))
  const origin = `http://${bindHost}:${(server.address() as AddressInfo).port}`
  return {
    db,
    mail,
    links,
    invitations,
    space,
    objects,
    controls,
    origin,
    tokens,
    async request(
      method: string,
      route: string,
      body?: unknown,
      user: number | string | null = 101
    ): Promise<Response> {
      const token = typeof user === 'number' ? tokens.get(user) : user
      const response = await fetch(`${origin}/api/v1${route}`, {
        method,
        headers: {
          ...(token == null ? {} : { authorization: `Bearer ${token}` }),
          ...(body === undefined ? {} : { 'content-type': 'application/json' })
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) })
      })
      await traceHttp(method, route, body, response)
      return response
    },
    async resetLimits(): Promise<void> {
      await db.deleteFrom('rate_events').execute()
    },
    async close(): Promise<void> {
      await new Promise<void>((resolve, reject) =>
        server.close(error => {
          error == null ? resolve() : reject(error)
        })
      )
      await new Promise<void>((resolve, reject) =>
        objectServer.close(error => {
          error == null ? resolve() : reject(error)
        })
      )
      await db.destroy()
      await admin.query(`drop database ${name}`)
      await admin.end()
    }
  }
}
export interface AccountHarness {
  db: Kysely<Database>
  mail: Map<string, string>
  links: Map<string, string>
  /** Each address's last invitation mail that says more than a link. */
  invitations: Map<string, object>
  space: SpaceSettings
  objects: Map<string, Buffer>
  controls: { failMail: boolean; failPut: boolean }
  origin: string
  tokens: Map<number, string>
  request: (
    method: string,
    route: string,
    body?: unknown,
    user?: number | string | null
  ) => Promise<Response>
  resetLimits: () => Promise<void>
  close: () => Promise<void>
}
export const accountTestPicture = {
  contentType: 'image/webp',
  base64: 'UklGRhwAAABXRUJQVlA4TBAAAAAvD8ADAAcQ/etf/wMR0f8A'
}
