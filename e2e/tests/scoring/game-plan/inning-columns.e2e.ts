import { expect } from 'chai'

import {
  defineCoachSpec,
  find,
  openCoachApp,
  openPlanTab,
  savePlan,
  WHOLE_PLAN
} from '../../../rigs/coach/coachApp'

/**
 * The game plan's inning columns are two characters wide on an iPhone 17
 * Pro's 402-point window or narrower, and grow with the window up to three
 * times that at 1206 points, where the Plan tab stops growing and is centred.
 */
export default defineCoachSpec({
  id: 'scoring/game-plan/inning-columns',
  title:
    "The game plan's inning columns grow with the window, up to 1206 points",
  covers: [
    'src/app/scoring/plan/planColumns.ts',
    'src/app/scoring/plan/planLayout.ts',
    'src/app/scoring/plan/PlanTab.tsx'
  ],
  minutes: 4,
  faults: ['api-500', 'hidden-element'],
  scenarios: {
    'grow-with-window': async ctx => {
      const { planColumnWidth } =
        await import('../../../../src/app/scoring/plan/planColumns')
      const world = await ctx.fixture('coach-game')
      await savePlan(ctx, world, WHOLE_PLAN)
      const app = await openCoachApp(ctx, 'coach')
      await app.openCoach(world.ids.game, world.ids.homeTeam)
      await openPlanTab(app)
      await ctx.checkpoint(
        'plan-drawn',
        { expect: [{ id: 'Plan cell 1-1' }, { id: 'Plan cell 9-5' }] },
        app.m
      )
      const window = await app.window()
      if (app.web == null) {
        // The app's own window: an iPhone's 402 points, an iPad's 834 or more.
        const cell = await find(app, 'Plan cell 1-1')
        expect(cell, 'the first cell is drawn').not.equals(undefined)
        expect(Math.round(cell!.bounds.width)).equals(
          planColumnWidth(window.width)
        )
        return
      }
      // On the web a cell sits in its column with a margin: the column is
      // the cell's parent.
      const column = (): number =>
        document
          .querySelector('[data-testid="Plan cell 1-1"]')!
          .parentElement!.getBoundingClientRect().width
      // The same page at a tablet's and a desktop's width, read by the page.
      const measure = async (
        width: number,
        height: number
      ): Promise<{ column: number; tab: number; left: number }> => {
        await app.web!.resize({ width, height })
        await app.web!.page.waitForFunction(
          (expected: number) =>
            Math.abs(
              document
                .querySelector('[data-testid="Plan cell 1-1"]')!
                .parentElement!.getBoundingClientRect().width - expected
            ) < 1,
          { timeout: 10000 },
          planColumnWidth(width)
        )
        return await app.web!.page.evaluate(() => {
          const tab = document
            .querySelector('[data-testid="Plan tab"]')!
            .getBoundingClientRect()
          return {
            column: document
              .querySelector('[data-testid="Plan cell 1-1"]')!
              .parentElement!.getBoundingClientRect().width,
            tab: tab.width,
            left: tab.left
          }
        })
      }
      expect(Math.round(await app.web.page.evaluate(column))).equals(28)
      const tablet = await measure(1024, 1366)
      expect(Math.round(tablet.column)).equals(71)
      const desktop = await measure(1920, 1080)
      expect(Math.round(desktop.column)).equals(84)
      expect(desktop.tab).equals(1206)
      expect(desktop.left).equals((1920 - 1206) / 2)
      await ctx.checkpoint(
        'plan-wide',
        { expect: [{ id: 'Plan cell 1-1' }] },
        app.m
      )
    }
  }
})
