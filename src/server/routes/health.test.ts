import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { TeamStationClient } from '../../common/api'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { type Database, makeDatabase } from '../db/database'
import { asServerConfig, tessSettings } from '../serverConfig'
import { healthRoutes } from './health'

describe('health', function () {
  this.timeout(30000)
  const name = `teamstation_health_${process.pid}_${Date.now()}`
  let admin: Pool
  let db: Kysely<Database>
  const servers: Server[] = []

  /** A client of a server mounting only `/health` with these options. */
  const serve = async (
    options: Parameters<typeof healthRoutes>[2],
    on: Kysely<Database> = db
  ): Promise<TeamStationClient> => {
    const app = express()
    app.use('/api/v1', healthRoutes(on, '1.2.3', options))
    const server = app.listen(0, '127.0.0.1')
    servers.push(server)
    await new Promise<void>(resolve => server.once('listening', resolve))
    return new TeamStationClient({
      baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
    })
  }

  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    db = makeDatabase(testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`))
    const pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await pool.query(`create table schema_migrations (name text primary key);
      insert into schema_migrations values ('001identity'), ('002content')`)
    await pool.end()
  })
  after(async () => {
    for (const server of servers) server.close()
    await db?.destroy()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  it('says Tess is available when the server has her key, beside the dictation fields', async () => {
    const client = await serve({
      dictation: true,
      dictationModels: ['grok-4.3', 'claude-haiku-5-5'],
      narration: true,
      tess:
        tessSettings(
          asServerConfig({
            dictation: { apiKey: 'xai-placeholder', anthropic: { apiKey: 'a' } }
          })
        ) != null
    })
    const health = await client.health()
    expect(health).deep.include({
      status: 'ok',
      version: '1.2.3',
      database: 'ok',
      migrations: 2,
      dictation: true,
      dictationModels: ['grok-4.3', 'claude-haiku-5-5'],
      narration: true,
      tess: true
    })
  })

  it('says Tess is off without a key, and by default', async () => {
    const off = await serve({
      tess: tessSettings(asServerConfig({})) != null
    })
    expect(await off.health()).deep.include({
      dictation: false,
      dictationModels: [],
      narration: false,
      tess: false
    })
    const bare = await serve(undefined)
    const health = await bare.health()
    expect(health.tess).equals(false)
    expect(health.tess === true).equals(false)
  })

  it('reads an older server without the flag as Tess unavailable', async () => {
    const older = new TeamStationClient({
      baseUrl: 'http://older.example.test/api/v1',
      fetch: async () =>
        new Response(
          JSON.stringify({
            status: 'ok',
            version: '1',
            database: 'ok',
            migrations: 3
          }),
          { status: 200, headers: { 'content-type': 'application/json' } }
        )
    })
    const health = await older.health()
    expect(health.tess).equals(undefined)
    expect(health.tess === true).equals(false)
  })

  it('still reports the flag when the database is unreachable', async () => {
    const away = makeDatabase('postgres://127.0.0.1:1/absent')
    const logged: unknown[] = []
    const error = console.error
    console.error = (...args: unknown[]) => {
      logged.push(args[0])
    }
    try {
      const client = await serve({ tess: true }, away)
      const response = await fetch(`${client.baseUrl}/health`)
      expect(response.status).equals(503)
      expect(await response.json()).deep.include({
        status: 'degraded',
        database: 'unreachable',
        migrations: 0,
        tess: true
      })
      expect(logged).deep.equals(['health: database unreachable'])
    } finally {
      console.error = error
      await away.destroy()
    }
  })
})
