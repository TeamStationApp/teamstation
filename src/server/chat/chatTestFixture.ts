import type { AddressInfo } from 'node:net'

import express from 'express'
import type { Kysely } from 'kysely'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { addEmail } from '../auth/emails'
import { hashToken } from '../auth/tokens'
import { type Database, makeDatabase } from '../db/database'
import { type ChatSeed, chatSeed } from '../dev/chatSeed'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { chatRoutes } from '../routes/chat'
import { drainDirty } from './reconciler'

/**
 * The chat fixture (`chatSeed`) in a scratch database on the test cluster,
 * with a session for everybody and the chat routes served, for the M5
 * tests. The clock is the fixture's `now`, which a test may move.
 */

export interface Answer {
  status: number
  body: any
}

export interface ChatFixture {
  db: Kysely<Database>
  seed: ChatSeed
  /** What the routes and the reconciler take as now. */
  now: Date
  url: string
  id: (key: string) => number
  /** The seed key of a user id, or the id itself. */
  keyOf: (userId: number) => string
  call: (
    who: string,
    method: string,
    path: string,
    body?: unknown
  ) => Promise<Answer>
  /** Makes a person (an account unless `account: false`) with a session. */
  person: (
    key: string,
    options?: { account?: boolean; birth?: { year: number; month: number } }
  ) => Promise<number>
  /** Takes and reconciles every mark. */
  drain: () => Promise<number>
  close: () => Promise<void>
}

export const TEST_MEDIA: MediaContext = {
  mediaRoot: '/tmp',
  ffmpegPath: 'ffmpeg',
  mediaSecret: 'secret',
  publicUrl: 'http://127.0.0.1',
  space: {
    endpoint: '',
    region: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    pathStyle: true
  }
}

/** Opens the fixture, or undefined when there is no test cluster. */
export async function openChatFixture(
  label: string,
  options: { now?: Date; reconcile?: boolean } = {}
): Promise<ChatFixture | undefined> {
  const adminPool = new Pool({ connectionString: testDatabaseUrl })
  try {
    await adminPool.query('select 1')
  } catch {
    await adminPool.end()
    return undefined
  }
  const name = `teamstation_chat_${label}_${Date.now()}_${process.pid}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  await adminPool.query(`create database ${name}`)
  const pool = new Pool({ connectionString: url })
  await migrateUp(pool, migrations)
  await pool.end()
  const db = makeDatabase(url)
  const start = options.now ?? new Date('2027-04-10T12:00:00Z')
  const seed = await chatSeed(db, { password: 'pw', now: start })

  const tokens = new Map<string, string>()
  const keys = new Map<number, string>()
  const signIn = async (key: string, userId: number): Promise<void> => {
    const token = `tok_chat_${key}_${'0'.repeat(24)}`
    tokens.set(key, token)
    keys.set(userId, key)
    const at = new Date()
    await db
      .insertInto('auth_sessions')
      .values({
        id: makeId('authSession'),
        user_id: userId,
        token_hash: hashToken(token),
        created_at: at,
        expires_at: new Date(at.getTime() + 3_600_000)
      })
      .execute()
  }
  for (const person of Object.values(seed.people)) {
    await signIn(person.key, person.userId)
  }

  const fixture: ChatFixture = {
    db,
    seed,
    now: start,
    url,
    id: key => {
      const person = seed.people[key]
      if (person != null) return person.userId
      for (const [userId, held] of keys) if (held === key) return userId
      throw new Error(`nobody called ${key}`)
    },
    keyOf: userId => keys.get(userId) ?? String(userId),
    call: async (who, method, path, body) => {
      const headers: Record<string, string> = {}
      const token = tokens.get(who)
      if (token != null) headers.authorization = `Bearer ${token}`
      if (body !== undefined) headers['content-type'] = 'application/json'
      const response = await fetch(`${base}${path}`, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body)
      })
      return {
        status: response.status,
        body: await response.json().catch(() => null)
      }
    },
    person: async (key, personOptions = {}) => {
      const taken = new Set(
        (await db.selectFrom('users').select('id').execute()).map(row => row.id)
      )
      const minted = mintUserId(id => taken.has(id))
      const account = personOptions.account ?? true
      await db
        .insertInto('users')
        .values({
          id: minted.userId,
          legacyId: minted.legacyId,
          display_name: `${key} Person`,
          first_name: key,
          last_name: 'Person',
          password_hash: null,
          birth_year: personOptions.birth?.year ?? null,
          birth_month: personOptions.birth?.month ?? null
        })
        .execute()
      if (account) {
        await addEmail(db, minted.userId, `${key.toLowerCase()}@extra.test`, {
          isPrimary: true,
          source: 'manual',
          verifiedAt: new Date()
        })
      }
      await signIn(key, minted.userId)
      return minted.userId
    },
    drain: async () => await drainDirty(db, fixture.now),
    close: async () => {
      server.close()
      await db.destroy()
      await adminPool.query(`drop database if exists ${name} with (force)`)
      await adminPool.end()
    }
  }

  const app = express()
  app.use(jsonBody)
  app.use(withActor(db))
  app.use(withAudit(db))
  app.use(
    '/api/v1',
    chatRoutes(db, TEST_MEDIA, () => fixture.now)
  )
  app.use(errorHandler)
  const server = app.listen(0, '127.0.0.1')
  await new Promise<void>(resolve => server.once('listening', resolve))
  const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`

  if (options.reconcile !== false) await fixture.drain()
  return fixture
}
