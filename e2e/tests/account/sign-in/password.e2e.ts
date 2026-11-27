import { expect } from 'chai'

import { signInWithPassword } from '../../../core/fixtures'
import { defineHarness, type HarnessContext } from '../../../core/spec'
import { pointAtStack } from '../../../rigs/app/pointAtStack'

/**
 * Puts the surface's sign-in form on screen, and returns once a scenario can
 * use it. The app is the caller's build, launched fresh and pointed back at
 * the stack, since clearing its state forgets the stack.
 */
async function openSignIn(ctx: HarnessContext): Promise<void> {
  if (ctx.surface === 'web-chromium') {
    const { m } = await ctx.browser({ width: 1280, height: 800 })
    await m.openLink({ link: `${ctx.stack.origin}/sign-in` })
    return
  }
  const appId = ctx.app(
    ctx.surface === 'ios-app' ? 'teamstation-ios' : 'teamstation-android'
  )
  const m = await ctx.attach('user', { appId })
  await m.launchApp({ appId, clearState: true })
  await pointAtStack(m, ctx.stack.origin, appId)
}

export default defineHarness({
  id: 'account/sign-in/password',
  title:
    'A person signs in with a password on each surface, and sees only their own team',
  kind: 'e2e',
  covers: [
    'src/server/routes/auth.ts',
    'src/server/auth/passwords.ts',
    'src/app/screens/LoginScreen.tsx'
  ],
  stack: 'isolated',
  fixtures: ['team-with-roster'],
  exclusive: false,
  surfaces: {
    'web-chromium': { devices: [], browser: { role: 'browser', needs: [] } },
    'ios-app': {
      devices: [{ role: 'user', needs: ['ios-phone'], simulator: 'allowed' }]
    },
    'android-app': {
      devices: [
        { role: 'user', needs: ['android-phone'], simulator: 'allowed' }
      ]
    }
  },
  services: [],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 3,
  guards: [],
  faults: [],
  manual: false,
  scenarios: {
    'baseline-account': async ctx => {
      // A plain account of its own: the roster world's player, seeded for
      // this scenario alone, as every scenario starts from its own world.
      await ctx.fixture('team-with-roster')
      await openSignIn(ctx)
      const account = await ctx.signIn('player')
      const first = account.displayName.split(' ')[0]
      await ctx.checkpoint('signed-in', {
        expect: [
          { text: `Account, ${first}.*` },
          { text: 'Use a password instead', absent: true }
        ]
      })
    },
    'wrong-password-refused': async ctx => {
      await openSignIn(ctx)
      const { email } = (await ctx.fixture('team-with-roster')).accounts.coach
      const refused = await signInWithPassword(ctx.lastDevice(), {
        email,
        password: 'not the password'
      }).then(
        () => false,
        () => true
      )
      expect(refused).equals(true)
      await ctx.checkpoint('still-signed-out', {
        expect: [{ text: 'Wrong e-mail or password.*' }]
      })
    },
    'own-team-only': async ctx => {
      const other = await ctx.fixture('team-with-roster')
      const mine = await ctx.fixture('team-with-roster')
      await openSignIn(ctx)
      await ctx.signIn('coach')
      const teamName = (nonce: string): string => `Sox ${nonce}`
      await ctx.checkpoint('team-listed', {
        expect: [
          { text: teamName(mine.nonce), timeout: 20000 },
          { text: teamName(other.nonce), absent: true }
        ]
      })
    }
  }
})
