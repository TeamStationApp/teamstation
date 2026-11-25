import { mock } from 'node:test'

import { expect } from 'chai'
import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import { EXPECTED_ACTOR_HEADER } from '../../common/webPasswordLink'
import * as sessions from '../auth/sessions'
import { SESSION_COOKIE } from '../auth/tokens'
import type { Database } from '../db/database'
import { withActor } from '../middleware/withAuth'
import {
  authRoutes,
  confirmPasswordLinkSwitch,
  passwordLinkGuard
} from './auth'

describe('password-link account consent', () => {
  const target = { id: 'target', email: 'seat@example.test' }
  const confirmed = { currentId: 'current', targetId: target.id }
  const label = async (): Promise<string> => 'previous@example.test'
  it('checks a stale actor precondition before entering a route', () => {
    const check = withActor(Object.create(null) as Kysely<Database>)
    for (const [user, expected] of [
      [undefined, 'other'],
      ['shown', undefined],
      ['shown', 'shown'],
      ['shown', 'other']
    ]) {
      const req = {
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
      const handler = router.stack
        .find(layer => layer.route?.path === '/auth/logout')!
        .route!.stack.at(-1)!.handle
      const headers: Record<string, string> = {
        authorization: 'Bearer earlier-session',
        cookie: SESSION_COOKIE + '=later-session',
        [EXPECTED_ACTOR_HEADER]: 'departing-account'
      }
      const req = { header: (name: string) => headers[name] }
      const error = await new Promise(resolve =>
        handler(
          req as unknown as Request,
          Object.create(null) as Response,
          resolve
        )
      )
      expect((error as HttpError).code).equals('conflict')
      expect(find.mock.calls[0].arguments[1]).equals('later-session')
    } finally {
      find.mock.restore()
    }
  })
  it('permits a signed-out, same-account or expressly confirmed login', async () => {
    await confirmPasswordLinkSwitch(undefined, target, undefined, label)
    await confirmPasswordLinkSwitch(target.id, target, undefined, label)
    await confirmPasswordLinkSwitch('current', target, confirmed, label)
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
