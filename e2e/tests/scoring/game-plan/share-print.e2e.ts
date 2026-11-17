import { expect } from 'chai'

import {
  defineCoachSpec,
  ERROR_PLAN,
  find,
  openCoachApp,
  openPlanTab,
  savePlan,
  scrollTo
} from '../../../rigs/coach/coachApp'

/** What the PDF is named: the team, then the game's date. */
const PDF_NAME = /^Hosts-game-plan-\d{4}-\d{2}-\d{2}\.pdf$/

/**
 * Stands in for the hardware a browser in a test lacks, before any page
 * script: a share sheet that keeps the files it is handed, and a printer
 * that counts the frames asked to print.
 */
const SHARE_AND_PRINTER = `
  window.__planShares = [];
  window.__planPrints = 0;
  Object.defineProperty(navigator, 'canShare', { configurable: true, value: () => true });
  Object.defineProperty(navigator, 'share', {
    configurable: true,
    value: async data => {
      for (const file of data.files || []) {
        const bytes = new Uint8Array(await file.arrayBuffer());
        let text = '';
        for (const byte of bytes) text += String.fromCharCode(byte);
        window.__planShares.push({ name: file.name, type: file.type, base64: btoa(text) });
      }
    }
  });
  const own = Object.getOwnPropertyDescriptor(HTMLIFrameElement.prototype, 'contentWindow');
  Object.defineProperty(HTMLIFrameElement.prototype, 'contentWindow', {
    configurable: true,
    get() {
      const view = own.get.call(this);
      if (view == null) return view;
      return new Proxy(view, {
        get: (target, key) =>
          key === 'print' ? () => { window.__planPrints++ }
            : key === 'focus' ? () => undefined
            : Reflect.get(target, key)
      });
    }
  });
`

interface Shared {
  name: string
  type: string
  base64: string
}

/**
 * Share and Print sit side by side at the very bottom of the plan, under
 * its errors. Each makes the same one-page US Letter PDF of the whole plan,
 * named for the team and the game's date: the web hands it to the
 * browser's share sheet and prints it from a hidden frame; the app opens
 * the system share sheet and print dialog.
 */
export default defineCoachSpec({
  id: 'scoring/game-plan/share-print',
  title:
    'Share and Print under the game plan hand over and print a one-page Letter PDF of it',
  covers: [
    'src/common/planPdf.ts',
    'src/app/scoring/plan/PlanTab.tsx',
    'src/app/scoring/plan/planDocument.ts',
    'src/app/scoring/plan/planDocument.native.ts',
    'src/app/scoring/plan/NativePlanDocument.ts',
    'ios/TeamStation/RCTPlanDocument.mm',
    'src/buildCsp.mjs'
  ],
  minutes: 6,
  faults: ['api-500', 'hidden-element'],
  scenarios: {
    'share-and-print': async ctx => {
      const world = await ctx.fixture('coach-game')
      await savePlan(ctx, world, ERROR_PLAN)
      const app = await openCoachApp(ctx, 'coach', {
        emulation: { beforeLoad: SHARE_AND_PRINTER }
      })
      await app.openCoach(world.ids.game, world.ids.homeTeam)
      await openPlanTab(app)
      const print = await scrollTo(app, 'Plan print')
      const share = await find(app, 'Plan share')
      const errors = await find(app, 'Plan position errors')
      await ctx.checkpoint(
        'pills-at-bottom',
        { expect: [{ id: 'Plan share' }, { id: 'Plan print' }] },
        app.m
      )
      expect(share, 'Share is drawn').not.equals(undefined)
      expect(share!.bounds.x + share!.bounds.width).at.most(print.bounds.x)
      expect(Math.abs(share!.bounds.y - print.bounds.y)).lessThan(2)
      if (errors != null)
        expect(errors.bounds.y + errors.bounds.height).at.most(share!.bounds.y)

      if (app.web != null) {
        const page = app.web.page
        await app.m.tapOn({ id: 'Plan share' })
        await page.waitForFunction(
          () => (window as any).__planShares.length === 1,
          { timeout: 15000 }
        )
        const [shared] = (await page.evaluate(
          () => (window as any).__planShares
        )) as Shared[]
        expect(shared.name).match(PDF_NAME)
        expect(shared.type).equals('application/pdf')
        const { readPlanPdf } =
          await import('../../../../src/test/planPdfReader')
        const pdf = readPlanPdf(
          new Uint8Array(Buffer.from(shared.base64, 'base64'))
        )
        expect(pdf.pages).equals(1)
        expect(pdf.mediaBox).deep.equals([0, 0, 612, 792])
        const drawn = pdf.texts.map(text => text.text)
        expect(drawn[0]).match(/^Hosts game plan - Visitors - /)
        const held = ERROR_PLAN.flat().filter(cell => cell !== '')
        expect(
          pdf.texts
            .filter(text => text.bold && held.includes(text.text))
            .map(text => text.text)
            .sort()
        ).deep.equals([...held].sort())

        await app.m.tapOn({ id: 'Plan print' })
        await page.waitForFunction(() => (window as any).__planPrints === 1, {
          timeout: 15000
        })
        const frame = await page.evaluate(() => {
          const node = document.querySelector('iframe')
          return node == null
            ? null
            : { src: String(node.getAttribute('src')), title: node.title }
        })
        expect(frame?.src).match(/^blob:/)
        expect(frame?.title).equals(shared.name)
        await ctx.checkpoint(
          'printed',
          { expect: [{ id: 'Plan document failed', absent: true }] },
          app.m
        )
        return
      }

      // The app: the system's own share sheet, offering the PDF.
      await app.m.tapOn({ id: 'Plan share' })
      await app.m.waitForAnimationToEnd()
      await ctx.checkpoint(
        'share-sheet',
        {
          expect: [
            { text: 'Hosts-game-plan-.*|PDF Document.*', timeout: 15000 }
          ]
        },
        app.m
      )
      // The sheet is a popover: a tap outside it, on the region the system
      // lays over the app, closes it.
      await app.m.tapOn({ id: 'PopoverDismissRegion' })
      await app.m.assertNotVisible({ text: 'PDF Document.*', timeout: 10000 })

      // And the system's print dialog, for the same PDF.
      await app.m.tapOn({ id: 'Plan print' })
      await app.m.waitForAnimationToEnd()
      await ctx.checkpoint(
        'print-dialog',
        { expect: [{ text: 'Print', timeout: 15000 }, { text: 'Cancel' }] },
        app.m
      )
      await app.m.tapOn({ text: 'Cancel' })
    }
  }
})
