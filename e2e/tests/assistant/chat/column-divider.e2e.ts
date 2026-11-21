import { expect } from 'chai'

import { eventually } from '../../../core/readback'
import { defineE2e } from '../../../core/spec'
import {
  COLUMN,
  DIVIDER,
  TESS_GOLDEN,
  TESS_WEB_SPEC,
  type TessWeb,
  withTess
} from '../../../rigs/tessWeb'

async function breakpointIs(web: TessWeb, wanted: string): Promise<void> {
  await eventually(async () => {
    expect(
      await web.page.evaluate(() => {
        const nodes = Array.from(document.querySelectorAll('[data-breakpoint]'))
        const last = nodes[nodes.length - 1]
        return last == null ? null : last.getAttribute('data-breakpoint')
      })
    ).equals(wanted)
  })
}

/** Drags the divider sideways, as a mouse does, from its middle. */
async function dragBy(web: TessWeb, dx: number): Promise<void> {
  const grab = await web.rectOf(DIVIDER)
  expect(grab, 'the divider').not.equals(null)
  const from = grab!.x + grab!.width / 2
  await web.m.dragAndDrop({
    from: { css: DIVIDER },
    to: {
      // Kept inside the window, as a mouse is.
      point: `${Math.round(Math.min(1535, Math.max(0, from + dx)))}, ${Math.round(grab!.y + grab!.height / 2)}`
    },
    holdDuration: 1,
    duration: 480
  })
}

async function onTeamBesideTess(web: TessWeb): Promise<void> {
  await web.open('/')
  await web.openChat()
  await web.goInApp(`/teams/${web.t.f.teamA}`)
  await web.see('[data-breakpoint]')
  await web.see(DIVIDER)
}

export default defineE2e({
  ...TESS_WEB_SPEC,
  id: 'assistant/chat/column-divider',
  title:
    "Her column's divider resizes it by mouse and by keyboard, the pane follows, and a reload keeps the width",
  covers: ['src/app/tess/TessDivider.tsx', 'src/app/tess/tessLayout.ts'],
  minutes: 1,
  faults: ['layout-shift'],
  scenarios: {
    'drag-resizes-and-reload-keeps': async ctx => {
      await withTess(ctx, async web => {
        const { m, page } = web
        await onTeamBesideTess(web)
        expect((await web.rectOf(`${DIVIDER} > div`))?.width).equals(3)
        expect(
          await page.$eval(DIVIDER, node => getComputedStyle(node).cursor)
        ).equals('col-resize')
        await breakpointIs(web, 'tablet')
        // Her column is on the right (fb5ef504a): leftward widens it.
        await dragBy(web, -120)
        expect(await web.rectOf(COLUMN)).deep.include({ x: 1016, width: 520 })
        expect(await web.paneRect()).deep.include({ x: 256, width: 760 })
        await breakpointIs(web, 'tablet')
        await ctx.checkpoint('column-wider', {
          expect: [{ text: 'Ask Tess' }],
          golden: TESS_GOLDEN
        })
        await dragBy(web, -600)
        expect(await web.rectOf(COLUMN)).deep.include({ width: 720 })
        expect(await web.paneRect()).deep.include({ x: 256, width: 560 })
        await breakpointIs(web, 'phone')
        await dragBy(web, 1000)
        expect(await web.rectOf(COLUMN)).deep.include({ width: 320 })
        expect(await web.paneRect()).deep.include({ x: 256, width: 960 })
        await breakpointIs(web, 'tablet')
        await dragBy(web, -200)
        await m.openBrowser({ url: page.url() })
        await web.open('/')
        await web.openChat()
        await web.goInApp(`/teams/${web.t.f.teamA}`)
        await eventually(async () => {
          expect((await web.rectOf(COLUMN))?.width).equals(520)
        }, 10000)
        expect(await web.paneRect()).deep.include({ x: 256, width: 760 })
        await ctx.checkpoint('width-after-reload', {
          expect: [{ text: 'Ask Tess' }],
          golden: TESS_GOLDEN
        })
      })
    },
    'keyboard-moves-it-16-points-a-press': async ctx => {
      await withTess(ctx, async web => {
        const { m, page } = web
        await onTeamBesideTess(web)
        await m.evalBrowserScript({
          script: `document.querySelector(${JSON.stringify(DIVIDER)}).focus()`
        })
        // Leftward widens her, on the right.
        await m.pressKey({ key: 'Left' })
        await m.pressKey({ key: 'Left' })
        await eventually(async () => {
          expect((await web.rectOf(COLUMN))?.width).equals(432)
        }, 10000)
        expect(
          await page.$eval(DIVIDER, node => node.getAttribute('aria-valuenow'))
        ).equals('432')
        await ctx.checkpoint('column-moved-by-keys', {
          expect: [{ text: 'Ask Tess' }],
          golden: TESS_GOLDEN
        })
      })
    }
  }
})
