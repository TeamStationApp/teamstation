import { type Kysely, sql } from 'kysely'
import { Client } from 'pg'
import WebSocket from 'ws'

import type { GameSocketReply } from '../common/gameSocket'
import { testDatabaseUrl } from '../migrate/testDatabase'
import type { Database } from '../server/db/database'
import {
  bumpSyncClock,
  SCREEN_SCOPES_CHANNEL,
  type ScreenScopeIds,
  type ScreenScopePayload
} from '../server/socket/syncRevision'

/**
 * Everything committed on `screen_scopes` in one test database, heard the
 * way a worker hears it: one `LISTEN` connection, payloads in commit order.
 */
export interface ScreenScopeNotices {
  heard: ScreenScopePayload[]
  /** Where the notices from now on begin. */
  mark: () => number
  /**
   * The notices since `mark`, once everything committed before this call
   * has been heard: a commit of its own is made and waited for, and Postgres
   * delivers notices in commit order.
   */
  since: (mark: number) => Promise<ScreenScopePayload[]>
  /** The first notice since `mark` with these ids, waited for. */
  named: (mark: number, ids: ScreenScopeIds) => Promise<ScreenScopePayload>
  close: () => Promise<void>
}

let sentinels = 0

/** The URL of the database `db` is connected to, on the test server. */
export async function databaseUrlOf(db: Kysely<Database>): Promise<string> {
  const { rows } = await sql<{
    name: string
  }>`select current_database() as name`.execute(db)
  return testDatabaseUrl.replace(/\/[^/]*$/, `/${rows[0].name}`)
}

export async function listenScreenScopes(
  db: Kysely<Database>
): Promise<ScreenScopeNotices> {
  const client = new Client({ connectionString: await databaseUrlOf(db) })
  await client.connect()
  const heard: ScreenScopePayload[] = []
  client.on('notification', message => {
    if (message.payload != null)
      heard.push(JSON.parse(message.payload) as ScreenScopePayload)
  })
  await client.query(`listen ${SCREEN_SCOPES_CHANNEL}`)

  const wait = async (
    found: () => ScreenScopePayload | undefined,
    what: string
  ): Promise<ScreenScopePayload> => {
    const deadline = Date.now() + 5000
    for (;;) {
      const payload = found()
      if (payload != null) return payload
      if (Date.now() > deadline)
        throw new Error(`No notice ${what} in ${JSON.stringify(heard)}`)
      await new Promise(resolve => setTimeout(resolve, 10))
    }
  }
  const matches = (payload: ScreenScopePayload, ids: ScreenScopeIds): boolean =>
    (['gameId', 'teamId', 'seasonId', 'userId'] as const).every(
      key => payload[key] === ids[key]
    )

  return {
    heard,
    mark: () => heard.length,
    since: async mark => {
      const userId = `sentinel-${process.pid}-${++sentinels}`
      await db
        .transaction()
        .execute(async trx => await bumpSyncClock(trx, { userId }))
      await wait(
        () => heard.find(payload => payload.userId === userId),
        `for ${userId}`
      )
      return heard
        .slice(mark)
        .filter(payload => payload.userId?.startsWith('sentinel-') !== true)
    },
    named: async (mark, ids) =>
      await wait(
        () => heard.slice(mark).find(payload => matches(payload, ids)),
        `naming ${JSON.stringify(ids)}`
      ),
    close: async () => {
      await client.end()
    }
  }
}

/** A raw `/socket` connection, its frames kept in the order they came. */
export interface ScopeSocket {
  frames: GameSocketReply[]
  /** Sends a request and waits for the answer to its id. */
  ask: (frame: Record<string, unknown>) => Promise<GameSocketReply>
  /** The `changed` frames since `from`. */
  changes: (from?: number) => GameSocketReply[]
  close: () => void
}

let asked = 0

export async function openScopeSocket(
  url: string,
  token: string
): Promise<ScopeSocket> {
  const ws = new WebSocket(url, {
    headers: { authorization: `Bearer ${token}` }
  })
  const frames: GameSocketReply[] = []
  ws.on('message', data => {
    frames.push(
      JSON.parse((data as Buffer).toString('utf8')) as GameSocketReply
    )
  })
  await new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      resolve()
    })
    ws.once('error', reject)
  })
  return {
    frames,
    ask: async frame => {
      const from = frames.length
      const id = `ask-${++asked}`
      ws.send(JSON.stringify({ ...frame, id }))
      const deadline = Date.now() + 3000
      for (;;) {
        const found = frames
          .slice(from)
          .find(reply => 'id' in reply && reply.id === id)
        if (found != null) return found
        if (Date.now() > deadline)
          throw new Error(`No answer to ${id} in ${JSON.stringify(frames)}`)
        await new Promise(resolve => setTimeout(resolve, 10))
      }
    },
    changes: (from = 0) =>
      frames.slice(from).filter(frame => frame.type === 'changed'),
    close: () => {
      ws.terminate()
    }
  }
}
