import { strict as assert } from 'node:assert'

import { defineHarness } from '../../../core/spec'
import {
  listOf,
  pause,
  SCORER_ROLE,
  textOf,
  until
} from '../../../rigs/scoring/scorerSheets'
import { begin, open, type Sheets } from '../modals/sheets.e2e'

/**
 * Overrides on the scoring screen, on Safari on an iPhone: a batter skipped
 * and pinch hit, the inning, score, count and outs set, a half changed that
 * clears the pitcher and the bases until he is assigned again, a runner
 * corrected on second, and each undone. What the screen saved is replayed
 * from the book the stack's API keeps; players are named by their place on
 * the world's rosters (`away[i]` wears i + 1).
 */

export default defineHarness({
  id: 'scoring/overrides/game-state',
  title:
    'Overrides set the batter, numbers, half and runners, keep them and undo them',
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringScreen.tsx',
    'src/app/scoring/OverridesEditor.tsx',
    'src/app/scoring/overrideModel.ts',
    'src/common/scoring/rules.ts',
    'src/common/scoring/gumbo.ts'
  ],
  stack: 'isolated',
  fixtures: ['scoring-sheets'],
  exclusive: false,
  surfaces: {
    // The scoring screen draws the field in 3D: a GPU, so a physical iPhone.
    'web-safari-ios': {
      devices: [
        { role: SCORER_ROLE, needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 15,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'override-card': async ctx => {
      const run = await begin(ctx)
      const { s } = run
      const away = listOf(run.world.ids, 'readyAwayGumbos').map(Number)
      const home = listOf(run.world.ids, 'readyHomeGumbos').map(Number)
      const { baseIds } = await import('../../../../src/common/scoring/rules')
      const setup: { value?: any } = {}
      const saved = async (check: (state: any) => boolean): Promise<any> =>
        await until(
          async () => await stateOf(run, setup),
          state => state != null && check(state),
          'the persisted scoring state',
          16000
        )
      const menu = async (): Promise<void> => {
        await s.m.waitForAnimationToEnd({ timeout: 3000 })
        await s.tap('Open scoring menu')
        await s.tap('Overrides')
      }
      /** A wheel's next row, a row's height below the one it shows. */
      const nextOn = async (label: string): Promise<void> => {
        const wheel = (await s.nodes()).find(
          node => textOf(node) === label
        )?.bounds
        assert(wheel != null, `${label} is shown`)
        await s.point(
          wheel.x + wheel.width / 2,
          wheel.y + wheel.height / 2 + 44
        )
        await pause(400)
      }
      const julio = async (): Promise<void> => {
        await s.m.scrollUntilVisible({
          element: { text: '^Julio Rodriguez #10$' },
          direction: 'DOWN',
          timeout: 15000
        })
        await s.tap('Julio Rodriguez #10')
      }

      await open(run)
      await menu()
      await s.tap('Batter')
      await s.tap('3. Shohei Ohtani #3')
      await s.tap('Batter')
      await julio()
      await s.tap('Apply Override')
      const openingPinch = await saved(
        state => state.liveData.linescore.offense.batter?.id === away[9]
      )
      assert.equal(openingPinch.liveData.boxscore.teams.away.battingIndex, 2)
      assert.equal(
        openingPinch.liveData.boxscore.teams.away.battingOrder[2],
        away[9]
      )
      await s.tap('Undo Override game state')
      await saved(
        state => state.liveData.linescore.offense.batter?.id === away[0]
      )
      await s.tap('Ball')
      const before = await saved(state => state.liveData.linescore.balls === 1)
      const pitcher = before.liveData.linescore.defense.P?.id
      await menu()
      await s.capture('overrides')
      await s.tap('Inning')
      await s.capture('inning')
      await nextOn('Inning: 1')
      await s.tap('Done')
      await s.tap('Owls score')
      await nextOn('Owls: 0')
      await s.capture('score')
      await s.tap('Done')
      await s.tap('Balls 3')
      await s.tap('Strikes 2')
      await s.tap('Outs 1')
      await s.tap('Apply Override')
      const numeric = await saved(
        state =>
          state.liveData.linescore.currentInning === 2 &&
          state.liveData.linescore.teams.away.runs === 1
      )
      assert.equal(numeric.liveData.linescore.balls, 3)
      assert.equal(numeric.liveData.linescore.strikes, 2)
      assert.equal(numeric.liveData.linescore.outs, 1)
      assert.equal(numeric.liveData.linescore.defense.P?.id, pitcher)
      await s.tap('Undo Override game state')
      await saved(
        state =>
          state.liveData.linescore.currentInning === 1 &&
          state.liveData.linescore.teams.away.runs === 0
      )
      await s.tap('Undo Ball')
      await saved(state => state.liveData.linescore.balls === 0)
      await s.tap('More')
      await s.tap('Place a Runner (Tiebreaker)')
      await s.tap('Place runner on base')
      await s.tap('Place runner on 1B')
      await s.tap('Select runner #2 Mike Trout')
      await s.tap('Cancel')
      const occupied = await saved(state => baseIds(state)[0] === away[1])
      await menu()
      await s.tap('Batter')
      await s.capture('batter')
      assert.equal(
        (await s.nodes()).find(node => textOf(node) === '2. Mike Trout #2')
          ?.enabled,
        false,
        'The runner on base cannot bat'
      )
      await s.tap('3. Shohei Ohtani #3')
      await s.tap('Apply Override')
      const skipped = await saved(
        state => state.liveData.linescore.offense.batter?.id === away[2]
      )
      assert.deepEqual(baseIds(skipped), baseIds(occupied))
      assert.equal(skipped.liveData.linescore.defense.P?.id, pitcher)
      await menu()
      await s.tap('Batter')
      await julio()
      await s.tap('Apply Override')
      const pinched = await saved(
        state => state.liveData.linescore.offense.batter?.id === away[9]
      )
      assert.equal(
        pinched.liveData.boxscore.teams.away.battingOrder[2],
        away[9]
      )
      assert(
        pinched.liveData.boxscore.teams.away.battingOrder.includes(away[2]) ===
          false
      )
      assert.deepEqual(baseIds(pinched), baseIds(occupied))
      await s.tap('Undo Override game state')
      await saved(
        state => state.liveData.linescore.offense.batter?.id === away[2]
      )
      await menu()
      await s.tap('Bottom')
      await s.tap('Apply Override')
      const half = await saved(
        state => state.liveData.linescore.isTopInning === false
      )
      assert.equal(half.liveData.linescore.defense.P, null)
      assert.deepEqual(baseIds(half), [null, null, null])
      await s.shown('Assign a pitcher', 10000)
      await s.capture('half-reset')
      await s.tap('Assign P')
      await s.tap('Assign P #1 Mookie Betts')
      const repaired = await saved(
        state => state.liveData.linescore.defense.P?.id === away[0]
      )
      assert.equal(repaired.liveData.linescore.offense.batter?.id, home[0])
      await s.open(`games/${run.game}/score?reopen=${Date.now()}`)
      await s.shown('Open scoring menu', 45000)
      await menu()
      // Swiped through the rows' blank middle: Safari reports text under the
      // floating footer as visible, so scrolling to it can stop early.
      await s.m.swipe({ start: '50%,65%', end: '50%,35%', duration: 200 })
      await s.m.waitForAnimationToEnd({ timeout: 3000 })
      const scrolled = await s.nodes()
      const lastRow = scrolled
        .filter(node => textOf(node) === 'Third base')
        .at(-1)?.bounds
      const apply = scrolled
        .filter(node => textOf(node) === 'Apply Override')
        .at(-1)?.bounds
      assert(lastRow != null && apply != null)
      assert(
        lastRow.y + lastRow.height < apply.y,
        'Third base must clear Apply'
      )
      await s.capture('inline-runners')
      await s.tap('Second base')
      await s.capture('runner-correction')
      await s.tap('Choose Second base Mike Trout #2')
      await s.tap('Apply Override')
      const corrected = await saved(state => baseIds(state)[1] === home[1])
      assert.equal(
        corrected.liveData.linescore.offense.reachedOnError?.second,
        false
      )
      assert(
        corrected.liveData.plays.currentPlay.playEvents.some(
          (event: any) => event.details.code === 'placed_runner'
        ) === false
      )
      await menu()
      await s.tap('Top')
      await s.tap('Apply Override')
      const back = await saved(state => state.liveData.linescore.isTopInning)
      assert.equal(back.liveData.linescore.defense.P, null)
      assert.deepEqual(baseIds(back), [null, null, null])
      await s.tap('Assign P')
      await s.tap('Assign P #1 Mookie Betts')
      const topRepaired = await saved(
        state => state.liveData.linescore.defense.P?.id === home[0]
      )
      assert.equal(
        topRepaired.liveData.linescore.offense.batter?.id,
        back.liveData.linescore.offense.batter?.id
      )
      assert.equal(
        topRepaired.liveData.boxscore.teams.away.battingIndex,
        back.liveData.boxscore.teams.away.battingIndex
      )
      await s.tap('Undo Set team roster')
      await saved(state => state.liveData.linescore.defense.P == null)
      await s.tap('Undo Override game state')
      await saved(
        state =>
          state.liveData.linescore.isTopInning === false &&
          baseIds(state)[1] === home[1]
      )
      await s.tap('Ball')
      await saved(state => state.liveData.linescore.balls === 1)
    }
  }
})

/** The book's state, replayed as the screen replays it. */
async function stateOf(run: Sheets, setup: { value?: any }): Promise<any> {
  const { recordOf, replayPlays } =
    await import('../../../../src/common/scoring/gumbo')
  const book = await run.book(run.game)
  const teams = {
    away: { id: run.world.ids.readyAwayTeam },
    home: { id: run.world.ids.readyHomeTeam }
  }
  setup.value ??= recordOf(
    book.currentPlay ?? book.plays[0],
    teams
  )?.setupBefore
  if (setup.value == null) return undefined
  const result = replayPlays(book, {
    gamePk: run.game,
    teams: {
      away: { ...teams.away, name: 'Owls' },
      home: { ...teams.home, name: 'Hawks' }
    },
    setup: setup.value
  })
  assert.deepEqual(result.problems, [])
  return result.state
}
