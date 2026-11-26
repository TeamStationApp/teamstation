import { strict as assert } from 'node:assert'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { PNG } from 'pngjs'

import { TeamStationClient } from '../../../../src/common/api'
import { navTab } from '../../../../src/test/navTab.e2e'
import { dismissNotificationAskOn } from '../../../../src/test/notificationAsk'
import { testPasswordKdf } from '../../../../src/test/passwordFixtures'
import type { FixtureAccount } from '../../../core/fixtures'
import { isHubDevice } from '../../../core/maestro'
import { iosIsSimulator } from '../../../core/prepare'
import { defineE2e, type E2eContext } from '../../../core/spec'
import { boxOf, flatten, prove } from '../../../rigs/app/keyboardDock'
import { setServer } from '../../../rigs/app/setServer'
import { dragTab, openTabBar } from '../../../rigs/app/tabBar'
import { DEVELOP_APP } from '../../../rigs/coach/coachApp'

async function chatFixture(
  ctx: E2eContext
): Promise<{ person: FixtureAccount; roomId: string }> {
  const world = await ctx.fixture('team-with-roster')
  const person = world.accounts.coach
  const client = new TeamStationClient({
    baseUrl: ctx.stack.origin + '/api/v1',
    passwordKdf: testPasswordKdf
  })
  await client.signInWithPassword(person.email, person.password)
  await client.setMyAge({ adult: true })
  for (let attempt = 0; attempt < 40; attempt++) {
    const room = (await client.chatConversations()).find(
      item => item.scope?.id === world.ids.team
    )
    if (room != null) {
      await client.updateChatPreferences(room.id, { manualUnread: true })
      return { person, roomId: room.id }
    }
    await new Promise(resolve => setTimeout(resolve, 1000))
  }
  throw new Error('The seeded team has no chat conversation')
}

/** Fresh accounts can receive the notification prompt as the chat list first opens. */
async function openChatList(
  handset: Awaited<ReturnType<typeof openTabBar>>,
  roomId: string
): Promise<void> {
  await navTab(handset, 'chat')
  await handset.assertVisible({
    id: 'chat-conversation-' + roomId,
    timeout: 45000
  })
  const later = { id: 'notification-ask-not-now' }
  const prompt: boolean = await handset
    .assertVisible({ ...later, timeout: 5000 })
    .then(
      () => true,
      () => false
    )
  if (prompt) {
    await handset.tapOn(later)
    await handset.assertNotVisible({ ...later, timeout: 10000 })
  }
}

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
      assert(
        !isHubDevice(udid) && iosIsSimulator(udid),
        'needs the iOS appearance control'
      )
      const { person, roomId } = await chatFixture(ctx)
      const handset = await openTabBar(ctx, 'coach', undefined, person)
      const appearance = async (style: string): Promise<void> => {
        await promisify(execFile)('xcrun', [
          'simctl',
          'ui',
          udid,
          'appearance',
          style
        ])
      }
      await appearance('dark')
      try {
        await openChatList(handset, roomId)
        const root = await handset.hierarchy()
        const frame = boxOf(root)
        const chat = boxOf(flatten(root).find(node => node.id === 'tab-chat'))
        assert(frame != null && chat != null)
        // UIKit draws the dot inside the item; its screen pixels are the evidence.
        const shot = PNG.sync.read(Buffer.from(await handset.screenshot()))
        const scale = shot.width / frame.width
        let red = 0
        let light = 0
        for (
          let y = Math.round(chat.y * scale);
          y < (chat.y + chat.height) * scale;
          y++
        ) {
          for (
            let x = Math.round(chat.x * scale);
            x < (chat.x + chat.width) * scale;
            x++
          ) {
            const i = 4 * (y * shot.width + x)
            const [r, g, b] = shot.data.subarray(i, i + 3)
            if (r > 200 && g < 110 && b < 110) red++
            if (r > 180 && g > 180 && b > 180) light++
          }
        }
        assert(red > 6 * scale * scale, 'the Chat icon has a red unread badge')
        assert(
          light > (chat.width * chat.height * scale * scale) / 2,
          'the bar retains the light app theme'
        )
        await prove(ctx, handset, 'ios27-dark-chat-after.png')
      } finally {
        await appearance('light')
      }
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
      await dragTab(handset, 'home', 'search')
      await ctx.checkpoint(
        'search-after-drag',
        { expect: [{ id: 'tab-search' }] },
        handset
      )
    }
  }
})
