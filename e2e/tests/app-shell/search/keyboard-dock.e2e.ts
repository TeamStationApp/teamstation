import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import {
  aboveKeyboard,
  appOf,
  boxOf,
  boxOfField,
  deviceName,
  flatten,
  measure,
  type Node,
  openSearch,
  PLACEHOLDER,
  platformOf,
  prove,
  tapTab,
  typeKeys
} from '../../../rigs/app/keyboardDock'

/**
 * Search's dock on a phone or tablet: the location pills sit directly above
 * the field, and both ride the keyboard up and back down through the frames
 * of its animation; a drag of the results puts the keyboard away, animated.
 * The runner installs the caller's develop build and points it at the run's
 * stack, which holds the `search` world for the results to come from; the
 * motion is read from maestro-d's recording of the device's screen.
 */
export default defineHarness({
  id: 'app-shell/search/keyboard-dock',
  title:
    'Search’s dock rides the keyboard up and down on a phone, with its location pills above the field',
  kind: 'e2e',
  covers: [
    'src/app/screens/SearchScreen.tsx',
    'src/app/screens/SearchDock.native.tsx',
    'src/app/components/keyboardControllerOwner.native.ts',
    'src/app/components/LocationPill.tsx'
  ],
  stack: 'isolated',
  fixtures: ['search'],
  exclusive: false,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-phone'], simulator: 'allowed' }]
    },
    'android-app': {
      devices: [
        { role: 'phone', needs: ['android-phone'], simulator: 'allowed' }
      ]
    }
  },
  services: [],
  apps: ['teamstation-ios', 'teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 5,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'rides-keyboard': async ctx => {
      await ctx.fixture('search')
      const device = await ctx.attach('phone', {
        platform: platformOf(ctx),
        appId: appOf(ctx)
      })
      await openSearch(ctx, device)
      const rest = await boxOfField(device)
      await ctx.checkpoint('dock-at-rest', {
        expect: [{ text: PLACEHOLDER }]
      })
      const motion = await measure(ctx, device, 'keyboard', async () => {
        await device.tapOn({ text: PLACEHOLDER })
        await typeKeys(device, platformOf(ctx) === 'ios', 'san')
        await device.assertVisible({
          id: 'location-suggestions',
          timeout: 15000
        })
        await prove(
          ctx,
          device,
          `${await deviceName(ctx, device)}-search-keyboard-after.png`
        )
        // Raised: well up from its rest, over the keyboard where the
        // hierarchy shows one, with the pills directly above it.
        const raised = await boxOfField(device)
        const above = await aboveKeyboard(device, raised)
        const pillsUp = boxOf(
          flatten((await device.hierarchy()) as Node).find(
            node => node.id === 'location-suggestions'
          )
        )
        await ctx.checkpoint('dock-raised', {
          expect: [{ id: 'location-suggestions' }],
          readBack: async () => {
            // A keyboard is many times the field's height: rising at least
            // twice it rules out a dock that stayed put.
            expect(raised.y, 'the dock rose with the keyboard').lessThan(
              rest.y - 2 * rest.height
            )
            if (above != null)
              expect(
                above.above,
                `the field (${JSON.stringify(raised)}) sits above the keyboard (${JSON.stringify(above.keyboard)})`
              ).equals(true)
            expect(pillsUp, 'the pills ride with it').not.equals(undefined)
            expect(
              pillsUp!.y + pillsUp!.height,
              'the pills sit directly above the field'
            ).closeTo(raised.y, 24)
          }
        })
        // A drag of the results puts the keyboard away.
        // Above the raised dock on a phone and on a sideways iPad alike.
        await device.swipe({ start: '50%, 28%', end: '50%, 12%' })
      })
      const after = await boxOfField(device)
      await ctx.checkpoint('dock-down-again', {
        expect: [{ id: 'location-suggestions' }],
        readBack: async () => {
          expect(after.y, 'the dock is back at rest').closeTo(rest.y, 4)
        }
      })
      // The pills ride directly above the field.
      const nodes = flatten((await device.hierarchy()) as Node)
      const pills = boxOf(
        nodes.find(node => node.id === 'location-suggestions')
      )
      if (pills != null)
        expect(pills.y + pills.height, 'pills above the field').lessThanOrEqual(
          after.y + 1
        )
      if (motion != null) {
        expect(motion.up, 'the dock rose through the keyboard’s frames').equals(
          true
        )
        expect(motion.down, 'and came down through them').equals(true)
      }
      // A push to a result and back still slides.
      // A row opens through its own target, labelled "Open <name>", once the
      // drag's scroll has come to rest (a tap on a moving list only stops it).
      await new Promise(resolve => setTimeout(resolve, 1500))
      // The first rows may have scrolled up under the header: take one well
      // within the list, between the header and the docked field.
      const row = flatten((await device.hierarchy()) as Node)
        .filter(node =>
          (node.text ?? node.accessibilityText ?? '').startsWith('Open ')
        )
        .map(boxOf)
        .find(
          box =>
            box != null &&
            box.y + box.height / 2 > rest.y * 0.25 &&
            box.y + box.height / 2 < rest.y * 0.75
        )
      if (row == null)
        throw new Error('no result row in the middle of the list')
      await device.tapOn({
        point: `${Math.round(row.x + row.width / 2)},${Math.round(row.y + row.height / 2)}`
      })
      await new Promise(resolve => setTimeout(resolve, 2000))
      // iOS has no back key: the edge swipe its pages answer.
      if (platformOf(ctx) === 'ios')
        await device.swipe({ start: '1%, 50%', end: '80%, 50%' })
      else await device.back()
      // Back on Search, the field holding what was typed. Had the tap not
      // opened the result, back would have left the tab, and Search with it.
      await device.assertVisible({ id: 'Search field', timeout: 10000 })
    },

    'sign-in-field': async ctx => {
      const device = await ctx.attach('phone', {
        platform: platformOf(ctx),
        appId: appOf(ctx)
      })
      // Search first, with its keyboard up, then away to sign-in: the field
      // there must still rise clear of its keyboard once Search has let go.
      await openSearch(ctx, device, { signedOut: true })
      await device.tapOn({ text: PLACEHOLDER })
      await typeKeys(device, platformOf(ctx) === 'ios', 'san')
      // A phone's keyboard covers its floating tab bar: put it away to reach
      // Home. An iPad's tabs are in its header, and hiding its keyboard
      // there leaves it collapsed for the next field.
      if ((await deviceName(ctx, device)) !== 'ipad')
        await device.hideKeyboard()
      await tapTab(device, 'Home')
      await device.assertVisible({ text: 'E-mail address', timeout: 15000 })
      await device.tapOn({ text: 'E-mail address' })
      await typeKeys(device, platformOf(ctx) === 'ios', 'keyboard@example.test')
      const nodes = flatten((await device.hierarchy()) as Node)
      const email = boxOf(
        nodes.find(
          node =>
            node.accessibilityText === 'E-mail address' ||
            node.text === 'E-mail address' ||
            node.text === 'keyboard@example.test'
        )
      )
      if (email == null) throw new Error('the e-mail field is not on screen')
      const above = await aboveKeyboard(device, email)
      await ctx.checkpoint('sign-in-over-keyboard', {
        expect: [{ text: 'keyboard@example.test' }],
        readBack: async () => {
          if (above != null)
            expect(above.above, 'the field stays above the keyboard').equals(
              true
            )
        }
      })
      await device.hideKeyboard()
    }
  }
})
