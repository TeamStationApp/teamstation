import { existsSync } from 'node:fs'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { failedStart, startStack } from './stack'

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
    const early = `abandon-early-${process.pid}`
    const error = await failed(
      startStack({ id: early, services: [], signal: AbortSignal.abort() })
    )
    expect((error as Error).name).equals('AbortError')
    expect(existsSync(join(tmpdir(), 'teamstation-e2e-stacks', early))).equals(
      false
    )
    // Abandoned while the API comes up: its database, process and directory go.
    const late = `abandon-late-${process.pid}`
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
    expect(existsSync(join(tmpdir(), 'teamstation-e2e-stacks', late))).equals(
      false
    )
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
