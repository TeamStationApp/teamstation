import { defineHarness } from '../../../core/spec'
import {
  center,
  type PhoneScorer,
  withPhoneScorer
} from '../../../rigs/scoring/phoneWebScorer'

/** Taps the text field labelled `label`. */
async function field(s: PhoneScorer, label: string): Promise<void> {
  const node = (await s.nodes()).find(
    n => n.type === 'TextField' && n.text === label
  )
  if (node?.bounds == null) throw new Error(`Missing input ${label}`)
  await s.touch(center(node.bounds))
}

/**
 * Setting players up from the scoring screen in Safari on an iPhone: the
 * player form focuses its first field, keeps the hands and positions chosen,
 * saves and resets for another, the new player is offered to the lineup
 * until the roster is cancelled, placeholder players are cancelled, added
 * one and then three at a time from the count wheel, the rosters save and
 * undo, and the sheet opens full screen in landscape.
 */
export default defineHarness({
  id: 'scoring/phone-web/player-setup',
  title:
    'Safari scoring creates players and placeholders from the roster, and saves and undoes the rosters',
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
  minutes: 8,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'players-and-placeholders': async ctx => {
      await withPhoneScorer(ctx, async s => {
        const { m } = s
        await s.orient('portrait')
        await s.freshGame({ restart: true })
        await s.tap('Open scoring menu')
        await s.tap('Set Team Rosters')
        await m.scrollUntilVisible({
          element: { text: '^Create Player$' },
          direction: 'DOWN'
        })
        await s.shot('before-create')
        await s.touch(center(await s.find(/^Create Player$/)))
        await s.visible('^First Name$')
        await s.shot('player-form-focused')
        await m.inputText('Alex')
        await field(s, 'Last Name')
        await m.inputText('Safari')
        await field(s, 'Jersey Number')
        await m.inputText('07')
        await m.hideKeyboard()
        await s.tap('Throws L')
        await s.tap('Bats S')
        await s.tap('Player position P')
        await m.scrollUntilVisible({
          element: { text: '^Player position DH$' },
          direction: 'DOWN'
        })
        await s.tap('Player position DH')
        await m.scrollUntilVisible({
          element: { text: '^Save and Add Another Player$' },
          direction: 'DOWN'
        })
        await s.shot('player-form-preferences')
        await s.tap('Save and Add Another Player')
        await s.visible('^First Name$')
        await s.shot('player-form-reset')
        await m.hideKeyboard()
        await s.tap('Cancel')
        await m.scrollUntilVisible({
          element: { text: '^Add Alex Safari to Lineup$' },
          direction: 'DOWN'
        })
        await s.visible('^Add Alex Safari to Lineup$')
        await s.shot('added-player-roster')
        await s.tap('Cancel')
        await s.tap('Open scoring menu')
        await s.tap('Set Team Rosters')
        await s.absent('^Add Alex Safari to Lineup$')
        await s.tap('Cancel')
        await s.tap('Open scoring menu')
        await s.tap('Set Team Rosters')
        await s.tap('Add Placeholder Players')
        await s.visible('^Number of placeholder players$')
        const cancels = (await s.nodes()).filter(n => n.text === 'Cancel')
        const lastCancel = cancels[cancels.length - 1]?.bounds
        if (lastCancel == null) throw new Error('No Cancel on the count sheet')
        await s.touch(center(lastCancel))
        await s.absent('^Add Owls A to Lineup$')
        await s.tap('Add Placeholder Players')
        await s.tap('Add')
        await m.scrollUntilVisible({
          element: { text: '^Add Owls A to Lineup$' },
          direction: 'DOWN'
        })
        await s.visible('^Add Owls A to Lineup$')
        await s.tap('Add Placeholder Players')
        const wheel = await s.find(/^Number of placeholder players$/)
        await s.gesture([
          { x: wheel.x + wheel.width / 2, y: wheel.y + wheel.height - 25 },
          { x: wheel.x + wheel.width / 2, y: wheel.y + 25, duration: 800 }
        ])
        await s.shot('placeholder-wheel-scrolled')
        await s.tap('Player count 3')
        await s.tap('Add')
        await s.gesture([
          { x: 95, y: 570 },
          { x: 95, y: 380, duration: 700 }
        ])
        await ctx.checkpoint(
          'placeholder-batch-added',
          { expect: [{ text: '^Add Owls D to Lineup$' }] },
          s.m
        )
        await s.shot('placeholder-batch-added')
        await s.tap('Save Rosters')
        await s.tap('Undo Set team roster')
        s.log(
          'PASS Safari player form, placeholder cancel, scrolling, repeat batch, save and undo'
        )
        await s.orient('landscape')
        await s.touch(center(await s.find(/^Open scoring menu$/)))
        await s.touch(center(await s.find(/^Set Team Rosters$/)))
        await s.shot('full-screen-landscape')
        await s.touch(center(await s.find(/^Cancel$/)))
        await s.orient('portrait')
        s.log(
          'PASS full-screen roster, focused player form, preferences, repeated entry and Cancel'
        )
      })
    }
  }
})
