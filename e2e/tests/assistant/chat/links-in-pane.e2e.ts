import { expect } from 'chai'

import { eventually } from '../../../core/readback'
import { defineE2e } from '../../../core/spec'
import {
  COLUMN,
  OPEN_FULL_SCREEN,
  OVERLAY,
  pause,
  type Rect,
  SETTINGS_BUBBLE,
  TESS_WEB_SPEC,
  type TessWeb,
  VIEWER,
  VIEWER_CLOSE,
  withTess
} from '../../../rigs/tessWeb'

const REPLY_LINK = '[data-testid="Tess reply"] [role="link"]'

async function opened(web: TessWeb): Promise<void> {
  await web.open('/')
  await web.openChat()
}

/** The multi-angle view: the fixed element on the body that holds a video. */
async function angleView(web: TessWeb): Promise<Rect | null> {
  return await web.page.evaluate(() => {
    const fixed = Array.from(document.body.children).find(node => {
      const style = getComputedStyle(node)
      return style.position === 'fixed' && node.querySelector('video') != null
    })
    if (fixed == null) return null
    const box = fixed.getBoundingClientRect()
    return { x: box.x, y: box.y, width: box.width, height: box.height }
  })
}

async function waitForAngleView(web: TessWeb): Promise<Rect> {
  let box: Rect | null = null
  await eventually(async () => {
    box = await angleView(web)
    expect(box, 'the multi-angle view').not.equals(null)
  }, 30000)
  return box as unknown as Rect
}

export default defineE2e({
  ...TESS_WEB_SPEC,
  id: 'assistant/chat/links-in-pane',
  title:
    'What Tess links to opens in the pane beside her, and over what the pane already shows',
  covers: [
    'src/app/tess/WayBubble.tsx',
    'src/app/tess/TessMarkdown.tsx',
    'src/app/tess/TessOverlayLayer.tsx',
    'src/server/tess/playerLinks.ts'
  ],
  minutes: 2,
  faults: ['wrong-data', 'api-500', 'layout-shift'],
  scenarios: {
    'way-bubble-opens-team-settings': async ctx => {
      await withTess(ctx, async web => {
        await opened(web)
        await web.say(
          'Where are my team settings?',
          "Your team's settings are here"
        )
        await ctx.checkpoint('way-bubble', {
          expect: [
            { id: 'Go to Home, Demo Hawks, Settings' },
            { text: 'Demo League A' }
          ],
          golden: {}
        })
        await web.tap(SETTINGS_BUBBLE)
        await web.pathIs(web.t.links.teamSettings)
        await web.see(COLUMN)
        await ctx.checkpoint('settings-beside-chat', {
          expect: [{ text: 'Team Settings' }],
          golden: {}
        })
      })
    },
    'angle-link-fills-only-the-pane': async ctx => {
      await withTess(
        ctx,
        async web => {
          const { m, page } = web
          await opened(web)
          await web.say(
            'Give me the first-base angle from the May 3 game',
            'Here is the May 3 game from first base'
          )
          await m.tapOn({ text: 'First base, May 3', timeout: 15000 })
          await eventually(async () => {
            const search = await page.evaluate(() => location.search)
            expect(search).includes('video=').and.includes('angles=')
          })
          const box = await waitForAngleView(web)
          expect(box).deep.equals(await web.paneRect())
          expect(await web.rectOf(COLUMN)).deep.include({ x: 1136, width: 400 })
          await pause(1500)
          await ctx.checkpoint('angle-over-pane', {
            expect: [{ text: 'Ask Tess' }],
            ask: 'The video of the game, from one camera, fills the area right of the chat column, and the chat is still shown.'
          })
          await m.pressKey({ key: 'Escape' })
        },
        { video: true, liveClock: true }
      )
    },
    'bubble-closes-an-open-chart': async ctx => {
      await withTess(ctx, async web => {
        await opened(web)
        await web.say(
          'Where are my team settings?',
          "Your team's settings are here"
        )
        await web.say('Chart our runs per game', "Demo Hawks' runs per game")
        await web.see('[data-testid="Tess rich block"]')
        await web.tap(OPEN_FULL_SCREEN)
        await web.see(VIEWER)
        await web.tap(SETTINGS_BUBBLE)
        await web.pathIs(web.t.links.teamSettings)
        await web.gone(OVERLAY)
        expect(await web.rectOf(COLUMN)).deep.include({ x: 1136, width: 400 })
        await ctx.checkpoint('settings-after-chart', {
          expect: [{ text: 'Team Settings' }],
          golden: {}
        })
      })
    },
    'chart-opens-over-the-angle-view': async ctx => {
      await withTess(
        ctx,
        async web => {
          const { m, page } = web
          await opened(web)
          await web.say(
            'Give me the first-base angle from the May 3 game',
            'Here is the May 3 game from first base'
          )
          await web.say('Chart our runs per game', "Demo Hawks' runs per game")
          await m.tapOn({ text: 'First base, May 3', timeout: 15000 })
          await waitForAngleView(web)
          await web.tap(OPEN_FULL_SCREEN)
          await web.see(VIEWER)
          const closeOnTop = await page.$eval(VIEWER_CLOSE, node => {
            const box = node.getBoundingClientRect()
            const hit = document.elementFromPoint(
              box.x + box.width / 2,
              box.y + box.height / 2
            )
            return hit != null && node.contains(hit)
          })
          expect(closeOnTop, 'the X over the angle view').equals(true)
          await ctx.checkpoint('chart-over-angle', {
            expect: [{ id: 'Tess rich viewer' }],
            golden: {}
          })
          await web.tap(VIEWER_CLOSE)
          await web.gone(VIEWER)
          await m.pressKey({ key: 'Escape' })
        },
        { video: true, liveClock: true }
      )
    },
    'player-name-links-to-the-profile': async ctx => {
      await withTess(ctx, async web => {
        const { page, t } = web
        await opened(web)
        await web.say('Who plays shortstop for Demo Hawks?', 'plays shortstop')
        await web.see(REPLY_LINK)
        const link = await page.$eval(REPLY_LINK, node => ({
          text: node.textContent,
          color: getComputedStyle(node).color
        }))
        expect(link).deep.equals({
          text: 'Tony G',
          color: 'rgb(21, 101, 192)'
        })
        await ctx.checkpoint('player-link', { golden: {} })
        await web.tap(REPLY_LINK)
        await web.pathIs(`/players/${t.players.visible}`)
        await web.see(COLUMN)
        await web.see('[aria-label="Player sections"]')
        await ctx.checkpoint('player-profile', {
          expect: [{ text: 'Tony G' }],
          golden: {}
        })
      })
    },
    'hidden-player-is-not-shown': async ctx => {
      await withTess(ctx, async web => {
        const { t } = web
        await opened(web)
        await web.say('Show me Ozzie', 'who plays for Demo Visitors')
        await web.see(REPLY_LINK)
        await web.tap(REPLY_LINK)
        await web.pathIs(`/players/${t.players.hidden}`)
        await web.see('[data-testid="Player unavailable"]')
        await ctx.checkpoint('player-denied', {
          expect: [
            { text: 'Profile not available' },
            {
              text: 'You don’t have access to this player’s profile, or it no longer exists.'
            }
          ],
          golden: {}
        })
        // A link from Tess opens a page on its own, as an address does, so Back, like
        // the header's, goes to the tab's first page.
        await web.tap('[data-testid="Player unavailable"] [role="button"]')
        await web.pathIs('/')
        await web.gone('[data-testid="Player unavailable"]')
        await web.see(COLUMN)
        await ctx.checkpoint('back-at-home', {
          expect: [{ text: 'Your Home' }],
          golden: {}
        })
      })
    }
  }
})
