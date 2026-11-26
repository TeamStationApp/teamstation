import assert from 'node:assert/strict'

import { navTab, navTabSelected } from '../../../../src/test/navTab.e2e'
import { prove } from '../../../rigs/app/keyboardDock'
import {
  chatFixture,
  chatTabPixels,
  dragTab,
  openChatList,
  openTabBar
} from '../../../rigs/app/tabBar'
import { phoneTabSpec } from '../../../rigs/app/tabBarLayout'
import { within } from '../../../rigs/search/searchRig'

export default phoneTabSpec({
  id: 'app-shell/tab-bar/capsule',
  title:
    'The fallback capsule selects each destination by tap and Search by drag',
  covers: [
    'src/app/components/AppNavCapsule.tsx',
    'src/app/components/useCapsuleDrag.ts'
  ],
  scenarios: {
    'tap-and-drag': async ctx => {
      const ios = ctx.surface === 'ios-app'
      const chat = ios ? await chatFixture(ctx) : undefined
      const handset = await openTabBar(
        ctx,
        chat == null ? 'member' : 'coach',
        ios ? 'capsule' : undefined,
        chat?.person
      )
      await handset.assertVisible({ id: 'tab-bar-capsule' })
      if (ios) {
        await handset.assertVisible({ id: 'chat-unread', timeout: 15000 })
        await within(10000, async () => {
          assert(
            (await chatTabPixels(handset)).red > 6,
            'The capsule shows the unread Chat badge'
          )
        })
        await prove(ctx, handset, 'capsule-unread-chat.png')
      }
      for (const id of [
        'videos',
        'schedule',
        'search',
        'chat',
        'home'
      ] as const) {
        if (id === 'chat' && chat != null)
          await openChatList(handset, chat.roomId)
        else await navTab(handset, id)
      }
      if (ctx.surface === 'android-app') {
        await handset.dragAndDrop({
          from: { id: 'tab-home' },
          to: { id: 'tab-search' },
          duration: 600,
          holdDuration: 100
        })
        await navTabSelected(handset, 'search')
      } else await dragTab(handset, 'home', 'search', 600)
      await ctx.checkpoint(
        'search-selected',
        { expect: [{ id: 'search-field-input' }] },
        handset
      )
    }
  }
})
