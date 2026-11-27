import { expect } from 'chai'
import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { describe, it } from 'mocha'
import type { PoolClient } from 'pg'

import {
  asNodeSettingsUpdate,
  defaultNodeSettings
} from '../common/nodeSettings'
import { type Database, makeDatabase } from './db/database'
import { withActor } from './middleware/withAuth'
import {
  distributionSettings,
  iosAppBannerId,
  setNodeSettings
} from './nodeSettings'
import { nodeAdministrationRoutes } from './routes/nodeAdministration'

describe('the public Safari product and its stored link', () => {
  it('reads a single fresh row on each unauthenticated request and forwards errors', async () => {
    let row: { value: unknown } | undefined
    const error = new Error('read failed')
    let offline = false
    let stalledCommand = false
    let dbTimeout = false
    let checkouts = 0
    let commands = 0
    let lateCheckout: (() => void) | undefined
    let heldCheckout = false
    const releases: boolean[] = []
    const client = {
      release(discard = false) {
        releases.push(discard)
      },
      async query(query: string) {
        commands++
        expect(query).matches(
          /set local statement_timeout = '600ms';\s*select value from system_settings where key = 'distribution\.iosAppStoreUrl'$/
        )
        if (stalledCommand) return await new Promise<never>(() => {})
        if (offline) throw error
        if (dbTimeout)
          throw Object.assign(new Error('statement timeout'), { code: '57014' })
        return [{ rows: [] }, { rows: row == null ? [] : [row] }]
      }
    }
    const db = makeDatabase('postgres://example.test/banner')
    db.pool.connect = async () => {
      checkouts++
      if (heldCheckout)
        await new Promise<void>(resolve => {
          lateCheckout = resolve
        })
      return client as unknown as PoolClient
    }
    const route = nodeAdministrationRoutes(db).stack.find(
      layer => layer.route?.path === '/node/ios-app-banner'
    )!.route!
    const read = async (type = 'application/json'): Promise<unknown> =>
      await new Promise((resolve, reject) => {
        const response = {
          set(key: string, value: string) {
            expect([key, value]).deep.equals(['Cache-Control', 'no-store'])
          },
          vary(header: string) {
            expect(header).equals('Accept')
          },
          type(mime: string) {
            expect(mime).equals('text/css')
            return { send: resolve }
          },
          json: resolve
        }
        route.stack[0].handle(
          { accepts: () => type } as unknown as Request,
          response as unknown as Response,
          reject
        )
      })
    expect(await read('text/css')).equals('')
    expect(await read()).deep.equals({ appId: null })
    row = { value: 'https://example.test/id123' }
    expect(await read()).deep.equals({ appId: null })
    row = { value: 'https://apps.apple.com/us/developer/example/id123' }
    expect(await read()).deep.equals({ appId: null })
    row = { value: 'https://apps.apple.com/app/id00123#id44' }
    expect(await read('text/css')).equals(
      ':root{--teamstation-ios-app-id:00123}'
    )
    expect(await read()).deep.equals({ appId: '00123' })
    offline = true
    expect(await read().catch((reason: unknown) => reason)).equals(error)
    offline = false
    dbTimeout = true
    releases.length = 0
    expect(await read().catch((reason: unknown) => reason)).to.have.property(
      'status',
      503
    )
    // The server cancelled the statement; the connection is idle and reusable.
    expect(releases).deep.equals([false])
    dbTimeout = false
    stalledCommand = true
    releases.length = 0
    expect(await read().catch((reason: unknown) => reason)).to.have.property(
      'status',
      503
    )
    expect(releases).deep.equals([true])
    stalledCommand = false
    heldCheckout = true
    const issued = commands
    expect(await read().catch((reason: unknown) => reason)).to.have.property(
      'status',
      503
    )
    lateCheckout!()
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(commands).equals(issued)
    expect(releases).deep.equals([true, false])
    const attempts = checkouts
    Object.defineProperty(db.pool, 'totalCount', { value: db.pool.options.max })
    expect(await read().catch((reason: unknown) => reason)).to.have.property(
      'status',
      503
    )
    expect(checkouts).equals(attempts)
    await Promise.all([db.destroy(), db.destroy()])
    expect(db.pool.ended).equals(true)
  })

  it('shares one read among requests that arrive while it is out', async () => {
    let finish: (() => void) | undefined
    let commands = 0
    const client = {
      release() {},
      async query() {
        commands++
        await new Promise<void>(resolve => {
          finish = resolve
        })
        return [
          { rows: [] },
          { rows: [{ value: 'https://apps.apple.com/app/id42' }] }
        ]
      }
    }
    const db = makeDatabase('postgres://example.test/banner-shared')
    db.pool.connect = async () => client as unknown as PoolClient
    const first = iosAppBannerId(db)
    const second = iosAppBannerId(db)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(commands).equals(1)
    finish!()
    expect(await Promise.all([first, second])).deep.equals(['42', '42'])
    const third = iosAppBannerId(db)
    await new Promise<void>(resolve => setImmediate(resolve))
    expect(commands).equals(2)
    finish!()
    expect(await third).equals('42')
    await db.destroy()
  })

  it('only skips actor lookup for the public banner read', () => {
    const actor = withActor({} as unknown as Kysely<Database>)
    for (const [method, path, skipsIdentity] of [
      ['GET', '/api/v1/node/ios-app-banner', true],
      ['PUT', '/api/v1/node/ios-app-banner', false],
      ['GET', '/api/v1/node/settings', false]
    ] as const) {
      let readCredentials = false
      let nextCalled = false
      const request = {
        method,
        path,
        header() {
          readCredentials = true
        }
      }
      actor(request as unknown as Request, {} as unknown as Response, () => {
        nextCalled = true
      })
      expect(nextCalled).equals(true)
      expect(readCredentials).equals(!skipsIdentity)
    }
  })

  it('keeps older writes and explicit clears distinct in the settings transaction', async () => {
    const held = new Map<string, unknown>()
    const db = {
      selectFrom(table: string) {
        return {
          select: () => ({
            where: () => ({
              executeTakeFirst: async () => ({
                is_admin: true,
                login_enabled: true
              }),
              execute: async () => {
                expect(table).equals('system_settings')
                return Array.from(held, ([key, value]) => ({ key, value }))
              }
            })
          })
        }
      },
      transaction: () => ({
        execute: async (run: (trx: unknown) => Promise<void>) => {
          await run({
            // The sample key a save putting the default clip back replaces.
            selectFrom: () => ({
              select: () => ({
                where: (_column: string, _op: string, key: string) => ({
                  forUpdate: () => ({
                    executeTakeFirst: async () =>
                      held.has(key) ? { value: held.get(key) } : undefined
                  })
                })
              })
            }),
            insertInto: () => ({
              values: (row: {
                key: string
                value: string
                updated_by: string
              }) => ({
                onConflict: () => ({
                  execute() {
                    expect(row.updated_by).equals('fixture-admin')
                    held.set(row.key, JSON.parse(row.value))
                  }
                })
              })
            })
          })
        }
      })
    } as unknown as Kysely<Database>
    const write = async (distribution: unknown): Promise<void> => {
      await setNodeSettings(
        db,
        { userId: 'fixture-admin', isAdmin: true, scopes: [] },
        asNodeSettingsUpdate({ ...defaultNodeSettings, distribution })
      )
    }
    const read = async (): Promise<string> =>
      (await distributionSettings(db, Date.now(), true)).iosAppStoreUrl
    const url = 'https://apps.apple.com/app/id123/'
    const about = {
      betaBuildsUrl: 'https://builds.example.test/beta',
      appStoreUrl: 'https://testflight.apple.com/join/example'
    }
    await write({ ...about, iosAppStoreUrl: url })
    for (const partial of [{}, { appStoreUrl: '' }, { betaBuildsUrl: '' }]) {
      expect(
        await write({ ...partial, iosAppStoreUrl: '' }).catch(
          (error: unknown) => error
        )
      ).instanceOf(TypeError)
      expect(await distributionSettings(db, Date.now(), true)).deep.equals({
        ...about,
        iosAppStoreUrl: url
      })
    }
    for (const distribution of [undefined, about]) {
      await write(distribution)
      expect(await read()).equals(url)
    }
    expect(
      await write({ ...about, iosAppStoreUrl: null }).catch(
        (reason: unknown) => reason
      )
    ).instanceOf(TypeError)
    expect(await read()).equals(url)
    await write({ ...about, iosAppStoreUrl: '' })
    expect(await read()).equals('')
  })
})
