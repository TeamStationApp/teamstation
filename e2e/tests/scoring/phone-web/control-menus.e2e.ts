import { defineHarness } from '../../../core/spec'
import { withPhoneScorer } from '../../../rigs/scoring/phoneWebScorer'

/**
 * The pitch controls' menus in Safari on an iPhone: Bunt in Play offers no
 * Home Run, a second Called Strike opens More, which hides Balk and its
 * heading, a dropped third strike asks only first base's Safe, and the lower
 * Done finishes the at-bat.
 */
export default defineHarness({
  id: 'scoring/phone-web/control-menus',
  title:
    'Safari scoring menus hide Balk, ask a dropped third strike first base, and finish from the lower Done',
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
  minutes: 6,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'menus-and-dropped-third': async ctx => {
      await withPhoneScorer(ctx, async s => {
        await s.orient('portrait')
        await s.freshGame({ restart: true })
        await s.shot('new-controls')
        await s.tap('Swing in Play')
        await s.visible('^Home Run$')
        await s.tap('Dismiss outcomes')
        await s.tap('Bunt in Play')
        await s.absent('^Home Run$')
        await s.tap('Dismiss outcomes')
        await s.tap('Called Strike')
        await s.visible('^Called Strike$')
        await s.tap('Called Strike')
        await s.visible('^More$')
        await s.m.tapOn({ id: '^More$', enabled: true, timeout: 10000 })
        await s.absent('^Balk$')
        await s.absent('^This pitch$')
        await s.tap('Dropped Third Strike')
        await s.visible('^Safe$')
        await s.shot('first-base-decision')
        await s.tap('Safe')
        await s.visible('^Finish at-bat$')
        await s.visible('^Bottom Finish at-bat$')
        await s.shot('both-done-controls')
        await s.tap('Bottom Finish at-bat')
        await ctx.checkpoint(
          'next-batter',
          { expect: [{ text: 'Batter Player 2' }] },
          s.m
        )
        await s.shot('next-batter')
        s.log(
          'PASS Safari control menus, hidden Balk and heading, automatic dropped-third first-base Safe decision and lower Done'
        )
      })
    }
  }
})
