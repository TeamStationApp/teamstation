import { rm } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import express from 'express'
import type { Kysely } from 'kysely'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import { asUserId } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import {
  dropScratchDatabase,
  testDatabaseUrl
} from '../../migrate/testDatabase'
import { addEmail } from '../auth/emails'
import { hashToken } from '../auth/tokens'
import { type Database, makeDatabase } from '../db/database'
import { type ChatSeed, chatSeed } from '../dev/chatSeed'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import type { SpaceSettings } from '../media/spacesHls'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { chatRoutes } from '../routes/chat'
import { chatAttachmentRoutes } from '../routes/chatAttachments'
import { chatEpochRoutes } from '../routes/chatEpochs'
import { chatKeyRoutes } from '../routes/chatKeys'
import { chatMessageRoutes } from '../routes/chatMessages'
import { mintUserId } from '../users/mintUserId'
import { spaceObjectStore } from './attachments'
import { drainDirty } from './reconciler'

/**
 * The chat fixture (`chatSeed`) in a scratch database on the test cluster,
 * with a session for everybody and the chat routes (and the key routes)
 * served, for the chat tests. The clock is the fixture's `now`, which a test
 * may move. Each `who` a call names is one session: a person's own key, or
 * another session made for them by `signIn` (another device).
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
  /** The API's base, `http://127.0.0.1:<port>/api/v1`. */
  api: string
  /** Where attachment parts wait. */
  uploadsDir: string
  id: (key: string) => string
  /** The seed key of a user id, or the id itself. */
  keyOf: (userId: string) => string
  call: (
    who: string,
    method: string,
    path: string,
    body?: unknown
  ) => Promise<Answer>
  /** A new session, called `who`, for the person `key`; its session id. */
  signIn: (who: string, key: string) => Promise<string>
  /** A machine token, called `who`, for the person `key`. */
  apiToken: (who: string, key: string) => Promise<void>
  /** The session id behind `who`. */
  sessionOf: (who: string) => string
  /** The bearer token `who` calls with, for a socket. */
  tokenOf: (who: string) => string
  /** Makes a person (an account unless `account: false`) with a session. */
  person: (
    key: string,
    options?: {
      account?: boolean
      birth?: { year: number; month: number }
      userId?: string
    }
  ) => Promise<string>
  /** Takes and reconciles every mark. */
  drain: () => Promise<number>
  /** The attachment object keys the message routes deleted, in order. */
  deletedObjects: string[]
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
  options: {
    now?: Date
    reconcile?: boolean
    /** The Space attachments go to (none by default); deletes reach it too. */
    space?: SpaceSettings
  } = {}
): Promise<ChatFixture | undefined> {
  const adminPool = new Pool({ connectionString: testDatabaseUrl })
  try {
    await adminPool.query('select 1')
  } catch (error) {
    await adminPool.end()
    if (process.env.TS_TEST_DATABASE_URL != null) throw error
    return undefined
  }
  const name = `teamstation_chat_${label}_${Date.now()}_${process.pid}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  await adminPool.query(`create database ${name}`)
  const pool = new Pool({ connectionString: url })
  const uploadsDir = join(tmpdir(), `${name}_uploads`)
  let closeDatabase = async (): Promise<void> => {
    await pool.end()
  }
  let closeServer: (() => Promise<void>) | undefined
  try {
    await migrateUp(pool, migrations)
    await pool.end()
    const db = makeDatabase(url)
    closeDatabase = async () => {
      await db.destroy()
    }
    const start = options.now ?? new Date('2027-04-10T12:00:00Z')
    const seed = await chatSeed(db, { password: 'pw', now: start })

    const tokens = new Map<string, string>()
    const keys = new Map<string, string>()
    const sessions = new Map<string, string>()
    const signIn = async (
      key: string,
      userId: string,
      who = key
    ): Promise<string> => {
      const token = `tok_chat_${who}_${'0'.repeat(24)}`
      tokens.set(who, token)
      if (who === key) keys.set(userId, key)
      const at = new Date()
      const sessionId = makeId('authSession')
      sessions.set(who, sessionId)
      await db
        .insertInto('auth_sessions')
        .values({
          id: sessionId,
          user_id: userId,
          token_hash: hashToken(token),
          created_at: at,
          expires_at: new Date(at.getTime() + 3_600_000)
        })
        .execute()
      return sessionId
    }
    for (const person of Object.values(seed.people)) {
      await signIn(person.key, person.userId)
    }

    const space = options.space ?? TEST_MEDIA.space
    const store = options.space == null ? undefined : spaceObjectStore(space)
    const fixture: ChatFixture = {
      db,
      seed,
      now: start,
      url,
      api: '',
      uploadsDir,
      id: key => {
        const person = seed.people[key]
        if (person != null) return person.userId
        for (const [userId, held] of keys) if (held === key) return userId
        throw new Error(`nobody called ${key}`)
      },
      keyOf: userId => keys.get(userId) ?? String(userId),
      signIn: async (who, key) => await signIn(key, fixture.id(key), who),
      apiToken: async (who, key) => {
        const token = `tok_chat_${who}_${'1'.repeat(24)}`
        tokens.set(who, token)
        await db
          .insertInto('api_tokens')
          .values({
            id: makeId('apiToken'),
            user_id: fixture.id(key),
            label: who,
            token_hash: hashToken(token),
            created_at: new Date()
          })
          .execute()
      },
      tokenOf: who => {
        const token = tokens.get(who)
        if (token == null) throw new Error(`no token called ${who}`)
        return token
      },
      sessionOf: who => {
        const sessionId = sessions.get(who)
        if (sessionId == null) throw new Error(`no session called ${who}`)
        return sessionId
      },
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
        const minted =
          personOptions.userId == null
            ? mintUserId()
            : asUserId(personOptions.userId)
        const account = personOptions.account ?? true
        await db
          .insertInto('users')
          .values({
            id: minted,
            display_name: `${key} Person`,
            first_name: key,
            last_name: 'Person',
            password_hash: null,
            birth_year: personOptions.birth?.year ?? null,
            birth_month: personOptions.birth?.month ?? null
          })
          .execute()
        if (account) {
          await addEmail(db, minted, `${key.toLowerCase()}@extra.test`, {
            isPrimary: true,
            source: 'manual',
            verifiedAt: new Date()
          })
        }
        await signIn(key, minted)
        return minted
      },
      drain: async () => await drainDirty(db, fixture.now),
      deletedObjects: [],
      close: async () => {
        await closeServer?.()
        await db.destroy()
        await rm(uploadsDir, { recursive: true, force: true })
        await dropScratchDatabase(adminPool, name)
        await adminPool.end()
      }
    }

    const app = express()
    app.use(jsonBody)
    app.use(withActor(db))
    app.use(withAudit(db))
    app.use(
      '/api/v1',
      chatRoutes(db, { ...TEST_MEDIA, space }, () => fixture.now)
    )
    app.use(
      '/api/v1',
      chatKeyRoutes(db, () => fixture.now)
    )
    app.use(
      '/api/v1',
      chatEpochRoutes(db, () => fixture.now)
    )
    app.use(
      '/api/v1',
      chatMessageRoutes(db, TEST_MEDIA, {
        clock: () => fixture.now,
        objects: {
          deleteObjects: async keys => {
            await store?.deleteObjects(keys)
            fixture.deletedObjects.push(...keys)
          }
        }
      })
    )
    app.use(
      '/api/v1',
      chatAttachmentRoutes(db, {
        space,
        uploadsDir,
        clock: () => fixture.now
      })
    )
    app.use(errorHandler)
    const server = app.listen(0, '127.0.0.1')
    closeServer = async () => {
      await new Promise<void>((resolve, reject) =>
        server.close(error => {
          if (error != null) reject(error)
          else resolve()
        })
      )
    }
    await new Promise<void>(resolve => server.once('listening', resolve))
    const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
    fixture.api = base

    if (options.reconcile !== false) await fixture.drain()
    return fixture
  } catch (error) {
    await closeServer?.()
    await closeDatabase()
    await rm(uploadsDir, { recursive: true, force: true })
    await dropScratchDatabase(adminPool, name)
    await adminPool.end()
    throw error
  }
}
