import { expect } from 'chai'

import { defineHarness } from '../../../core/spec'
import {
  aboveKeyboard,
  appOf,
  type Box,
  boxOf,
  flatten,
  measure,
  type Node,
  platformOf,
  typeKeys
} from '../../../rigs/app/keyboardDock'
import { pointAtStack } from '../../../rigs/app/pointAtStack'

/** The conversation's composer, where it rests. */
async function composerBox(device: any): Promise<Box> {
  const box = boxOf(
    flatten((await device.hierarchy()) as Node).find(
      node => node.id === 'chat-composer'
    )
  )
  if (box == null) throw new Error('the composer is not on screen')
  return box
}

/**
 * A conversation's composer still rides the keyboard on a phone now that
 * Search shares its hold on Android's keyboard controller. Signs in as the
 * `messaging` world's sender, who has a conversation, and clears the app's
 * state before and after, leaving the phone signed out; a clear forgets
 * the stack, so the app is pointed back at it after. Motion is read from
 * maestro-d's recording of the screen, from the composer's place at rest.
 */
export default defineHarness({
  id: 'app-shell/chat/composer-keyboard',
  title: 'A conversation’s composer rides the keyboard on a phone',
  kind: 'e2e',
  covers: [
    'src/app/chat/ChatHistoryList.native.tsx',
    'src/app/components/keyboardControllerOwner.native.ts'
  ],
  stack: 'isolated',
  fixtures: ['messaging'],
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
      await ctx.fixture('messaging')
      const ios = platformOf(ctx) === 'ios'
      const appId = appOf(ctx)
      const device = await ctx.attach('phone', {
        platform: platformOf(ctx),
        appId
      })
      await device.launchApp({ appId, stopApp: true, clearState: true })
      try {
        await pointAtStack(device, ctx.stack.origin, appId)
        await ctx.signIn('sender', device)
        await device.tapOn({ text: 'Chat' })
        await device.tapOn({ id: 'chat-conversation-.*' })
        let composer: ReturnType<typeof boxOf>
        let above: Awaited<ReturnType<typeof aboveKeyboard>> = null
        const motion = await measure(
          ctx,
          device,
          'composer',
          async () => {
            await device.tapOn({ id: 'chat-composer' })
            await typeKeys(device, ios, 'keyboard')
            composer = boxOf(
              flatten((await device.hierarchy()) as Node).find(
                node => node.id === 'chat-composer'
              )
            )
            if (composer != null) above = await aboveKeyboard(device, composer)
            await device.eraseText({ characters: 8 })
            await device.hideKeyboard()
          },
          composerBox
        )
        await ctx.checkpoint('composer-over-keyboard', {
          expect: [{ id: 'chat-composer' }],
          readBack: async () => {
            expect(composer, 'the composer is on screen').not.equals(undefined)
            if (above != null)
              expect(
                (above as { above: boolean }).above,
                'the composer rides above the keyboard'
              ).equals(true)
            if (motion != null) {
              expect(motion.up, 'it rose through the keyboard’s frames').equals(
                true
              )
              expect(motion.down, 'and came down through them').equals(true)
            }
          }
        })
      } finally {
        // Signed out again, as the other phone scenarios expect.
        await device.launchApp({ appId, stopApp: true, clearState: true })
      }
    }
  }
})
