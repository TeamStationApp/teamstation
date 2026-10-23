import { spawn } from 'node:child_process'
import cluster from 'node:cluster'
import { randomUUID } from 'node:crypto'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join, resolve as resolvePath } from 'node:path'

import { expect } from 'chai'
import express from 'express'
import { describe, it } from 'mocha'

import {
  createServerLog,
  emitLog,
  requestLogs,
  startServerLogging
} from './logging'

describe('server operational logging', () => {
  it('shuts down the stats process cleanly when its database cannot start', async function () {
    this.timeout(15000)
    const directory = await mkdtemp(join(tmpdir(), 'stats-startup-'))
    await writeFile(
      join(directory, 'serverConfig.json'),
      JSON.stringify({
        databaseUrl: 'postgres://localhost:1/absent',
        workDir: join(directory, 'work')
      })
    )
    const child = spawn(
      process.execPath,
      [
        '-r',
        require.resolve('sucrase/register'),
        resolvePath('src/server/statsBuilder/start.ts')
      ],
      { cwd: directory, env: process.env, stdio: 'ignore' }
    )
    try {
      const code = await new Promise<number | null>((resolve, reject) => {
        const timer = setTimeout(() => {
          child.kill('SIGKILL')
          reject(Error('Stats startup did not finish'))
        }, 10000)
        child.once('exit', code => {
          clearTimeout(timer)
          resolve(code)
        })
      })
      expect(code).equals(1)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
  it('recovers the primary queue and routes worker events through the same privacy boundary', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'server-logs-'))
    const sent: string[] = []
    const options = {
      directory,
      dsn: 'https://public@logs.example.test/1',
      role: 'server' as const,
      writeToken: 'fixture-write-token'.repeat(3),
      request: async (_url: unknown, init?: RequestInit) => {
        sent.push(init?.body as string)
        return new Response('', { status: 202 })
      }
    }
    try {
      const first = createServerLog({
        ...options,
        request: async () => {
          throw Error('offline')
        }
      })
      first.emit('service_started')
      await first.close()
      expect(
        JSON.parse(await readFile(join(directory, 'server.json'), 'utf8'))
      ).length(1)
      const next = createServerLog(options)
      const worker = createServerLog({
        ...options,
        version: '1.0',
        send: next.accept
      })
      worker.emit(
        'request_completed',
        {
          op: 'request',
          rp: '/analytics/events',
          mt: 'POST',
          status: 202
        },
        'info',
        'usr_demo'
      )
      worker.emit('app_error', { chat: 'private-canary' })
      const bad = createServerLog({
        ...options,
        send: () => {
          throw Error('closed')
        }
      })
      bad.emit('service_started')
      await bad.close()
      for (const message of [
        null,
        'bad',
        {},
        { type: 'ts-operational', event: {} },
        {
          type: 'ts-operational',
          event: {
            D: new Date().toISOString(),
            A: 'cam',
            I: randomUUID(),
            E: 'service_started',
            L: 'info',
            R: 1,
            P: {}
          }
        }
      ])
        next.accept(message)
      await worker.close()
      await next.close()
      expect(sent).length(1)
      expect(sent[0].trim().split('\n')).length(2)
      expect(sent[0]).not.contains('private-canary')
      expect(JSON.parse(sent[0].trim().split('\n')[1]).U).equals('usr_demo')
      const disabled = createServerLog({ ...options, dsn: '' })
      disabled.emit('service_started')
      await disabled.close()
      await writeFile(join(directory, 'server.json'), 'x'.repeat(524289))
      await createServerLog(options).close()
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('records lifecycle and request templates without request data or SQL', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'request-logs-'))
    const sent: string[] = []
    const stop = startServerLogging({
      directory,
      role: 'server',
      dsn: 'https://public@logs.example.test/1',
      writeToken: 'fixture-write-token'.repeat(3),
      request: async (_url, init) => {
        expect(new Headers(init?.headers).get('authorization')).equals(
          'Bearer ' + 'fixture-write-token'.repeat(3)
        )
        sent.push(init?.body as string)
        return new Response('', { status: 202 })
      }
    })
    const app = express()
    app.use(requestLogs)
    app.post('/analytics/events', (req, res) => {
      req.actor = { userId: 'usr_demo', isAdmin: false, scopes: [] }
      res.sendStatus(202)
    })
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    try {
      const origin =
        'http://127.0.0.1:' + (server.address() as AddressInfo).port
      await fetch(origin + '/analytics/events?chat=private-canary', {
        method: 'POST',
        body: 'private-canary'
      })
      await fetch(origin + '/private-canary')
      cluster.emit(
        'message',
        {},
        {
          type: 'ts-operational',
          event: {
            D: new Date().toISOString(),
            A: 'TS srv',
            I: randomUUID(),
            E: 'service_started',
            L: 'info',
            R: 1,
            P: {}
          }
        }
      )
      emitLog('app_error', { ec: 'internal' }, 'error')
      await stop()
      const rows = sent
        .join('')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      expect(rows.map(row => row.E)).includes('service_stopped')
      expect(
        rows.filter(row => row.E === 'request_completed').map(row => row.P.rp)
      ).deep.equals(['/analytics/events', 'other'])
      expect(sent.join('')).not.contains('private-canary')
      const requests = rows.filter(row => row.E === 'request_completed')
      expect(requests[0].U).equals('usr_demo')
      expect(requests[1]).not.has.property('U')
      expect(sent.join('')).not.contains('fixture-write-token')
      emitLog('service_stopped')
    } finally {
      await stop()
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
      await rm(directory, { recursive: true, force: true })
    }
  })

  it('forwards tess_request and names the Tess route, never the conversation', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'tess-logs-'))
    const sent: string[] = []
    const primary = createServerLog({
      directory,
      dsn: 'https://public@logs.example.test/1',
      role: 'server',
      writeToken: 'fixture-write-token'.repeat(3),
      request: async (_url: unknown, init?: RequestInit) => {
        sent.push(init?.body as string)
        return new Response('', { status: 202 })
      }
    })
    const worker = createServerLog({
      directory,
      dsn: 'https://public@logs.example.test/1',
      role: 'server',
      writeToken: 'fixture-write-token'.repeat(3),
      send: primary.accept
    })
    const stop = startServerLogging({
      directory,
      role: 'server',
      dsn: 'https://public@logs.example.test/1',
      request: async (_url, init) => {
        sent.push(init?.body as string)
        return new Response('', { status: 202 })
      }
    })
    const app = express()
    app.use(requestLogs)
    app.post('/me/tess/messages', (req, res) => {
      res.sendStatus(200)
    })
    const server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server.once('listening', resolve))
    try {
      worker.emit(
        'tess_request',
        { op: 'assistant', status: 200, ms: 1800, it: 9520, ot: 75 },
        'info',
        'usr_demo'
      )
      // An unknown property drops the whole event: its text never leaves.
      worker.emit('tess_request', {
        op: 'assistant',
        text: 'Where is our schedule? private-canary'
      })
      await fetch(
        'http://127.0.0.1:' +
          (server.address() as AddressInfo).port +
          '/me/tess/messages',
        { method: 'POST', body: 'private-canary' }
      )
      await worker.close()
      await primary.close()
      await stop()
      const rows = sent
        .join('')
        .trim()
        .split('\n')
        .map(line => JSON.parse(line))
      const tess = rows.filter(row => row.E === 'tess_request')
      expect(tess).length(1)
      expect(tess[0].P).deep.equals({
        op: 'assistant',
        status: 200,
        ms: 1800,
        it: 9520,
        ot: 75
      })
      expect(tess[0].U).equals('usr_demo')
      expect(
        rows.filter(row => row.E === 'request_completed').map(row => row.P.rp)
      ).deep.equals(['/me/tess/messages'])
      expect(sent.join('')).not.contains('private-canary')
    } finally {
      await stop()
      await new Promise<void>(resolve =>
        server.close(() => {
          resolve()
        })
      )
      await rm(directory, { recursive: true, force: true })
    }
  })
})
