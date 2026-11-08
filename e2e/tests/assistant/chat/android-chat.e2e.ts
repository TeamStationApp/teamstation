import { expect } from 'chai'

import { defineE2e, type E2eContext } from '../../../core/spec'
import { type TessNative, withTessNative } from '../../../rigs/tessNativeRig'

/** She opens from the mark's menu. The header has no Tess button of its own. */
async function openChat(native: TessNative): Promise<void> {
  await native.tap('TeamStation menu')
  await native.tap('Ask Tess')
}

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
        for (const label of ['Tess', 'Notifications'])
          expect(await native.find(label), label).equals(undefined)
        const mark = (await native.find('TeamStation menu'))!.bounds!
        const picture = (await native.nodes()).find(node =>
          (node.text ?? '').startsWith('Account, ')
        )
        if (picture?.bounds == null) throw new Error('No account picture')
        expect(mark.x).lessThan(picture.bounds.x)
        await native.tap('TeamStation menu')
        await native.show('Ask Tess')
        await ctx.checkpoint('header', {
          expect: [{ text: 'Ask Tess' }]
        })
      })
    },
    'bubble-closes-chat-and-opens-settings': async ctx => {
      await onAndroid(ctx, async native => {
        await openChat(native)
        await native.show('Ask Tess')
        await native.say(
          'Where are my team settings?',
          "Your team's settings are here"
        )
        await ctx.checkpoint('chat', {
          expect: [{ text: "Your team's settings are here" }]
        })
        await native.tap('Go to Home, Demo Hawks, Settings')
        await native.hidden('Close Tess')
        await ctx.checkpoint('settings', {
          expect: [{ text: 'Team Settings' }]
        })
      })
    },
    'hardware-back-closes-only-the-chat': async ctx => {
      await onAndroid(ctx, async native => {
        await openChat(native)
        await native.show('Close Tess')
        await native.m.back()
        await native.hidden('Close Tess')
        await native.show('TeamStation menu')
        await ctx.checkpoint('home-unchanged', {
          expect: [{ text: 'TeamStation menu' }]
        })
      })
    },
    'sheet-offers-photo-and-file': async ctx => {
      await onAndroid(ctx, async native => {
        await openChat(native)
        await native.tap('Attach a file')
        await ctx.checkpoint('attach-sheet', {
          expect: [{ text: 'Photo' }, { text: 'File' }]
        })
      })
    }
  }
})
