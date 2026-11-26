import assert from 'node:assert/strict'

import { navTab } from '../../../../src/test/navTab.e2e'
import { boxOf, flatten } from '../../../rigs/app/keyboardDock'
import { openTabBar } from '../../../rigs/app/tabBar'
import {
  controlBox,
  longHome,
  phoneTabSpec
} from '../../../rigs/app/tabBarLayout'
import { within } from '../../../rigs/search/searchRig'

export default phoneTabSpec({
  id: 'app-shell/tab-bar/compact',
  title:
    'Home scrolling compacts the phone bar and a docked search keeps its clearance',
  covers: [
    'src/app/components/navCompact.tsx',
    'src/app/components/Screen.tsx',
    'ios/TeamStation/TSTabBarComponentView.mm'
  ],
  scenarios: {
    'scroll-and-switch': async ctx => {
      const handset = await longHome(ctx)
      const full = await controlBox(handset, 'tab-home')
      const scroll = async (advance: boolean): Promise<void> => {
        if (ctx.surface === 'ios-app') {
          await handset.swipe({
            start: advance ? '50%, 76%' : '50%, 28%',
            end: advance ? '50%, 18%' : '50%, 64%',
            duration: 600
          })
          return
        }
        // Anchor the gesture to visible content. A hub phone can be mounted
        // sideways while TeamStation locks the window to portrait.
        const belowHeader = full.height * 2
        const bar = await controlBox(handset, 'tab-home')
        const buttons = flatten(await handset.hierarchy())
          .filter(
            node =>
              node.type === 'Button' &&
              node.text != null &&
              node.bounds != null &&
              node.bounds.y > belowHeader &&
              node.bounds.y + node.bounds.height < bar.y - 8
          )
          .sort((a, b) => a.bounds!.y - b.bounds!.y)
        assert(
          buttons.length >= 2,
          'Home has two visible controls to drag between'
        )
        const top = { text: buttons[0].text! }
        const bottom = { text: buttons.at(-1)!.text! }
        await handset.dragAndDrop({
          from: advance ? bottom : top,
          to: advance ? top : bottom,
          duration: 600,
          holdDuration: 0
        })
      }
      const compact = async (): Promise<void> => {
        await within(6000, async () => {
          const slot = await controlBox(handset, 'tab-home')
          assert(
            slot.width < full.width - 3,
            'Home slot narrows while scrolling down'
          )
        })
      }
      const expanded = async (): Promise<void> => {
        await within(6000, async () => {
          const slot = await controlBox(handset, 'tab-home')
          assert(
            Math.abs(slot.width - full.width) <= 2,
            'Home slot returns to its expanded size'
          )
        })
      }
      await scroll(true)
      await compact()
      await scroll(false)
      await expanded()
      await scroll(true)
      await compact()
      // The fixture owns teams only, so Create Season is the last card on Home.
      await within(18000, async () => {
        const rows = flatten(await handset.hierarchy())
        const card = boxOf(
          rows.find(
            node =>
              (node.text === 'Create Season' ||
                node.accessibilityText === 'Create Season' ||
                node.id === 'Create Season') &&
              (boxOf(node)?.height ?? 0) > full.height
          )
        )
        const barTop = (await controlBox(handset, 'tab-home')).y
        if (card != null && card.y + card.height <= barTop + 1) return
        await scroll(true)
        throw new Error('The last Home card has not yet cleared the bar')
      })
      await navTab(handset, 'videos')
      await expanded()
      await ctx.checkpoint(
        'expanded-on-videos',
        { expect: [{ id: 'tab-videos' }] },
        handset
      )
    },
    'docked-search': async ctx => {
      const handset = await openTabBar(ctx)
      await navTab(handset, 'search')
      const bar = await controlBox(handset, 'tab-search')
      const dock = await controlBox(handset, 'search-dock')
      await handset.tapOn({ id: 'search-field-input' })
      await handset.inputText({ text: 'team' })
      await handset.hideKeyboard()
      await handset.swipe({ start: '50%, 68%', end: '50%, 20%', duration: 550 })
      await within(6000, async () => {
        const current = await controlBox(handset, 'search-dock')
        const tab = await controlBox(handset, 'tab-search')
        assert(Math.abs(tab.width - bar.width) <= 2)
        assert(
          Math.abs(
            current.y + current.height - tab.y - (dock.y + dock.height - bar.y)
          ) <= 3
        )
      })
      await ctx.checkpoint(
        'search-dock-above-bar',
        { expect: [{ id: 'search-dock' }] },
        handset
      )
    }
  }
})
