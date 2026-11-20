import { expect } from 'chai'

import { defineE2e, type E2eContext } from '../../../core/spec'
import {
  APP,
  boxOf,
  deviceName,
  flatten,
  type Node,
  openSearch,
  PLACEHOLDER,
  platformOf,
  prove,
  typeKeys
} from '../../../rigs/app/keyboardDock'

/** Picks San Diego from the suggestions, leaving its pill in the field. */
async function chooseSanDiego(ctx: E2eContext, device: any): Promise<void> {
  await openSearch(device)
  await device.tapOn({ text: PLACEHOLDER })
  await typeKeys(device, platformOf(ctx) === 'ios', 'san d')
  await device.assertVisible({ id: 'location-suggestions', timeout: 15000 })
  await device.tapOn({ text: 'Choose San Diego, CA' })
  await device.assertVisible({ id: 'location-pill', timeout: 10000 })
}

/**
 * The chosen place's pill on a phone or tablet: its close circle sits on the
 * pill's midline, its centre half the pill's height in from its right end,
 * and Backspace in the empty field takes the pill out. The app is a Mason
 * develop build, as for `keyboard-dock`.
 */
export default defineE2e({
  id: 'app-shell/search/pill-device',
  title:
    'A chosen place’s pill centres its close circle at its end and goes with Backspace, on a phone',
  kind: 'e2e',
  covers: [
    'src/app/components/LocationPill.tsx',
    'src/app/screens/SearchScreen.tsx',
    'src/app/theme/pill.ts'
  ],
  stack: 'none',
  fixtures: [],
  exclusive: false,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'phone', needs: ['ios-phone'], hardware: 'none' }]
    },
    'android-app': {
      devices: [{ role: 'phone', needs: ['android-phone'], hardware: 'none' }]
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
  sendsNoMail: true,
  scenarios: {
    'x-centred': async ctx => {
      const device = await ctx.attach('phone', {
        platform: platformOf(ctx),
        appId: APP
      })
      await chooseSanDiego(ctx, device)
      const nodes = flatten((await device.hierarchy()) as Node)
      // The circle itself: the remove target overflows the pill, and
      // Android reports a child's bounds clipped to its parent's.
      const pill = boxOf(nodes.find(node => node.id === 'location-pill'))
      const circle = boxOf(nodes.find(node => node.id === 'location-pill-mark'))
      await prove(
        ctx,
        device,
        `${await deviceName(ctx, device)}-chosen-x-after.png`
      )
      await ctx.checkpoint('x-centred', {
        expect: [{ id: 'location-pill' }],
        readBack: async () => {
          expect(pill, 'the chosen pill').not.equals(undefined)
          expect(circle, 'its circle').not.equals(undefined)
          const { x, y, width, height } = pill!
          const centre = {
            x: circle!.x + circle!.width / 2,
            y: circle!.y + circle!.height / 2
          }
          // Half a point at the pill's 20, finer than the one-point offset
          // a border gave it: the hierarchy is in pixels on Android and
          // points on iOS.
          const point = height / 40
          expect(centre.y, 'on the pill’s midline').closeTo(
            y + height / 2,
            point
          )
          expect(
            x + width - centre.x,
            'half the height in from its end'
          ).closeTo(height / 2, point)
        }
      })
    },

    'backspace-removes': async ctx => {
      const device = await ctx.attach('phone', {
        platform: platformOf(ctx),
        appId: APP
      })
      await chooseSanDiego(ctx, device)
      await device.pressKey('Backspace')
      await ctx.checkpoint('pill-removed-by-backspace', {
        expect: [{ id: 'location-pill', absent: true }],
        readBack: async () => {
          await device.assertNotVisible({ id: 'location-pill', timeout: 5000 })
          // Still in Search's field, with nothing in it.
          await device.assertVisible({ id: 'Search field' })
        }
      })
    }
  }
})
