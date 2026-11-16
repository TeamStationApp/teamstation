import { expect } from 'chai'

import { signInWithPassword } from '../../../core/fixtures'
import { defineE2e, type E2eContext } from '../../../core/spec'

const APP_ID = 'app.teamstation.app'

/** Puts the surface's sign-in form on screen, and returns once a scenario can use it. */
async function openSignIn(ctx: E2eContext): Promise<void> {
  if (ctx.surface === 'web-chromium') {
    const { m } = await ctx.browser({ width: 1280, height: 800 })
    await m.openLink({ link: `${ctx.stack.origin}/sign-in` })
    return
  }
  const m = await ctx.attach('user', {
    platform: ctx.surface === 'ios-app' ? 'ios' : 'android',
    appId: APP_ID,
    commandTimeout: 30000
  })
  await m.launchApp({ appId: APP_ID, clearState: true })
}

export default defineE2e({
  id: 'account/sign-in/password',
  title:
    'A person signs in with a password on each surface, and sees only their own team',
  kind: 'e2e',
  covers: [
    'src/server/routes/auth.ts',
    'src/server/auth/passwords.ts',
    'src/app/screens/LoginScreen.tsx'
  ],
  stack: 'seat',
  fixtures: ['team-with-roster'],
  exclusive: false,
  surfaces: {
    'web-chromium': { devices: [] },
    'ios-app': {
      devices: [{ role: 'user', needs: ['ios-phone'], hardware: 'none' }]
    },
    'android-app': {
      devices: [{ role: 'user', needs: ['android-phone'], hardware: 'none' }]
    }
  },
  services: ['api', 'web'],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 3,
  guards: [],
  faults: [],
  manual: false,
  scenarios: {
    'baseline-account': async ctx => {
      await openSignIn(ctx)
      const account = await ctx.signIn('member')
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
