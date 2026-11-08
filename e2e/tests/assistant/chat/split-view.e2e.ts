import { expect } from 'chai'

import { eventually } from '../../../core/readback'
import { defineE2e } from '../../../core/spec'
import {
  CHAT,
  COLUMN,
  LAYER,
  pause,
  TESS_BUTTON,
  TESS_WEB_SPEC,
  type TessWeb,
  withTess
} from '../../../rigs/tessWeb'

/** The last screen's breakpoint, which a team screen sets from its own width. */
async function breakpoint(web: TessWeb): Promise<string | null> {
  return await web.page.evaluate(() => {
    const nodes = Array.from(document.querySelectorAll('[data-breakpoint]'))
    const last = nodes[nodes.length - 1]
    return last == null ? null : last.getAttribute('data-breakpoint')
  })
}

export default defineE2e({
  ...TESS_WEB_SPEC,
  id: 'assistant/chat/split-view',
  title:
    'On a wide window Tess takes a column beside the app, which keeps working; narrower she fills the window',
  covers: [
    'src/app/tess/**',
    'src/app/navigation/**',
    'src/server/routes/tess.ts'
  ],
  minutes: 2,
  faults: ['api-500', 'api-hang', 'api-garbage', 'wrong-data'],
  scenarios: {
    'column-beside-pane': async ctx => {
      await withTess(ctx, async web => {
        await web.open('/')
        await web.openChat()
        expect(await web.rectOf(COLUMN)).deep.include({ x: 0, width: 400 })
        expect(await web.paneRect()).deep.include({ x: 400, width: 880 })
        await ctx.checkpoint('split', {
          expect: [
            { text: 'Your Home' },
            { text: 'Ask Tess' },
            { text: 'Demo Hawks' }
          ],
          golden: {}
        })
      })
    },
    'team-screen-narrows-beside-her': async ctx => {
      await withTess(ctx, async web => {
        await web.open('/')
        await web.openChat()
        await web.goInApp(`/teams/${web.t.f.teamA}`)
        await web.see('[data-breakpoint]')
        await eventually(async () => {
          expect(await breakpoint(web)).equals('tablet')
        })
        await ctx.checkpoint('team-beside-tess', {
          expect: [{ text: 'Demo Hawks' }, { text: 'Ask Tess' }],
          golden: {}
        })
      })
    },
    'video-keeps-playing': async ctx => {
      await withTess(
        ctx,
        async web => {
          const { m, page, t } = web
          await web.open('/')
          await web.openChat()
          await web.goInApp(
            `/games/${t.games.may3}?tab=watch&video=${t.videos.homePlate}`
          )
          await web.see('[aria-label="Home plate"]', 30000)
          await web.tap('[aria-label="Home plate"]')
          await web.see('video', 30000)
          await web.tap('video')
          await m.evalBrowserScript({
            script:
              "const video = document.querySelector('video'); if (video.paused) await video.play()"
          })
          await eventually(async () => {
            const state = await page.evaluate(() => {
              const video = document.querySelector('video')
              return video == null
                ? { paused: true, time: 0 }
                : { paused: video.paused, time: video.currentTime }
            })
            expect(state.paused).equals(false)
            expect(state.time).greaterThan(2)
          }, 30000)
          await m.evalBrowserScript({
            script: "document.querySelector('video').__tessMarker = 'kept'"
          })
          const playing = await page.evaluate(() => {
            const video = document.querySelector('video')
            return video == null ? 0 : video.currentTime
          })
          await pause(2000)
          const after = await page.evaluate(() => {
            const video = document.querySelector('video') as any
            return {
              marker: video == null ? null : video.__tessMarker,
              time: video == null ? 0 : (video.currentTime as number),
              paused: video == null ? true : (video.paused as boolean)
            }
          })
          expect(after.marker, 'the same video element').equals('kept')
          expect(after.time).greaterThan(playing)
          expect(after.paused).equals(false)
          await ctx.checkpoint('video-kept', {
            expect: [{ text: 'Ask Tess' }],
            ask: 'A video of a moving test pattern plays beside the chat column, and is neither blank nor black.'
          })
        },
        { video: true, liveClock: true }
      )
    },
    'fills-window-when-narrow': async ctx => {
      await withTess(
        ctx,
        async web => {
          const { page, session } = web
          await web.open('/')
          await web.openChat(LAYER)
          expect(await web.rectOf(LAYER)).deep.equals({
            x: 0,
            y: 0,
            width: 1024,
            height: 900
          })
          await web.say(
            'Where are my team settings?',
            "Your team's settings are here"
          )
          const messageCount = async (): Promise<number> =>
            await page.$$eval(
              '[data-testid="Tess user message"], [data-testid="Tess reply"]',
              nodes => nodes.length
            )
          const shown = await messageCount()
          expect(shown).greaterThan(0)
          await ctx.checkpoint('full-window', {
            expect: [{ text: "Your team's settings are here" }],
            golden: {}
          })
          // The same conversation across the width where her layout changes. No
          // checkpoint while resized: maestro-d captures at the window's own size.
          await session.resize({ width: 1280, height: 900 })
          await web.see(COLUMN)
          expect(await web.rectOf(COLUMN)).deep.include({ x: 0, width: 400 })
          await eventually(async () => {
            expect(await messageCount()).greaterThanOrEqual(shown)
          })
          await session.resize({ width: 1024, height: 900 })
          await web.see(LAYER)
          await eventually(async () => {
            expect(await messageCount()).greaterThanOrEqual(shown)
          })
          await web.tap('[role="button"][aria-label="Close Tess"]')
          await web.gone(CHAT)
          await ctx.checkpoint('closed-at-narrow-width', {
            expect: [{ text: 'Your Home' }],
            golden: {}
          })
        },
        { width: 1024, height: 900 }
      )
    },
    'back-closes-her-and-keeps-the-address': async ctx => {
      await withTess(ctx, async web => {
        const { page } = web
        await web.open('/')
        await web.openChat()
        await web.tap('[role="button"][aria-label^="Demo Hawks, Demo Regular"]')
        await web.pathIs(`/teams/${web.t.f.teamA}`)
        await web.session.resize({ width: 1024, height: 900 })
        await web.see(LAYER)
        const address = await page.evaluate(() => location.href)
        await page.evaluate(() => {
          history.back()
        })
        await web.gone(CHAT)
        await pause(800)
        expect(await page.evaluate(() => location.href)).equals(address)
        await ctx.checkpoint('team-after-back', {
          expect: [{ text: 'Demo Hawks' }],
          golden: {}
        })
      })
    },
    'scoring-takes-the-window': async ctx => {
      await withTess(ctx, async web => {
        const { m, page, t } = web
        await web.open('/')
        await web.openChat()
        await web.goInApp(`/games/${t.games.scheduled}`)
        await web.say(
          'Take me to score the next game',
          'Here is the scoring screen'
        )
        await m.tapOn({
          text: 'Score Demo Hawks vs Demo Eagles',
          timeout: 15000
        })
        await web.pathIs(`/games/${t.games.scheduled}/score`)
        await web.gone(COLUMN)
        expect(await page.$(TESS_BUTTON)).equals(null)
        await pause(2500)
        await ctx.checkpoint('immersive', {
          expect: [{ text: 'Ask Tess', absent: true }],
          ask: 'A baseball field is on screen, with a scoreboard and buttons for calling pitches, and no chat column is open.'
        })
        await m.back()
        await web.see(COLUMN, 30000)
      })
    },
    'dj-screen-keeps-her': async ctx => {
      await withTess(ctx, async web => {
        await web.open('/')
        await web.openChat()
        await web.goInApp(`/games/${web.t.games.scheduled}/dj`)
        await web.shown('Demo Hawks')
        await web.shown('Demo Field')
        await eventually(async () => {
          const loading = await web.page.evaluate(() => {
            return document.querySelectorAll(
              '[role="progressbar"], [aria-busy="true"]'
            ).length
          })
          expect(loading).equals(0)
        }, 15000)
        await ctx.checkpoint('dj-beside-tess', {
          expect: [{ text: 'Demo Hawks' }, { text: 'Ask Tess' }],
          golden: {}
        })
      })
    }
  }
})
