import { expect } from 'chai'
import { describe, it } from 'mocha'

import { accountHarness } from '../../test/accountHarness'
import { authRoutes } from '../routes/auth'
import type { SmtpSettings } from '../serverConfig'
import { deliverSignInCode } from './codeDelivery'

const smtp: SmtpSettings = {
  host: 'mail.example.com',
  port: 587,
  secure: false,
  user: '',
  password: '',
  fromAddress: 'mail@example.com',
  fromName: 'TeamStation'
}
const logger = { log: () => undefined, error: () => undefined }
describe('production sign-in code delivery adapter', function () {
  this.timeout(60000)
  it('sends the exact address, code and link through the configured relay', async () => {
    let called = false
    await deliverSignInCode(
      smtp,
      'babe@example.com',
      '123456',
      'https://example.com/sign-in',
      {
        logger,
        send: async (config, email, code, link) => {
          expect(config).equals(smtp)
          expect([email, code, link]).deep.equals([
            'babe@example.com',
            '123456',
            'https://example.com/sign-in'
          ])
          called = true
          return { accepted: 1, messageId: 'fixture-message' }
        }
      }
    )
    expect(called).equals(true)
  })
  it('retains the development console fallback without calling a relay', async () => {
    for (const link of [undefined, 'https://example.com/sign-in']) {
      let logged = ''
      await deliverSignInCode(
        { ...smtp, host: '' },
        'babe@example.com',
        '123456',
        link,
        {
          logger: {
            log: value => {
              logged = String(value)
            },
            error: logger.error
          },
          send: async () => {
            throw new Error('The relay must not be called')
          }
        }
      )
      expect(logged).includes('[no mail configured]')
      expect(logged).includes('123456')
      if (link != null) expect(logged).includes(link)
    }
  })
  it('propagates the production adapter failure into request consumption and a recoverable HTTP response', async () => {
    const h = await accountHarness(undefined, (app, { db }) => {
      app.use(
        '/delivery-fixture',
        authRoutes(db, {
          sendCode: async (email, code, link) => {
            await deliverSignInCode(smtp, email, code, link, {
              logger,
              send: async () => {
                throw new Error('Synthetic SMTP delivery failure')
              }
            })
          }
        })
      )
    })
    try {
      const response = await fetch(
        h.origin + '/delivery-fixture/auth/email-code',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email: 'undelivered@example.com' })
        }
      )
      expect(response.status).equals(503)
      expect(await response.json()).property('code', 'unavailable')
      const request = await h.db
        .selectFrom('email_codes')
        .select('consumed_at')
        .where('email', '=', 'undelivered@example.com')
        .executeTakeFirstOrThrow()
      expect(request.consumed_at).not.equals(null)
      expect(
        await h.db
          .selectFrom('user_emails')
          .select('id')
          .where('email', '=', 'undelivered@example.com')
          .execute()
      ).length(0)
    } finally {
      await h.close()
    }
  })
})
