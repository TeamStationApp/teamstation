import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import type { Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { runInNewContext } from 'node:vm'

import type { Event } from '@sentry/core'
import {
  defaultStackParser,
  getCurrentScope,
  getIsolationScope,
  NodeClient
} from '@sentry/node'
import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, afterEach, before, describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import { userIdOfGumbo } from '../../common/userId'
import { envelope } from '../../logServer/envelope'
import type { Actor } from '../auth/sessions'
import { deployedVersion, versionOf } from '../buildVersion'
import type { Database } from '../db/database'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { adminRoutes } from '../routes/admin'
import { reportFailure } from '../statsBuilder/main'
import { sentryOptions, UNHANDLED_REJECTION_MODE } from './options'

const DSN = 'https://public@sentry.example.test/1'
const ROOT = '/var/app'

describe('server Sentry options', function () {
  it('delivers compiled server locations through SDK serialization and collector reconstruction', async function () {
    const options = sentryOptions(
      { dsn: DSN, environment: 'development' },
      'example.test',
      '1.0',
      ROOT
    )!
    const records: ReturnType<typeof envelope> = []
    const client = new NodeClient({
      ...options,
      stackParser: defaultStackParser,
      integrations:
        typeof options.integrations === 'function'
          ? options.integrations([])
          : [],
      transport: () => ({
        send: async packet => {
          const body = packet[1]
            .map(
              ([header, payload]) =>
                JSON.stringify(header) + '\n' + JSON.stringify(payload)
            )
            .join('\n')
          records.push(
            ...envelope(
              Buffer.from(JSON.stringify(packet[0]) + '\n' + body),
              'TS srv'
            )
          )
          return {}
        },
        flush: async () => true
      })
    })
    client.init()
    try {
      for (const file of [
        'server/index.js',
        'server/routes/auth.js',
        'server/statsBuilder/main.js'
      ]) {
        try {
          runInNewContext(
            'throw new TypeError("private-canary")',
            {},
            { filename: ROOT + '/lib/' + file }
          )
        } catch (error) {
          client.captureException(error)
        }
        await client.flush(1000)
        expect(records.at(-1)?.P).includes({
          c: 'TypeError',
          f0: file,
          l0: 1,
          c0: 7
        })
      }
      expect(records).length(3)
      expect(JSON.stringify(records))
        .not.contains(ROOT)
        .and.not.contains('private-canary')
    } finally {
      await client.close()
    }
  })
  it('reports nothing without a DSN', function () {
    expect(
      sentryOptions(
        { dsn: '', environment: '' },
        'app.teamstation.app',
        '1.2.3',
        ROOT
      )
    ).equals(undefined)
  })

  it('names the release and the environment from the host', function () {
    const options = sentryOptions(
      { dsn: DSN, environment: '' },
      'app.teamstation.app',
      '0.1.0-20261008-abc',
      ROOT
    )
    expect(options?.release).equals('teamstation-server@0.1.0-20261008-abc')
    expect(options?.dist).equals(undefined)
    expect(options?.environment).equals('production')
    expect(options?.dataCollection).deep.include({
      userInfo: false,
      cookies: false
    })
    expect(
      sentryOptions(
        { dsn: DSN, environment: '' },
        'develop2.example.test',
        undefined,
        ROOT
      )?.environment
    ).equals('develop2')
  })

  it('takes a configured environment over the host, and development without a build', function () {
    const options = sentryOptions(
      { dsn: DSN, environment: 'development' },
      'app.teamstation.app',
      undefined,
      ROOT
    )
    expect(options?.environment).equals('development')
    expect(options?.release).equals('teamstation-server@development')
  })

  it('drops the console integration and makes unhandled rejections strict', function () {
    const options = sentryOptions(
      { dsn: DSN, environment: '' },
      'app.teamstation.app',
      undefined,
      ROOT
    )
    const integrations = options?.integrations
    if (typeof integrations !== 'function')
      throw new Error('expected an integrations function')
    const kept = integrations([
      { name: 'Console' },
      { name: 'OnUnhandledRejection' },
      { name: 'Http' }
    ] as Parameters<typeof integrations>[0])
    const names = kept.map(integration => integration.name)
    expect(names).deep.equals(['Http', 'OnUnhandledRejection', 'RewriteFrames'])
    expect(UNHANDLED_REJECTION_MODE).equals('strict')
  })

  it('drops explained errors and scrubs the rest', function () {
    const options = sentryOptions(
      { dsn: DSN, environment: '' },
      'app.teamstation.app',
      undefined,
      ROOT
    )
    const beforeSend = options?.beforeSend
    const beforeBreadcrumb = options?.beforeBreadcrumb
    if (beforeSend == null || beforeBreadcrumb == null)
      throw new Error('expected hooks')
    expect(
      beforeSend(
        { type: undefined },
        {
          originalException: new HttpError('notFound', 'x')
        }
      )
    ).equals(null)
    expect(
      beforeSend(
        {
          type: undefined,
          message: 'code for ruth@example.test'
        },
        { originalException: new Error('x') }
      )
    ).deep.equals({ type: undefined, message: 'code for [email]' })
    expect(beforeBreadcrumb({ category: 'console' }, undefined)).equals(null)
  })
})

describe('build version', function () {
  const cwd = process.cwd()
  let dir = ''
  afterEach(function () {
    process.chdir(cwd)
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
    dir = ''
  })

  it('reads the deployed version, and falls back without one', function () {
    dir = mkdtempSync(path.join(tmpdir(), 'build-version-'))
    process.chdir(dir)
    expect(deployedVersion()).equals(undefined)
    expect(versionOf()).equals('0.1.0')
    writeFileSync(
      path.join(dir, 'build.json'),
      JSON.stringify({ version: '0.1.0-20261008-abc' })
    )
    expect(deployedVersion()).equals('0.1.0-20261008-abc')
    expect(versionOf()).equals('0.1.0-20261008-abc')
    writeFileSync(path.join(dir, 'build.json'), JSON.stringify({ version: 3 }))
    expect(deployedVersion()).equals(undefined)
  })
})

describe('server errors reach Sentry', function () {
  let server: Server | undefined
  let base = ''
  const events: Event[] = []
  const realError = console.error

  /** A database that knows one session, for user 7, an administrator. */
  const sessionDb = new Proxy(
    {},
    {
      get(target, property) {
        if (property === 'executeTakeFirst')
          return async () => ({
            sessionId: 1,
            userId: userIdOfGumbo(7),
            expiresAt: new Date(Date.now() + 60_000).toISOString(),
            revokedAt: null,
            isAdmin: true
          })
        if (property === 'execute') return async () => []
        if (property === 'then') return undefined
        return () => sessionDb
      }
    }
  ) as unknown as Kysely<Database>

  before(async function () {
    const client = new NodeClient({
      dsn: DSN,
      integrations: [],
      stackParser: defaultStackParser,
      transport: () => ({
        send: async () => ({}),
        flush: async () => true
      }),
      beforeSend: event => {
        events.push(event)
        return null
      }
    })
    getCurrentScope().setClient(client)
    client.init()

    const app = express()
    // Stands in for withActor where a test names who is signed in.
    app.use((req, res, next) => {
      const user = req.header('x-test-user')
      if (user != null) {
        const actor: Actor = {
          userId: userIdOfGumbo(Number(user)),
          isAdmin: req.header('x-test-admin') === '1',
          scopes: []
        }
        req.actor = actor
      }
      next()
    })
    app.get('/session', withActor(sessionDb), (req, res) => {
      // Read inside the request, where an error it raised would be reported.
      res.json({
        userId: req.actor?.userId,
        reported: getIsolationScope().getUser()
      })
    })
    app.get('/boom', () => {
      throw new Error('unplanned')
    })
    app.get('/missing', () => {
      throw new HttpError('notFound', 'Not found')
    })
    app.use('/api/v1', adminRoutes())
    app.use(errorHandler)
    await new Promise<void>(resolve => {
      server = app.listen(0, '127.0.0.1', () => {
        resolve()
      })
    })
    base = `http://127.0.0.1:${(server?.address() as AddressInfo).port}`
  })

  after(async function () {
    getCurrentScope().setClient(undefined)
    getIsolationScope().setUser(null)
    await new Promise(resolve => server?.close(resolve))
  })

  afterEach(function () {
    events.length = 0
    console.error = realError
  })

  it('reports an unplanned error and answers internal', async function () {
    console.error = () => undefined
    const response = await fetch(`${base}/boom`)
    expect(response.status).equals(500)
    expect(await response.json()).deep.include({ code: 'internal' })
    expect(events).length(1)
    expect(events[0].exception?.values?.[0].value).equals('unplanned')
  })

  it('does not report an HttpError', async function () {
    const response = await fetch(`${base}/missing`)
    expect(response.status).equals(404)
    expect(events).length(0)
  })

  it('names the signed-in account by id only', async function () {
    const response = await fetch(`${base}/session`, {
      headers: { authorization: 'Bearer token' }
    })
    expect(await response.json()).deep.equals({
      userId: userIdOfGumbo(7),
      reported: { id: userIdOfGumbo(7) }
    })
  })

  it('reports a failure the stats builder caught before it exits', async function () {
    await reportFailure(new Error('stats builder lost its connection'))
    expect(
      events.map(event => event.exception?.values?.[0]?.value)
    ).deep.equals(['stats builder lost its connection'])
  })

  it('lets only an administrator raise the test error', async function () {
    console.error = () => undefined
    expect(
      (await fetch(`${base}/api/v1/admin/test-error`, { method: 'POST' }))
        .status
    ).equals(401)
    expect(
      (
        await fetch(`${base}/api/v1/admin/test-error`, {
          method: 'POST',
          headers: { 'x-test-user': '8' }
        })
      ).status
    ).equals(403)
    expect(events).length(0)
    const response = await fetch(`${base}/api/v1/admin/test-error`, {
      method: 'POST',
      headers: { 'x-test-user': '7', 'x-test-admin': '1' }
    })
    expect(response.status).equals(500)
    expect(events).length(1)
    expect(events[0].exception?.values?.[0].value).equals('Sentry test error')
  })
})

describe('instrument', function () {
  it('starts nothing when the configuration has no DSN', async function () {
    // A workstation's serverConfig.json may name a real DSN; importing the
    // module then would report this test run, so the case needs a bare one.
    const { serverConfig } = await import('../serverConfig')
    if (serverConfig.sentry.dsn !== '') this.skip()
    await import('./instrument')
    expect(getCurrentScope().getClient()).equals(undefined)
  })
})
