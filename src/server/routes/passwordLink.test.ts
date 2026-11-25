import { createServer, IncomingMessage } from 'node:http'
import { Socket } from 'node:net'
import { PassThrough } from 'node:stream'
import { mock } from 'node:test'

import { expect } from 'chai'
import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { describe, it } from 'mocha'
import { WebSocket } from 'ws'

import { HttpError } from '../../common/errors'
import {
  EXPECTED_ACTOR_HEADER,
  SIGNED_OUT_ACTOR,
  socketActorMatches,
  socketForActor
} from '../../common/webPasswordLink'
import * as sessions from '../auth/sessions'
import { SESSION_COOKIE } from '../auth/tokens'
import type { Database } from '../db/database'
import { withActor } from '../middleware/withAuth'
import { scoreboardSession } from '../scoreboard/scoreboardHub'
import { attachSearchSocket } from '../search/socket'
import { attachGameSocket } from '../socket/gameSocket'
import { accountRoutes } from './account'
import {
  authRoutes,
  checkBrowserActor,
  confirmPasswordLinkSwitch,
  passwordLinkGuard
} from './auth'

describe('password-link account consent', () => {
  const target = { id: 'target', email: 'seat@example.test' }
  const confirmed = { currentId: 'current', targetId: target.id }
  const label = async (): Promise<string> => 'previous@example.test'
  it('rejects stale game and search connections before accepting any frames', async () => {
    const db = Object.create(null) as Kysely<Database>
    const search = attachSearchSocket({ db, deps: Object.create(null) })
    const game = attachGameSocket(createServer(), db, '', {
      listenForUpgrades: false,
      stopSignals: null,
      feed: {
        subscribe: () => ({ listening: Promise.resolve(), stop: () => {} }),
        publishEphemeral: async () => {},
        close: async () => {}
      }
    })
    const find = mock.method(sessions, 'actorForToken', async () => ({
      userId: 'current'
    }))
    try {
      for (const [handle, path, displayed] of [
        [game, '/socket', 'previous'],
        [search, '/api/v1/search', 'previous'],
        [search, '/api/v1/search', SIGNED_OUT_ACTOR]
      ] as const) {
        const transport = new PassThrough()
        const refusal = new Promise<string>(resolve =>
          transport.once('data', bytes => {
            resolve(String(bytes))
          })
        )
        const url = new URL(
          socketForActor('wss://seat.example.test' + path, displayed)
        )
        const req = new IncomingMessage(new Socket())
        req.url = url.pathname + url.search
        req.headers.cookie = SESSION_COOKIE + '=test'
        expect(handle.acceptUpgrade(req, transport, Buffer.alloc(0))).equals(
          true
        )
        expect(await refusal).includes('403 Forbidden')
        expect(handle.size()).equals(0)
      }
      expect(socketActorMatches('/socket', undefined)).equals(true)
      expect(
        socketActorMatches('/socket?expectedActor=signed-out', undefined)
      ).equals(true)
      expect(
        socketActorMatches('/socket?expectedActor=current', 'current')
      ).equals(true)
    } finally {
      find.mock.restore()
      await game.close()
      search.close()
    }
  })
  it('authenticates the dashboard against its original actor before processing edits', async () => {
    const actor: sessions.Actor = {
      userId: 'shown',
      isAdmin: false,
      scopes: []
    }
    const lookup = mock.method(sessions, 'actorForToken', async () => actor)
    const db = Object.create(null) as Kysely<Database>
    try {
      for (const [expected, cookie, code] of [
        ['shown', 'session', undefined],
        ['previous', 'session', 4403],
        ['shown', undefined, 4401],
        ['shown', 'limited', 4403]
      ] as const) {
        actor.apiKey =
          cookie === 'limited'
            ? { id: 'read-only', permissions: new Set() }
            : undefined
        let closed: number | undefined
        const socket = {
          readyState: WebSocket.OPEN,
          close: (value: number) => {
            closed = value
          }
        }
        const result = await scoreboardSession(
          db,
          {
            url: '/dashboard?expectedActor=' + expected,
            headers: {
              cookie: cookie == null ? undefined : SESSION_COOKIE + '=' + cookie
            }
          },
          { socket: socket as WebSocket, kind: 'dashboard' }
        )
        expect(closed).equals(code)
        expect(result?.userId).equals(code == null ? actor.userId : undefined)
      }
    } finally {
      lookup.mock.restore()
    }
  })
  it('checks a stale actor precondition before entering a route', () => {
    const check = withActor(Object.create(null) as Kysely<Database>)
    for (const [user, expected] of [
      [undefined, 'other'],
      ['shown', undefined],
      ['shown', 'shown'],
      ['shown', 'other']
    ]) {
      const req = {
        method: 'POST',
        path: '/api/v1/auth/logout',
        actor: user == null ? undefined : { userId: user },
        header: (name: string) =>
          name === EXPECTED_ACTOR_HEADER ? expected : undefined
      }
      let result: unknown
      check(
        req as unknown as Request,
        Object.create(null) as Response,
        error => {
          result = error
        }
      )
      if (user != null && expected === 'other')
        expect((result as HttpError).code).equals('conflict')
      else expect(result).equals(undefined)
    }
  })
  it('refuses to clear a different account’s cookie when a departing tab still has its bearer', async () => {
    const find = mock.method(sessions, 'actorForToken', async () => ({
      userId: 'new-account'
    }))
    try {
      const db = Object.create(null) as Kysely<Database>
      const router = authRoutes(db, { sendCode: async () => {} })
      const account = accountRoutes(db, Object.create(null))
      const logout = router.stack
        .find(layer => layer.route?.path === '/auth/logout')!
        .route!.stack.at(-1)!.handle
      const deletion = account.stack
        .find(
          layer =>
            layer.route?.path === '/me/account' &&
            layer.route.stack.some(h => h.method === 'delete')
        )!
        .route!.stack.at(-1)!.handle
      const claim = router.stack
        .find(layer => layer.route?.path === '/auth/request/claim')!
        .route!.stack.at(-1)!.handle
      const headers: Record<string, string> = {
        authorization: 'Bearer earlier-session',
        cookie: SESSION_COOKIE + '=later-session',
        [EXPECTED_ACTOR_HEADER]: 'departing-account'
      }
      const req = {
        actor: { userId: 'departing-account', sessionId: 'test' },
        header: (name: string) => headers[name]
      }
      for (const handler of [logout, deletion, claim]) {
        const error = await new Promise(resolve =>
          handler(
            req as unknown as Request,
            Object.create(null) as Response,
            resolve
          )
        )
        expect((error as HttpError).code).equals('conflict')
      }
      expect(find.mock.calls[0].arguments[1]).equals('later-session')
    } finally {
      find.mock.restore()
    }
  })
  it('permits a pending claim while the browser still has its initial identity', async () => {
    const db = Object.create(null) as Kysely<Database>
    for (const current of [undefined, 'same']) {
      const headers: Record<string, string> = {
        [EXPECTED_ACTOR_HEADER]: current ?? SIGNED_OUT_ACTOR
      }
      if (current != null) headers.cookie = SESSION_COOKIE + '=one'
      const req = {
        actor: current == null ? undefined : { userId: current },
        header: (name: string) => headers[name]
      }
      await checkBrowserActor(db, req as unknown as Request)
    }
  })

  it('permits a signed-out, same-account or expressly confirmed login', async () => {
    await confirmPasswordLinkSwitch(undefined, target, undefined, label)
    await confirmPasswordLinkSwitch(target.id, target, undefined, label)
    await confirmPasswordLinkSwitch('current', target, confirmed, label)
  })
  it('refuses a link with different bearer and cookie sessions', async () => {
    const origin = 'https://seat.example.test'
    const router = authRoutes(Object.create(null) as Kysely<Database>, {
      publicUrl: origin,
      passwordLinkOrigin: origin,
      sendCode: async () => {}
    })
    const handler = router.stack.find(
      layer => layer.route?.path === '/auth/password/link'
    )!.route!.stack[0].handle
    const headers: Record<string, string> = {
      authorization: 'Bearer first',
      cookie: SESSION_COOKIE + '=second'
    }
    const req = {
      body: {},
      header: (name: string) => headers[name]
    } as unknown as Request
    const res = { set: () => res } as unknown as Response
    const error = await new Promise(resolve => handler(req, res, resolve))
    expect((error as HttpError).code).equals('conflict')
  })
  it('checks consent after a valid development request is parsed', async () => {
    const res = { set: () => res } as unknown as Response
    const verify = passwordLinkGuard(
      'https://seat.example.test',
      'https://seat.example.test',
      res,
      { confirmation: confirmed },
      'current',
      label
    )
    await verify(target)
  })
  it('rejects approvals after either identity changes, including sign-out', async () => {
    for (const [current, next] of [
      ['other', target.id],
      ['current', 'other'],
      [undefined, target.id]
    ]) {
      try {
        await confirmPasswordLinkSwitch(
          current,
          { ...target, id: next! },
          confirmed,
          label
        )
        expect.fail('stale approval')
      } catch (error) {
        expect(error).instanceOf(HttpError)
        expect((error as HttpError).details).equals(undefined)
      }
    }
  })
  it('identifies the two accounts after a different account signs in', async () => {
    for (const currentLabel of [undefined, 'from@example.test']) {
      try {
        await confirmPasswordLinkSwitch(
          'current',
          target,
          undefined,
          async () => currentLabel
        )
        expect.fail('missing prompt')
      } catch (error) {
        expect((error as HttpError).details).deep.equals({
          reason: 'confirmAccountSwitch',
          confirmation: confirmed,
          currentLabel: currentLabel ?? 'current',
          targetLabel: target.email
        })
      }
    }
  })
  it('rejects a link before database work off development and validates requests on development', async () => {
    for (const [origin, status] of [
      ['https://example.test', 404],
      ['https://seat.example.test', 400]
    ] as const) {
      const unusedDb = Object.create(null) as Kysely<Database>
      const router = authRoutes(unusedDb, {
        publicUrl: origin,
        passwordLinkOrigin: 'https://seat.example.test',
        sendCode: async () => {}
      })
      const handler = router.stack.find(
        layer => layer.route?.path === '/auth/password/link'
      )!.route!.stack[0].handle
      const headers: string[] = []
      const res = {
        set: (name: string, value: string) => headers.push(name, value)
      } as unknown as Response
      const request: Pick<Request, 'body'> = {
        body: { confirmation: { currentId: 7, targetId: 'x' } }
      }
      const error = await new Promise(resolve =>
        handler(request as Request, res, resolve)
      )
      expect((error as HttpError).status).equals(status)
      expect(headers).deep.equals(['cache-control', 'no-store'])
    }
  })
})
