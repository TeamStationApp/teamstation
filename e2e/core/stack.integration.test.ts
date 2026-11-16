import { existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { startStack } from './stack'

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
