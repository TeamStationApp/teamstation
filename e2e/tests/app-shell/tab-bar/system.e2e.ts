import { strict as assert } from 'node:assert'

import { navTab } from '../../../../src/test/navTab.e2e'
import { dismissNotificationAskOn } from '../../../../src/test/notificationAsk'
import { isHubDevice } from '../../../core/maestro'
import { iosIsSimulator } from '../../../core/prepare'
import { defineE2e } from '../../../core/spec'
import { boxOf, flatten, prove } from '../../../rigs/app/keyboardDock'
import { setServer } from '../../../rigs/app/setServer'
import {
  chatFixture,
  chatTabPixels,
  dragTab,
  openChatList,
  openTabBar,
  requireSystemTabBar,
  withIosAppearance
} from '../../../rigs/app/tabBar'
import { DEVELOP_APP } from '../../../rigs/coach/coachApp'

export default defineE2e({
  id: 'app-shell/tab-bar/system',
  title: 'The iOS system tab bar selects labelled destinations by tap and drag',
  kind: 'e2e',
  covers: [
    'ios/TeamStation/TSTabBarComponentView.mm',
    'src/app/components/SystemTabBar.ios.tsx',
    'src/app/components/AppNav.tsx'
  ],
  stack: 'isolated',
  fixtures: ['team-with-roster'],
  exclusive: false,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'device', needs: ['ios-phone'], hardware: 'none' }]
    }
  },
  services: ['api'],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 5,
  guards: [],
  faults: [],
  manual: false,
  scenarios: {
    'unread-in-dark-appearance': async ctx => {
      const udid = ctx.device('device')
      const { person, roomId } = await chatFixture(ctx)
      const handset = await openTabBar(ctx, 'coach', undefined, person)
      await requireSystemTabBar(handset)
      await withIosAppearance(udid, async set => {
        await set('dark')
        await openChatList(handset, roomId)
        const pixels = await chatTabPixels(handset)
        assert(pixels.red > 6, 'the Chat icon has a red unread badge')
        assert(
          pixels.lightFraction > 0.5,
          'the bar retains the light app theme'
        )
        await prove(ctx, handset, 'ios27-dark-chat-after.png')
      })
    },
    'composer-clearance': async ctx => {
      const { person, roomId } = await chatFixture(ctx)
      const handset = await openTabBar(ctx, 'coach', undefined, person)
      await openChatList(handset, roomId)
      await handset.tapOn({ id: 'chat-conversation-' + roomId })
      await handset.tapOn({ id: 'chat-composer', timeout: 20000 })
      const nodes = flatten(await handset.hierarchy())
      const composer = boxOf(nodes.find(node => node.id === 'chat-composer'))
      const bar = boxOf(nodes.find(node => node.type === 'TabBar'))
      const keyboard = boxOf(nodes.find(node => node.type === 'Keyboard'))
      assert(
        composer != null && (bar != null || keyboard != null),
        'focused composer and bottom controls have frames'
      )
      if (bar != null)
        assert(
          composer.y + composer.height <= bar.y + 1,
          'composer clears the tab bar'
        )
      if (keyboard != null)
        assert(
          composer.y + composer.height <= keyboard.y + 1,
          'composer clears the keyboard'
        )
      await ctx.checkpoint(
        'composer-above-controls',
        { expect: [{ id: 'chat-composer' }] },
        handset
      )
    },
    'offline-banner-clearance': async ctx => {
      const handset = await openTabBar(ctx)
      const udid = ctx.device('device')
      const options = {
        platform: 'ios' as const,
        device: handset,
        udid,
        appId: process.env.TS_TAB_APP_ID ?? DEVELOP_APP,
        hub: isHubDevice(udid),
        simulator: !isHubDevice(udid) && iosIsSimulator(udid)
      }
      try {
        await setServer({ ...options, origin: 'https://offline.invalid' })
        await handset.assertVisible({
          id: 'offlineBanner',
          timeout: 45000
        })
        const nodes = flatten(await handset.hierarchy())
        const banner = boxOf(nodes.find(node => node.id === 'offlineBanner'))
        const tab = boxOf(nodes.find(node => node.id === 'tab-home'))
        assert(
          banner != null && tab != null && tab.y + tab.height <= banner.y + 1,
          'the tab sits above the offline banner'
        )
        await ctx.checkpoint(
          'offline-bar-clearance',
          { expect: [{ id: 'offlineBanner' }, { id: 'tab-home' }] },
          handset
        )
      } finally {
        await setServer({
          ...options,
          origin:
            process.env.TS_TAB_BUILT_ORIGIN == null ? ctx.stack.origin : null
        })
      }
    },
    'five-tabs': async ctx => {
      const handset = await openTabBar(ctx)
      for (const id of [
        'videos',
        'schedule',
        'search',
        'chat',
        'home'
      ] as const) {
        await navTab(handset, id)
        await ctx.checkpoint(
          'selected-' + id,
          { expect: [{ id: 'tab-' + id }] },
          handset
        )
        // Entering messaging asks about notifications, over the bar; nothing
        // here is about that, so answer it Not Now as other scenarios do.
        if (id === 'chat') await dismissNotificationAskOn(handset)
      }
    },
    'drag-lens': async ctx => {
      const handset = await openTabBar(ctx)
      await requireSystemTabBar(handset)
      await dragTab(handset, 'home', 'search')
      await ctx.checkpoint(
        'search-after-drag',
        { expect: [{ id: 'tab-search' }] },
        handset
      )
    }
  }
})
