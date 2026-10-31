import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import express from 'express'
import { Pool } from 'pg'

import { migrations } from '../../src/migrate/migrations'
import { migrateUp } from '../../src/migrate/runner'
import {
  dropScratchDatabase,
  testDatabaseUrl
} from '../../src/migrate/testDatabase'
import { jsonBody } from '../../src/server/jsonBody'
import { withActor } from '../../src/server/middleware/withAuth'
import { errorHandler } from '../../src/server/middleware/withErrors'
import { eventRoutes } from '../../src/server/routes/events'
import { liveRoutes } from '../../src/server/routes/live'
import { meRoutes } from '../../src/server/routes/me'
import { asServerConfig } from '../../src/server/serverConfigSchema'
import {
  attachGameSocket,
  type GameSocketHandle
} from '../../src/server/socket/gameSocket'
import { type LoadDatabase, openLoadDatabase } from './database'

/** A scratch database for this tool's tests: migrated, and marked or not. */
export interface Scratch {
  url: string
  name: string
  db: LoadDatabase
  drop: () => Promise<void>
}

let scratches = 0

export async function openScratch(
  label: string,
  marked = true
): Promise<Scratch> {
  scratches += 1
  const name = `teamstation_dbload_${label}_${Date.now()}_${process.pid}_${scratches}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  const admin = new Pool({ connectionString: testDatabaseUrl })
  await admin.query(`create database ${name}`)
  if (marked) await admin.query(`comment on database ${name} is 'dbload-local'`)
  const pool = new Pool({ connectionString: url })
  await migrateUp(pool, migrations)
  await pool.end()
  const db = openLoadDatabase(url)
  return {
    url,
    name,
    db,
    drop: async () => {
      await db.destroy()
      await dropScratchDatabase(admin, name, { timeoutMs: 15_000 })
      await admin.end()
    }
  }
}

export interface TestServer {
  base: string
  socket: GameSocketHandle
  close: () => Promise<void>
}

/** The real routes and the real socket, on a port of their own. */
export async function startTestServer(scratch: Scratch): Promise<TestServer> {
  const app = express()
  app.use(jsonBody)
  app.use(withActor(scratch.db))
  app.get('/api/v1/health', (_req, res) => {
    res.json({ ok: true })
  })
  app.use('/api/v1', eventRoutes(scratch.db))
  app.use(
    '/api/v1',
    liveRoutes(scratch.db, {
      live: {
        ...asServerConfig({}).live,
        enabled: true
      },
      sessionSecret: 'dbload-test-secret',
      host: '127.0.0.1'
    })
  )
  app.use('/api/v1', meRoutes(scratch.db))
  app.use(errorHandler)
  const server: Server = await new Promise(resolve => {
    const listening = app.listen(0, '127.0.0.1', () => {
      resolve(listening)
    })
  })
  const socket = attachGameSocket(server, scratch.db, scratch.url, {
    stopSignals: null
  })
  const { port } = server.address() as AddressInfo
  return {
    base: `http://127.0.0.1:${port}`,
    socket,
    close: async () => {
      await socket.close()
      await new Promise(resolve => {
        server.close(resolve)
        server.closeAllConnections()
      })
    }
  }
}

/** A table standing in for the extension, which the test cluster does not load. */
export async function fakeStatementsView(scratch: Scratch): Promise<void> {
  const pool = new Pool({ connectionString: scratch.url })
  await pool.query(`
    create table pg_stat_statements as
    select (select oid from pg_database where datname = current_database()) as dbid,
      0::bigint as queryid, 'seed'::text as query, 0::bigint as calls,
      0::float8 as total_exec_time, 0::bigint as rows`)
  await pool.end()
}
