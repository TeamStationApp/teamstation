import { defineHarness } from '../../../core/spec'
import { withPhoneScorer } from '../../../rigs/scoring/phoneWebScorer'

/**
 * Which team bats and which fields, in Safari on an iPhone: the Owls bat
 * the top of the first against the Hawks' defense, and once the half
 * inning is ended from the scoring menu the Hawks bat the bottom.
 */
export default defineHarness({
  id: 'scoring/phone-web/team-sides',
  title:
    'Safari scoring shows the batting team and the dugout across a half inning',
  kind: 'e2e',
  covers: ['src/app/scoring/**', 'src/app/field/**'],
  stack: 'isolated',
  fixtures: ['scoring-preview'],
  exclusive: false,
  surfaces: {
    'web-safari-ios': {
      // The field draws in 3D: a GPU, so a physical iPhone.
      devices: [
        { role: 'browser', needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 4,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'half-inning-swap': async ctx => {
      await withPhoneScorer(ctx, async s => {
        await s.orient('portrait')
        await s.freshGame({ restart: true })
        await s.shot('away-batting-home-defense')
        await s.tap('Open scoring menu')
        await s.tap('End Half Inning')
        await s.tap('Confirm End Half Inning')
        await ctx.checkpoint(
          'home-batting',
          { expect: [{ text: 'Bottom' }] },
          s.m
        )
        await s.shot('home-batting-away-defense')
        await s.orient('portrait')
        s.log('PASS team identity and dugout Safari journey')
      })
    }
  }
})
