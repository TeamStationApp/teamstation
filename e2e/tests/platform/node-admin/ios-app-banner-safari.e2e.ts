import type { NodeSettings } from '../../../../src/common/nodeSettings'
import { defineHarness } from '../../../core/spec'
import { apiClient } from '../../../rigs/search/searchRig'

/** Safari owns this action and supplies its label according to installation state. */
export default defineHarness({
  id: 'platform/node-admin/ios-app-banner-safari',
  title: 'Safari offers the published app on a physical iPhone or iPad',
  kind: 'e2e',
  covers: [
    'src/app/web/iosAppBanner.ts',
    'src/server/routes/nodeAdministration.ts'
  ],
  stack: 'isolated',
  fixtures: ['search'],
  exclusive: true,
  surfaces: {
    'web-safari-ios': {
      // Safari's App Store action needs the App Store, which no simulator has.
      devices: [{ role: 'phone', needs: ['ios-phone'], simulator: 'never' }]
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
  scenarios: {
    'native-safari': async ctx => {
      const world = await ctx.fixture('search')
      const admin = await apiClient(ctx, world.accounts.nodeAdmin)
      const original: NodeSettings = await admin.nodeSettings()
      const write = async (iosAppStoreUrl: string): Promise<void> => {
        const settings: NodeSettings = await admin.nodeSettings()
        await admin.setNodeSettings({
          ...settings,
          distribution: { ...settings.distribution, iosAppStoreUrl }
        })
      }
      const address = ctx.stack.origin + '/sign-in'
      const action = {
        id: String.raw`^AppStoreComponents\.offerButton$`,
        childOf: {
          id: String.raw`^AppStoreComponents\.Lockup\[id=6824597245\]$`
        }
      }
      const home = { id: 'Home', timeout: 60000 }
      try {
        await write('')
        const safari = await ctx.mobileBrowser('phone', address)
        await safari.assertVisible(home)
        await safari.assertNotVisible(action)
        await write('https://apps.apple.com/us/app/teamstation/id6824597245')
        await safari.openLink({ link: address + '?banner=set', browser: true })
        await safari.assertVisible(home)
        await safari.assertVisible({ ...action, timeout: 30000 })
        await safari.takeScreenshot({
          path: ctx.artifact('native-safari-after.png')
        })
        await ctx.checkpoint('store-action', { expect: [action] })
        await write('')
        await safari.openLink({
          link: address + '?banner=clear',
          browser: true
        })
        await safari.assertVisible(home)
        await safari.assertNotVisible(action)
        await ctx.checkpoint('cleared', {
          expect: [{ ...action, absent: true }]
        })
      } finally {
        await write(original.distribution.iosAppStoreUrl)
      }
    }
  }
})
