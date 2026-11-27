import { defineHarness } from '../../../core/spec'
import {
  center,
  type PhoneScorer,
  withPhoneScorer
} from '../../../rigs/scoring/phoneWebScorer'

/** A finger slid from one segment of a selector onto another, at once. */
async function swipeTabs(s: PhoneScorer, a: string, b: string): Promise<void> {
  const from = center(await s.find(new RegExp('^' + a + '$')))
  const to = center(await s.find(new RegExp('^' + b + '$')))
  await s.gesture([from, to], 0)
}

/**
 * The switch-hitter hint and the roster's selectors in Safari on an iPhone:
 * the hint shows until OK, the team and Lineup/Defense selectors follow a
 * tap or a slide, and a new player's throwing and batting hands follow a
 * slide, then Bats S, before Cancel leaves both sheets.
 */
export default defineHarness({
  id: 'scoring/phone-web/selector-swipes',
  title:
    'Safari scoring dismisses the switch-hitter hint and slides the roster and handedness selectors',
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
  minutes: 5,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'hint-and-selectors': async ctx => {
      await withPhoneScorer(ctx, async s => {
        await s.orient('portrait')
        await s.freshGame({ restart: true, dismiss: false })
        if (!(await s.nodes()).some(n => n.text === 'OK')) {
          // The hint was shown before on this browser: its count reset.
          await s.tap('Open scoring menu')
          await s.tap('Settings')
          await s.tap('Reset shown count')
          await s.tap('Cancel')
          await s.freshGame({ dismiss: false })
        }
        await s.visible('Drag hitter to other box to switch hitting position.')
        await s.shot('switch-hitter-hint')
        await s.tap('OK')
        await s.absent('Drag hitter to other box to switch hitting position.')
        await s.tap('Open scoring menu')
        await s.tap('Set Team Rosters')
        await swipeTabs(s, 'Away Team', 'Home Team')
        await s.visible('^Hawks$')
        await s.shot('home-selector')
        await swipeTabs(s, 'Lineup', 'Defense')
        await s.visible(
          'Hold a player briefly, then drag into a defensive position.'
        )
        await s.shot('defense-selector')
        await s.tap('Lineup')
        await s.tap('Away Team')
        await ctx.checkpoint(
          'away-roster',
          { expect: [{ text: '^Owls$' }] },
          s.m
        )
        await s.m.scrollUntilVisible({
          element: { text: '^Create Player$' },
          direction: 'DOWN'
        })
        await s.tap('Create Player')
        await s.visible('^First Name$')
        await s.m.hideKeyboard()
        await swipeTabs(s, 'Throws R', 'Throws L')
        await swipeTabs(s, 'Bats R', 'Bats L')
        await s.tap('Bats S')
        await s.shot('handedness-selectors')
        await s.tap('Cancel')
        await s.tap('Cancel')
        s.log(
          'PASS Safari hint dismissal, team and mode tap/swipe, player handedness tap/swipe and cancellation'
        )
      })
    }
  }
})
