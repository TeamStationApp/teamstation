import { expect } from 'chai'

import {
  defineCoachSpec,
  ERROR_LINES,
  ERROR_PLAN,
  literal,
  openCoachApp,
  openPlanTab,
  savePlan,
  scrollTo
} from '../../../rigs/coach/coachApp'

/** The warnings' red, which a doubled cell and Clear are drawn in. */
const RED = 'rgb(248, 113, 113)'

/**
 * Under the game plan, each inning with any position assigned that is not
 * a whole, unique field says what it lacks and what it doubles, in inning
 * order; an empty inning says nothing, and the old "Two players at" line is
 * gone. On the web, the doubled cells and Clear are that red.
 */
export default defineCoachSpec({
  id: 'scoring/game-plan/position-errors',
  title:
    "The game plan lists each inning's missing and doubled positions under the sheet",
  covers: [
    'src/common/gamePlan.ts',
    'src/app/scoring/plan/PlanTab.tsx',
    'src/app/scoring/plan/PlanCell.tsx',
    'src/app/scoring/plan/PlanPositionErrors.tsx'
  ],
  minutes: 5,
  faults: ['api-500', 'hidden-element'],
  scenarios: {
    'missing-and-doubled': async ctx => {
      const world = await ctx.fixture('coach-game')
      await savePlan(ctx, world, ERROR_PLAN)
      const app = await openCoachApp(ctx, 'coach')
      await app.openCoach(world.ids.game, world.ids.homeTeam)
      await openPlanTab(app)
      // Share sits just under the errors: scrolled to, every line is on screen.
      await scrollTo(app, 'Plan share')
      await ctx.checkpoint(
        'errors-listed',
        {
          expect: [
            ...ERROR_LINES.map(line => ({ text: literal(line) })),
            { text: 'Two players at.*', absent: true },
            // What a coach acts on beside them: Clear, and Share under them.
            { id: 'Plan clear' },
            { id: 'Plan share' }
          ]
        },
        app.m
      )
      // In inning order, and no line for the whole or the empty innings.
      const shown = (
        await app.findAll(/^Plan position (missing|duplicate) \d+$/)
      ).map(found => found.label)
      expect(shown).deep.equals(ERROR_LINES)
      if (app.web != null) {
        const colours = await app.web.page.evaluate(() => {
          const colour = (id: string): string => {
            const node = document.querySelector(`[data-testid="${id}"]`)!
            const text = node.querySelector('[dir="auto"]')
            // No `??` in the page: it has no sucrase helpers.
            // eslint-disable-next-line @typescript-eslint/prefer-nullish-coalescing
            return getComputedStyle(text == null ? node : text).color
          }
          return {
            doubled: ['Plan cell 5-1', 'Plan cell 6-1', 'Plan cell 1-2'].map(
              colour
            ),
            plain: ['Plan cell 1-1', 'Plan cell 1-4', 'Plan cell 2-4'].map(
              colour
            ),
            clear: colour('Plan clear')
          }
        })
        expect(colours.doubled).deep.equals([RED, RED, RED])
        expect(colours.plain).not.includes(RED)
        expect(colours.clear).equals(RED)
      }
    }
  }
})
