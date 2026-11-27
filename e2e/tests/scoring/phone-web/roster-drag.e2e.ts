import { defineHarness } from '../../../core/spec'
import {
  center,
  type PhoneScorer,
  withPhoneScorer
} from '../../../rigs/scoring/phoneWebScorer'

/** A finger slid across a selector, through its middle, at once. */
async function swipeTabs(s: PhoneScorer, a: string, b: string): Promise<void> {
  const from = center(await s.find(new RegExp('^' + a + '$')))
  const to = center(await s.find(new RegExp('^' + b + '$')))
  await s.gesture([from, { x: (from.x + to.x) / 2, y: from.y }, to], 0)
}

/**
 * The roster sheet's immediate drags in Safari on an iPhone: Fielder's
 * Choice is not offered with the bases empty, a tapped bench player is
 * appended to the lineup, the selectors slide, a dragged player replaces a
 * defender, a lineup drag reorders at once, Cancel restores the roster, and
 * the sheet opens full screen in landscape.
 */
export default defineHarness({
  id: 'scoring/phone-web/roster-drag',
  title:
    'Safari roster drags append, replace and reorder at once, and Cancel restores the roster',
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
    'immediate-drags-and-cancel': async ctx => {
      await withPhoneScorer(ctx, async s => {
        await s.orient('portrait')
        await s.freshGame({ restart: true })
        await s.tap('Swing in Play')
        await s.absent("^Fielder's Choice$")
        await s.touch({ x: 20, y: 300 })
        await s.tap('Open scoring menu')
        await s.tap('Set Team Rosters')
        await s.shot('roster-initial')
        await s.tap('Remove Player 2')
        await s.tap('Add Player 2 to Lineup')
        await s.shot('tap-appended')
        await swipeTabs(s, 'Away Team', 'Home Team')
        await s.shot('home-slider')
        await swipeTabs(s, 'Lineup', 'Defense')
        await s.visible('Tap and drag players into their defensive positions.')
        await s.tap('Clear P')
        const from = center(await s.find(/^Player 1$/))
        const slot = await s.find(/^Clear C$/)
        await s.gesture(
          [from, { x: slot.x - 65, y: slot.y + slot.height / 2 }],
          0
        )
        await s.shot('defense-replaced')
        await swipeTabs(s, 'Home Team', 'Away Team')
        await swipeTabs(s, 'Defense', 'Lineup')
        await s.visible('Tap players to add them to the lineup')
        const source = center(await s.find(/^Drag Jordan K\.$/))
        const target = center(await s.find(/^Drag Player 3$/))
        await s.gesture([source, target], 0)
        await s.shot('immediate-lineup-reorder')
        await s.tap('Cancel')
        await s.tap('Open scoring menu')
        await s.tap('Set Team Rosters')
        await ctx.checkpoint(
          'cancel-restores-roster',
          { expect: [{ text: '^Reorder Jordan K\\.$' }] },
          s.m
        )
        await s.shot('cancel-restores-roster')
        await s.tap('Cancel')
        await s.orient('landscape')
        await s.touch(center(await s.find(/^Open scoring menu$/)))
        await s.touch(center(await s.find(/^Set Team Rosters$/)))
        await s.shot('roster-landscape')
        await s.touch(center(await s.find(/^Cancel$/)))
        await s.orient('portrait')
        s.log(
          'PASS roster immediate drag, append, defense replacement, slider swipes and cancel in Safari'
        )
      })
    }
  }
})
