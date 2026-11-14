import { expect } from 'chai'

import { eventually } from '../../../core/readback'
import { defineE2e } from '../../../core/spec'
import {
  FIELD,
  TESS_GOLDEN,
  TESS_WEB_SPEC,
  type TessWeb,
  THINKING,
  withTess
} from '../../../rigs/tessWeb'

async function fieldHeight(web: TessWeb): Promise<number> {
  return await web.page.$eval(
    FIELD,
    node => node.getBoundingClientRect().height
  )
}

export default defineE2e({
  ...TESS_WEB_SPEC,
  id: 'assistant/chat/composer',
  title:
    'Her chat is titled beside her icon, the + is small and plain, and Shift+Enter is a new line while Enter sends',
  covers: ['src/app/tess/Composer.tsx', 'src/app/tess/TessChat.tsx'],
  minutes: 1,
  faults: ['layout-shift', 'hidden-element'],
  scenarios: {
    'title-and-plain-plus': async ctx => {
      await withTess(ctx, async web => {
        const { page } = web
        await web.open('/')
        await web.openChat()
        const header = await page.evaluate(() => {
          const title = document.querySelector(
            '[data-testid="Tess chat"] [role="heading"]'
          )!
          const icon = title.previousElementSibling as HTMLElement
          const box = (node: Element): number[] => {
            const rect = node.getBoundingClientRect()
            return [rect.x, rect.y, rect.width, rect.height]
          }
          const column = document
            .querySelector('[data-testid="Tess column"]')!
            .getBoundingClientRect()
          return {
            title: title.textContent,
            titleBox: box(title),
            icon: icon.textContent,
            iconBox: box(icon),
            columnLeft: column.x
          }
        })
        expect(header.title).equals('Ask Tess')
        expect(header.icon).equals('auto_awesome')
        // At the left of her column, which is on the right (fb5ef504a).
        expect(
          header.iconBox[0] - header.columnLeft,
          'the icon at the left'
        ).lessThan(40)
        expect(header.iconBox[1], 'at the top').lessThan(40)
        expect(header.iconBox[0] + header.iconBox[2]).lessThan(
          header.titleBox[0]
        )
        const plus = await page.$eval(
          '[role="button"][aria-label="Attach a file"]',
          node => {
            const style = getComputedStyle(node)
            const box = node.getBoundingClientRect()
            return {
              width: box.width,
              height: box.height,
              border: style.borderTopWidth,
              background: style.backgroundColor
            }
          }
        )
        expect(plus).deep.equals({
          width: 32,
          height: 32,
          border: '0px',
          background: 'rgba(0, 0, 0, 0)'
        })
        await ctx.checkpoint('header-and-composer', {
          expect: [{ text: 'Ask Tess' }, { id: 'Attach a file' }],
          golden: TESS_GOLDEN
        })
      })
    },
    'shift-enter-is-a-new-line': async ctx => {
      await withTess(ctx, async web => {
        const { m, t } = web
        await web.open('/')
        await web.openChat()
        const oneLine = await fieldHeight(web)
        await m.tapOn({ css: FIELD })
        await web.type('a')
        await m.pressKey({ key: 'Shift+Enter' })
        await web.type('b')
        expect(await web.fieldValue()).equals('a\nb')
        expect(oneLine).equals(48)
        expect(await fieldHeight(web), 'two lines').equals(70)
        await ctx.checkpoint('two-lines', { golden: TESS_GOLDEN })
        const callsBefore = t.model.calls.length
        await m.pressKey({ key: 'Enter' })
        await eventually(async () => {
          expect(await web.fieldValue()).equals('')
        })
        await web.gone(THINKING)
        const lines = t.model.calls
          .slice(callsBefore)
          .find(call => call.request?.said.startsWith('a') === true)
        expect(lines?.request?.said).equals('a\nb')
        expect(await fieldHeight(web), 'one line again').equals(48)
      })
    }
  }
})
