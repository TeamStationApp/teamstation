import { expect } from 'chai'
import type { Request, Response } from 'express'
import type { Kysely } from 'kysely'
import { describe, it } from 'mocha'

import { HttpError } from '../../common/errors'
import type { Database } from '../db/database'
import {
  authRoutes,
  confirmPasswordLinkSwitch,
  passwordLinkGuard
} from './auth'

describe('password-link account consent', () => {
  const target = { id: 'target', email: 'seat@example.test' }
  const confirmed = { currentId: 'current', targetId: target.id }
  const label = async () => 'previous@example.test'
  it('permits a signed-out, same-account or expressly confirmed login', async () => {
    await confirmPasswordLinkSwitch(undefined, target, undefined, label)
    await confirmPasswordLinkSwitch(target.id, target, undefined, label)
    await confirmPasswordLinkSwitch('current', target, confirmed, label)
  })
  it('checks consent after a valid development request is parsed', async () => {
    const res = { set: () => res } as unknown as Response
    const verify = passwordLinkGuard(
      'https://develop.teamstation.app',
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
      ['https://develop.teamstation.app', 400]
    ] as const) {
      const router = authRoutes({} as Kysely<Database>, {
        publicUrl: origin,
        sendCode: async () => {}
      })
      const handler = router.stack.find(
        layer => layer.route?.path === '/auth/password/link'
      )!.route!.stack[0].handle
      const headers: string[] = []
      const res = {
        set: (name: string, value: string) => headers.push(name, value)
      } as unknown as Response
      const error = await new Promise(resolve =>
        handler(
          {
            body: { confirmation: { currentId: 7, targetId: 'x' } }
          } as Request,
          res,
          resolve
        )
      )
      expect((error as HttpError).status).equals(status)
      expect(headers).deep.equals(['cache-control', 'no-store'])
    }
  })
})
