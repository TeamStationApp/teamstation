import { expect } from 'chai'

import { readJson } from '../../../core/readback'
import {
  defineCoachSpec,
  openCoachApp,
  openPlanTab,
  savePlan,
  WHOLE_PLAN
} from '../../../rigs/coach/coachApp'

/**
 * A team's assistant coaches its games as its head coach does: the game's
 * page offers Coach, and Coach Game opens on the whole plan. A scorekeeper
 * who neither coaches nor assists is offered Score and no Coach.
 */
export default defineCoachSpec({
  id: 'scoring/coach-game/assistant-coaches',
  title:
    "A team's assistant is offered Coach on its game and reads the whole plan; a scorekeeper is not",
  covers: [
    'src/server/access.ts',
    'src/server/routes/teams.ts',
    'src/app/screens/gameTabs.ts',
    'src/app/screens/GameScreen.tsx',
    'src/app/screens/CoachGameScreen.tsx',
    'src/app/scoring/plan/**'
  ],
  minutes: 5,
  faults: ['api-500', 'hidden-element'],
  scenarios: {
    'assistant-opens-plan': async ctx => {
      const world = await ctx.fixture('coach-game')
      // The head coach's plan, which the assistant then reads whole.
      await savePlan(ctx, world, WHOLE_PLAN)
      const app = await openCoachApp(ctx, world.accounts.assistant)
      await app.openGame(world.ids.game)
      await ctx.checkpoint(
        'game-offers-coach',
        { expect: [{ id: 'game-hero-actions', timeout: 60000 }] },
        app.m
      )
      expect(await app.heroActions()).includes('Coach')
      await app.m.tapOn({ text: 'Coach' })
      await openPlanTab(app)
      await ctx.checkpoint(
        'assistant-reads-plan',
        {
          expect: [{ id: 'Plan cell 1-1' }, { id: 'Plan cell 9-5' }],
          readBack: async () => {
            const { signInTestAccount } =
              await import('../../../../src/test/passwordFixtures')
            const api = `${ctx.stack.origin}/api/v1`
            const token = await signInTestAccount(api, world.accounts.assistant)
            const plans = (await readJson(
              ctx.stack.origin,
              `/api/v1/games/${world.ids.game}/plans`,
              { headers: { authorization: `Bearer ${token}` } }
            )) as { home: { plan: { rows: unknown[] } | null } | null }
            // The whole plan, every player's row: not one inning's column.
            expect(plans.home?.plan?.rows).to.have.length(9)
          }
        },
        app.m
      )
    },
    'scorekeeper-has-no-coach': async ctx => {
      const world = await ctx.fixture('coach-game')
      const app = await openCoachApp(ctx, world.accounts.scorekeeper)
      await app.openGame(world.ids.game)
      await ctx.checkpoint(
        'game-offers-score-only',
        {
          expect: [
            { id: 'game-hero-actions', timeout: 60000 },
            { text: 'Score' }
          ]
        },
        app.m
      )
      // A scheduled game nobody has scored: Score, and nothing to coach.
      expect(await app.heroActions()).deep.equals(['Score'])
    }
  }
})
