import { defineHarness } from '../../../core/spec'

/**
 * A phone-sized window: the real password form's sign-in check reads the
 * home screen's menu mark, which the phone layout shows.
 */
const WINDOW = { width: 402, height: 874 }

/**
 * A dump world's committed testing account signs in through the real
 * password form and finds the team its accounts file says it holds. The
 * runner restores `coach-season-dump` on the stack and migrates it forward
 * before the scenario, so nothing is seeded here.
 */
export default defineHarness({
  id: 'platform/dump-world/sign-in',
  title: "A dump world's committed account signs in and sees its team",
  kind: 'e2e',
  covers: [
    'src/app/screens/HomeScreen.tsx',
    'e2e/fixtures/dumps/coach-season-dump.dump',
    'e2e/fixtures/dumps/coach-season-dump.accounts.json'
  ],
  stack: 'isolated',
  fixtures: ['coach-season-dump'],
  exclusive: false,
  surfaces: {
    'web-chromium': {
      devices: [],
      browser: { role: 'browser', needs: [] }
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 3,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'coach-sees-team': async ctx => {
      const coach = ctx.account('coach')
      const team = coach.teams[0]
      if (team == null) throw new Error('the coach account names no team')
      const { m } = await ctx.browser(WINDOW)
      await m.openLink({ link: `${ctx.stack.origin}/` })
      await ctx.signIn('coach', m)
      await ctx.checkpoint('coach-team', {
        expect: [{ text: team.name, timeout: 20_000 }]
      })
    }
  }
})
