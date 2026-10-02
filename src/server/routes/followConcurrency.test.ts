import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import {
  dropScratchDatabase,
  testDatabaseUrl
} from '../../migrate/testDatabase'
import { type Database, makeDatabase } from '../db/database'
import type { MediaContext } from '../media/mediaContext'
import { sendError } from '../middleware/withErrors'
import { followRoutes } from './follows'
import { groupRoutes } from './groups'

/** Real legacy/public routes, held after their first table write to expose lock order. */
describe('concurrent public and legacy team-follow APIs', function () {
  this.timeout(30000)
  const name = `teamstation_follow_concurrency_${Date.now()}`
  const person = mintUserId(() => false)
  const teamId = 'tem_follow_concurrency'
  const barrier = 570031
  let admin: Pool
  let pool: Pool
  let db: Kysely<Database>
  let server: ReturnType<express.Express['listen']>
  let url: string
  const errors: string[] = []
  const media: MediaContext = {
    mediaRoot: '/tmp',
    ffmpegPath: '/usr/bin/ffmpeg',
    mediaSecret: 'fixture',
    publicUrl: 'http://127.0.0.1',
    space: {
      endpoint: '',
      region: '',
      bucket: '',
      accessKeyId: '',
      secretAccessKey: ''
    }
  }
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    const connection = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    pool = new Pool({ connectionString: connection })
    await migrateUp(pool, migrations)
    await pool.query(
      'insert into users (id, "legacyId", display_name, password_hash) values ($1, $2, $3, $4)',
      [person.userId, person.legacyId, 'Example Follower', 'fixture']
    )
    await pool.query('insert into teams (id, name) values ($1, $2)', [
      teamId,
      'Example Team'
    ])
    await pool.query(`create function follow_test_barrier() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(${barrier}); return null; end $$;
      create trigger aaa_follow_test_barrier after insert or delete on follows for each row execute function follow_test_barrier();
      create trigger aaa_follow_test_barrier after insert or delete on team_follows for each row execute function follow_test_barrier();`)
    db = makeDatabase(connection)
    const app = express()
    app.use((req, _res, next) => {
      req.actor = { userId: person.userId, isAdmin: false, scopes: [] }
      next()
    })
    app.use('/api/v1', groupRoutes(db, media))
    app.use('/api/v1', followRoutes(db, media))
    app.use(
      (
        error: unknown,
        _req: express.Request,
        res: express.Response,
        _next: express.NextFunction
      ) => {
        const code = (error as { code?: unknown }).code
        errors.push(typeof code === 'string' ? code : 'unknown')
        sendError(res, error)
      }
    )
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    const address = server.address()
    if (address == null || typeof address === 'string')
      throw Error('Missing test listener')
    url = `http://127.0.0.1:${address.port}/api/v1`
  })
  after(async () => {
    if (server != null)
      await new Promise<void>((resolve, reject) =>
        server.close(e => {
          e == null ? resolve() : reject(e)
        })
      )
    await db?.destroy()
    await pool?.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })
  async function waitFor(
    predicate: (locks: Array<{ locktype: string }>) => boolean
  ): Promise<void> {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const locks = (
        await pool.query(
          'select l.locktype from pg_locks l join pg_stat_activity a on a.pid=l.pid where a.datname=$1 and not l.granted',
          [name]
        )
      ).rows
      if (predicate(locks)) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw Error(
      'The real API requests did not reach the measured lock boundary'
    )
  }
  async function paired(method: 'PUT' | 'DELETE'): Promise<void> {
    const gate = await pool.connect()
    let first: Promise<Response> | undefined
    let second: Promise<Response> | undefined
    try {
      await gate.query('select pg_advisory_lock($1)', [barrier])
      first = fetch(`${url}/me/follows/team/${teamId}`, { method })
      await waitFor(locks => locks.some(l => l.locktype === 'advisory'))
      second = fetch(`${url}/teams/${teamId}/follow`, { method })
      // Opposite first tables reach two advisory waits; canonical writers wait
      // on the same row instead. Releasing either observed state tests both.
      await waitFor(locks => locks.length >= 2)
    } finally {
      await gate.query('select pg_advisory_unlock($1)', [barrier])
      gate.release()
    }
    if (first == null || second == null)
      throw Error('Both API calls are required')
    const responses = await Promise.all([first, second])
    console.log(
      JSON.stringify({
        method,
        responseStatuses: responses.map(r => r.status),
        sqlStates: errors
      })
    )
    expect(responses.map(r => r.status)).deep.equals([200, 200])
    expect(errors).not.includes('40P01')
    const canonical = (
      await pool.query(
        'select count(*)::int as n from follows where user_id=$1 and group_type=$2 and group_id=$3',
        [person.userId, 'team', teamId]
      )
    ).rows[0].n
    const legacy = (
      await pool.query(
        'select count(*)::int as n from team_follows where user_id=$1 and team_id=$2',
        [person.userId, teamId]
      )
    ).rows[0].n
    expect(canonical).equals(method === 'PUT' ? 1 : 0)
    expect(legacy).equals(canonical)
  }
  it('serializes concurrent follow requests from both real API paths', async () => {
    await paired('PUT')
  })
  it('serializes concurrent unfollow requests from both real API paths', async () => {
    await paired('DELETE')
  })
})
