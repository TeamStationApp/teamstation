import { expect } from 'chai'

import { defineE2e, type E2eContext } from '../../../core/spec'
import { type TessNative, withTessNative } from '../../../rigs/tessNativeRig'

/**
 * Her chat on an iPad lying on its side. Opening the chat turns dictation on, which
 * starts the microphone, and a simulator's is the Mac's, where starting it can stall and
 * abort the app; none of this talks, so it goes without. The media library is allowed
 * for DJ Game. Mixed answers leave system alerts to the script: all-deny would have the
 * driver dismiss every alert, and it dismisses iOS's "Open in TeamStation?" with Cancel,
 * which throws the DJ link away.
 */
async function onTablet(
  ctx: E2eContext,
  run: (native: TessNative) => Promise<void>
): Promise<void> {
  await withTessNative(
    ctx,
    {
      surface: 'ios-app',
      landscape: true,
      launch: { permissions: { microphone: 'deny', medialibrary: 'allow' } }
    },
    run
  )
}

export default defineE2e({
  id: 'assistant/chat/tablet-split',
  title:
    'On a tablet on its side Tess sits beside the app; upright she fills it, and DJ Game hides her',
  kind: 'e2e',
  covers: [
    'src/app/tess/TessOverlayLayer.native.tsx',
    'src/app/tess/tessLayout.ts',
    'src/app/navigation/**'
  ],
  stack: 'isolated',
  fixtures: [],
  exclusive: false,
  surfaces: {
    'ios-app': {
      devices: [{ role: 'user', needs: ['ipad'], hardware: 'none' }]
    }
  },
  services: ['web'],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 4,
  guards: [],
  faults: ['app-crash'],
  manual: false,
  scenarios: {
    'column-beside-the-app': async ctx => {
      await onTablet(ctx, async native => {
        await native.tap('Tess')
        await native.show('Ask Tess')
        const field = (await native.find('Tess field'))!.bounds!
        expect(field.x + field.width).lessThanOrEqual(400)
        await ctx.checkpoint('split', {
          expect: [{ text: 'Notifications' }],
          golden: {}
        })
      })
    },
    'bubble-navigates-the-pane-and-chat-stays': async ctx => {
      await onTablet(ctx, async native => {
        await native.tap('Tess')
        await native.say(
          'Where are my team settings?',
          "Your team's settings are here"
        )
        await native.tap('Go to Home, Demo Hawks, Settings')
        await native.showExactly('Team Settings')
        await ctx.checkpoint('settings-beside-chat', {
          expect: [{ text: 'Close Tess' }],
          golden: {}
        })
      })
    },
    'viewer-over-the-pane-only': async ctx => {
      await onTablet(ctx, async native => {
        const { t } = native
        await native.tap('Tess')
        await native.say('Show our standings as a table', 'The standings')
        await native.tap('Open full screen')
        const viewerClose = (await native.exactly('Close'))!
        expect(viewerClose.bounds!.x).greaterThan(400)
        await ctx.checkpoint('table-over-pane', {
          expect: [{ text: 'Ask Tess' }],
          golden: {}
        })
        await native.tap('Close')
        expect(t.beaconHits(), 'a remote load').equals(0)
      })
    },
    'upright-fills-the-screen': async ctx => {
      await onTablet(ctx, async native => {
        await native.tap('Tess')
        await native.show('Ask Tess')
        await native.m.setOrientation({ orientation: 'PORTRAIT' })
        await native.show('Close Tess')
        const field = (await native.find('Tess field'))!.bounds!
        expect(field.x + field.width).greaterThan(400)
        await ctx.checkpoint('full-screen', {
          expect: [{ text: 'Close Tess' }],
          golden: {}
        })
      })
    },
    'dj-game-hides-her-and-leaving-brings-her-back': async ctx => {
      await onTablet(ctx, async native => {
        const { find, m, t } = native
        await native.tap('Tess')
        await native.show('Close Tess')
        await m.waitForAnimationToEnd()
        await m.openLink({
          link: `teamstation://games/${t.games.scheduled}/dj`
        })
        // A simulator asks "Open in TeamStation?" until it has been answered Open once.
        // The link is through once DJ Game shows, or the Apple Music setup that the
        // device's first visit opens over it.
        for (let waited = 0; ; waited += 500) {
          if (waited >= 30000) throw new Error('The DJ link never arrived')
          if (
            (await find('DJ Game')) != null ||
            (await find('apple-music-setup')) != null
          )
            break
          // The alert's own buttons, found exactly; its bounds are the portrait screen's,
          // so the driver taps the button itself.
          if ((await find('Open')) != null && (await find('Cancel')) != null)
            await native.tap('Open')
          else await new Promise(resolve => setTimeout(resolve, 500))
        }
        // That setup comes a moment after DJ Game; its X reads exactly Close.
        await native.tapIfShown('Close', 8000)
        await native.hidden('Close Tess')
        await native.show('DJ Game', 30000)
        await native.show('Notifications')
        expect(await native.headerOrder()).deep.equals(['Notifications'])
        await ctx.checkpoint('dj-without-her', {
          expect: [{ text: 'DJ Game' }, { text: 'Close Tess', absent: true }]
        })
        await native.tap('Back')
        await native.show('Close Tess', 30000)
      })
    }
  }
})
