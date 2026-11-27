import { BlockedError } from '../../../core/result'
import { defineHarness } from '../../../core/spec'

const SCALED_ATTEMPTS = 2

/**
 * Wrong passwords against a real address, behind the stack's reverse proxy,
 * with every limit scaled down through the stack's `rateLimits` control.
 */
export default defineHarness({
  id: 'account/rate-limits/password',
  title:
    'Too many wrong passwords are refused at the limit, and reset restores it',
  kind: 'e2e',
  covers: ['src/server/auth/rateLimit.ts', 'src/server/routes/auth.ts'],
  stack: 'isolated',
  fixtures: ['team-with-roster'],
  exclusive: true,
  surfaces: {
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } }
  },
  services: ['reverse-proxy'],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 3,
  guards: [],
  faults: [],
  manual: false,
  scenarios: {
    'refused-at-the-limit': async ctx => {
      const control = ctx.stack.control
      if (control == null) {
        throw new BlockedError('this stack has no rateLimits control')
      }
      await control.rateLimits({ scale: 0.2 })
      const { email } = (await ctx.fixture('team-with-roster')).accounts.coach
      const { m } = await ctx.browser({ width: 1280, height: 800 })
      await m.openLink({ link: `${ctx.stack.origin}/sign-in` })
      await m.tapOn({ text: 'Use a password instead' })
      await m.tapOn({ text: 'E-mail address' })
      await m.inputText({ text: email })
      await m.tapOn({ text: 'Password' })
      await m.inputText({ text: 'not the password' })
      for (let attempt = 0; attempt < SCALED_ATTEMPTS; attempt++) {
        await m.tapOn({ text: 'Sign in' })
        await m.assertVisible({ text: 'Wrong e-mail or password.*' })
      }
      await m.tapOn({ text: 'Sign in' })
      await ctx.checkpoint('refused', {
        expect: [{ text: 'Too many attempts.*', timeout: 20000 }]
      })
    }
  }
})
