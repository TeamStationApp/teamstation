import { expect } from 'chai'

import { defineE2e, type E2eContext } from '../../../core/spec'
import { type TessNative, withTessNative } from '../../../rigs/tessNativeRig'

async function onAndroid(
  ctx: E2eContext,
  run: (native: TessNative) => Promise<void>
): Promise<void> {
  await withTessNative(ctx, { surface: 'android-app' }, run)
}

export default defineE2e({
  id: 'assistant/chat/android-chat',
  title:
    'On Android Tess is a full-screen chat that the hardware Back closes, with her links and her sheet',
  kind: 'e2e',
  covers: [
    'src/app/tess/useTessBack.native.ts',
    'src/app/tess/pickAttachments.native.ts',
    'src/app/tess/AttachPicker.native.tsx'
  ],
  stack: 'isolated',
  fixtures: [],
  exclusive: false,
  surfaces: {
    'android-app': {
      devices: [{ role: 'user', needs: ['android-phone'], hardware: 'none' }]
    }
  },
  services: ['web'],
  apps: ['teamstation-android'],
  secrets: [],
  costUsd: 0,
  minutes: 4,
  guards: [],
  faults: ['app-crash'],
  manual: false,
  scenarios: {
    'button-before-notifications': async ctx => {
      await onAndroid(ctx, async native => {
        await native.show('Tess')
        const order = await native.headerOrder()
        expect(order.indexOf('Tess')).lessThan(order.indexOf('Notifications'))
        await ctx.checkpoint('header', {
          expect: [{ text: 'Tess' }],
          golden: {}
        })
      })
    },
    'bubble-closes-chat-and-opens-settings': async ctx => {
      await onAndroid(ctx, async native => {
        await native.tap('Tess')
        await native.show('Ask Tess')
        await native.say(
          'Where are my team settings?',
          "Your team's settings are here"
        )
        await ctx.checkpoint('chat', { golden: {} })
        await native.tap('Go to Home, Demo Hawks, Settings')
        await native.hidden('Close Tess')
        await ctx.checkpoint('settings', {
          expect: [{ text: 'Team Settings' }],
          golden: {}
        })
      })
    },
    'hardware-back-closes-only-the-chat': async ctx => {
      await onAndroid(ctx, async native => {
        await native.tap('Tess')
        await native.say(
          'Where are my team settings?',
          "Your team's settings are here"
        )
        await native.tap('Go to Home, Demo Hawks, Settings')
        await native.hidden('Close Tess')
        await native.tap('Tess')
        await native.show('Close Tess')
        await native.m.back()
        await native.hidden('Close Tess')
        await ctx.checkpoint('settings-unchanged', {
          expect: [{ text: 'Team Settings' }]
        })
      })
    },
    'sheet-offers-photo-and-file': async ctx => {
      await onAndroid(ctx, async native => {
        await native.tap('Tess')
        await native.tap('Attach a file')
        await ctx.checkpoint('attach-sheet', {
          expect: [{ text: 'Photo' }, { text: 'File' }],
          golden: {}
        })
      })
    }
  }
})
