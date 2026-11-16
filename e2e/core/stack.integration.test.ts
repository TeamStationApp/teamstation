import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'
import { Pool } from 'pg'

import { newStackId, projectKey, STACKS, writeStackEntry } from './attach'
import { failedStart, projectOf, pruneStacks, startStack } from './stack'

describe('a stack with a fault proxy in front of its API', function () {
  this.timeout(120000)

  it('counts each API error once, where the front server sees it', async function () {
    const stack = await startStack({ services: [], fault: 'api-500' })
    try {
      const reply = await fetch(`${stack.origin}/api/v1/anything`)
      expect(reply.status).equals(500)
      const errors = (await stack.serverErrors(0)) ?? []
      expect(errors.map(row => [row.path, row.status])).deep.equals([
        ['/api/v1/anything', 500]
      ])
    } finally {
      await stack.stop()
    }
  })
})

describe('a stack that adopts a server, with no API of its own', function () {
  this.timeout(120000)

  it('counts each of its errors once, though the front server forwards to it', async function () {
    const broken = createServer((_req, res) => {
      res.writeHead(500)
      res.end()
    })
    await new Promise<void>(resolve => broken.listen(0, '127.0.0.1', resolve))
    const { port } = broken.address() as AddressInfo
    const stack = await startStack({ services: [] })
    const front = stack.origin
    try {
      await stack.adopt(`http://127.0.0.1:${port}`)
      const reply = await fetch(`${front}/api/v1/anything`)
      expect(reply.status).equals(500)
      const errors = (await stack.serverErrors(0)) ?? []
      expect(errors.map(row => row.status)).deep.equals([500])
    } finally {
      await stack.stop()
      broken.close()
    }
  })
})

describe('a stack abandoned while it starts', function () {
  this.timeout(120000)

  const failed = async (start: Promise<unknown>): Promise<unknown> => {
    try {
      await start
    } catch (error) {
      return error
    }
    throw new Error('expected the start to fail')
  }

  it('does not start once abandoned, and stops what it started when abandoned mid-way', async function () {
    const early = newStackId('abandonEarly')
    const error = await failed(
      startStack({ id: early, services: [], signal: AbortSignal.abort() })
    )
    expect((error as Error).name).equals('AbortError')
    expect(existsSync(join(STACKS, early))).equals(false)
    // Abandoned while the API comes up: its database, process and directory go.
    const late = newStackId('abandonLate')
    const started = Date.now()
    const midway = await failed(
      startStack({
        id: late,
        services: ['api'],
        signal: AbortSignal.timeout(1000)
      })
    )
    expect((midway as Error).name).matches(/AbortError|TimeoutError/)
    expect(Date.now() - started).lessThan(30000)
    expect(existsSync(join(STACKS, late))).equals(false)
  })
})

describe('a start that fails', function () {
  it('throws why it failed, with a teardown that failed too as its cause', async function () {
    const why = new Error('Migration failed: no such table')
    let thrown: unknown
    try {
      await failedStart(why, async () => {
        throw new Error('The stack did not stop cleanly: Metro')
      })
    } catch (error) {
      thrown = error
    }
    expect(thrown).equals(why)
    expect(String((thrown as Error).cause)).includes('did not stop cleanly')
    let stopped = false
    const clean = await failedStart(new Error('API unhealthy'), async () => {
      stopped = true
    }).catch((error: unknown) => error)
    expect(String(clean)).includes('API unhealthy')
    expect(stopped).equals(true)
  })
})

describe('a stack’s name, and what a dead one leaves', function () {
  this.timeout(120000)

  const testPool = async (): Promise<Pool> =>
    new Pool({
      connectionString: (await import('../../src/migrate/testDatabase'))
        .testDatabaseUrl
    })
  const databases = async (pattern: string): Promise<string[]> => {
    const pool = await testPool()
    try {
      const { rows } = await pool.query<{ datname: string }>(
        'select datname from pg_database where datname like $1',
        [pattern]
      )
      return rows.map(row => row.datname)
    } finally {
      await pool.end()
    }
  }

  it('names a stack for its project, with a database of exactly that name', async function () {
    const stack = await startStack({ services: ['api'] })
    try {
      const project = projectKey(projectOf(process.cwd()))
      expect(stack.id).matches(new RegExp(`^${project}_[0-9a-f]{6}$`))
      expect(await databases(`e2e_${stack.id}`)).deep.equals([
        `e2e_${stack.id}`
      ])
    } finally {
      await stack.stop()
    }
    expect(await databases(`e2e_${stack.id}`)).deep.equals([])
  })

  it('prunes the entry, directory and database of a stack whose process is gone, and only those', async function () {
    const dead = newStackId('pruneDead')
    const live = newStackId('pruneLive')
    const pool = await testPool()
    try {
      for (const [id, pid] of [
        [dead, 999999],
        [live, process.pid]
      ] as const) {
        writeStackEntry(
          STACKS,
          join(STACKS, `${id}.json`),
          JSON.stringify({ id, origin: 'http://127.0.0.1:1', pid })
        )
        mkdirSync(join(STACKS, id), { recursive: true })
        writeFileSync(join(STACKS, id, 'owner.pid'), String(pid))
        await pool.query(`create database "e2e_${id}"`)
        await pool.query(
          `comment on database "e2e_${id}" is 'e2e stack of pid ${pid}'`
        )
      }
      const alive = (pid: number): boolean => pid === process.pid
      const pruned = await pruneStacks({ alive })
      expect(pruned.entries).includes(dead).and.not.includes(live)
      expect(pruned.directories).includes(dead).and.not.includes(live)
      expect(pruned.databases).includes(`e2e_${dead}`)
      expect(pruned.databases).not.includes(`e2e_${live}`)
      expect(existsSync(join(STACKS, `${dead}.json`))).equals(false)
      expect(existsSync(join(STACKS, dead))).equals(false)
      expect(await databases(`e2e_${dead}`)).deep.equals([])
      expect(existsSync(join(STACKS, `${live}.json`))).equals(true)
      expect(await databases(`e2e_${live}`)).deep.equals([`e2e_${live}`])
    } finally {
      await pool.query(`drop database if exists "e2e_${live}" with (force)`)
      await pool.query(`drop database if exists "e2e_${dead}" with (force)`)
      await pool.end()
      for (const id of [dead, live]) {
        rmSync(join(STACKS, `${id}.json`), { force: true })
        rmSync(join(STACKS, id), { recursive: true, force: true })
      }
    }
  })
})
