import { expect } from 'chai'

import { defineE2e } from '../../../core/spec'
import {
  aboveKeyboard,
  APP,
  boxOf,
  flatten,
  measure,
  type Node,
  platformOf,
  typeKeys
} from '../../../rigs/app/keyboardDock'

/**
 * A conversation's composer still rides the keyboard on a phone now that
 * Search shares its hold on Android's keyboard controller. Signs in with
 * the `searchKeyboardChatAccount` secret (`{"email","password"}`, an account
 * with a conversation on the seat the build was made for) and clears the
 * app's state before and after, leaving the phone signed out. A cleared
 * Mason develop build talks to the seat it was built for (`seat=N`), so run
 * it on that seat's build: a setServer choice does not survive the clear.
 * Motion is read from the `<device>#composer` webcam crop, whose rest row
 * is the composer's.
 */
export default defineE2e({
  id: 'app-shell/chat/composer-keyboard',
  title: 'A conversation’s composer rides the keyboard on a phone',
  kind: 'e2e',
  covers: [
    'src/app/chat/ChatHistoryList.native.tsx',
    'src/app/components/keyboardControllerOwner.native.ts'
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
  secrets: ['searchKeyboardChatAccount'],
  costUsd: 0,
  minutes: 5,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'rides-keyboard': async ctx => {
      const account = JSON.parse(ctx.secret('searchKeyboardChatAccount')) as {
        email: string
        password: string
      }
      const ios = platformOf(ctx) === 'ios'
      const device = await ctx.attach('phone', {
        platform: platformOf(ctx),
        appId: APP
      })
      await device.launchApp({ appId: APP, stopApp: true, clearState: true })
      try {
        await device.tapOn({ text: 'Use a password instead', optional: true })
        await device.tapOn({ text: 'E-mail address' })
        await typeKeys(device, ios, account.email)
        await device.tapOn({ text: 'Password' })
        await typeKeys(device, ios, account.password)
        await device.tapOn({ text: 'Sign in' })
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
          'composer'
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
        await device.launchApp({ appId: APP, stopApp: true, clearState: true })
      }
    }
  }
})
