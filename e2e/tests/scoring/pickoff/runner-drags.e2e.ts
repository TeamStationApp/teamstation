import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { defineHarness, type HarnessContext } from '../../../core/spec'
import {
  apiAs,
  labelOf,
  openPhoneScorer,
  type PhoneScorer,
  type Proof,
  proofOf,
  replayStored,
  scorePath,
  sleep,
  until
} from '../../../rigs/scoring/phoneScorer'

/**
 * Dragging the runner on first in Safari on an iPhone, on the real scoring
 * screen (`pickoff-game`): Visitor 01 walks, and a drag of him back onto
 * first's Safe target is a failed pickoff, recorded each time, the body
 * grabbed rather than the nameplate (the overlapping defender once took
 * that touch), with no pitch and no Undo between; the count stays; a drag
 * towards second offers Steal and advances him. And the runner's drag
 * targets: Safe and Out at first, Safe at second.
 *
 * The points are where first's and second's targets draw on an iPhone's
 * Safari, as fractions of the screen, from the calibrated runs this test
 * came from; first's Out target stands 74 points below its Safe target
 * (`runnerTargets` in `src/app/scoring/runnerDrag.ts`).
 */

const SAFE_AT_FIRST = { x: 88, y: 49 }
const RUNNER_BODY = '74%,54.8%'
const SAFE_AT_SECOND = '39%,44.5%'
/** How far first's Out target is below its Safe target, in points. */
const OUT_BELOW_SAFE = 74

const percent = (p: { x: number; y: number }): string => `${p.x}%,${p.y}%`

interface Scored {
  app: PhoneScorer
  /** The stored game, replayed, read again. */
  read: () => Promise<{ proof: Proof; actions: any[]; line: any }>
  lines: string[]
}

async function openGame(ctx: HarnessContext): Promise<Scored> {
  const world = await ctx.fixture('pickoff-game')
  const game = world.ids.game1
  const api = await apiAs(ctx, world.accounts.scorer)
  const app = await openPhoneScorer(ctx, 'scorer')
  await app.open(scorePath(game))
  return {
    app,
    read: async () => {
      const session = await replayStored(
        await api.client.gameEvents(game),
        game,
        world.ids.context
      )
      return {
        proof: await proofOf(session),
        actions: session.actions as any[],
        line: session.state.liveData.linescore
      }
    },
    lines: []
  }
}

const balls = (actions: any[]): number =>
  actions.filter(a => 'call' in a && a.call === 'B').length
const pickoffs = (actions: any[]): number =>
  actions.filter(a => a.reason === 'Safe from Pickoff').length

/** Four Balls: the batter walks to first. */
async function walk(game: Scored): Promise<void> {
  const { m } = game.app
  const before = balls((await game.read()).actions)
  for (let i = 0; i < 4; i++) {
    await m.tapOn({ text: '^Ball$' })
    await until(
      async () => balls((await game.read()).actions) === before + i + 1,
      'Scoring did not save the Ball',
      12000,
      500
    )
    await m.waitForAnimationToEnd()
  }
}

async function drag(m: any, from: object, to: string): Promise<void> {
  await m.dragAndDrop({
    from,
    to: { point: to },
    holdDuration: 500,
    duration: 1800
  })
}

const countOf = (line: any): object => ({
  balls: line.balls,
  strikes: line.strikes,
  outs: line.outs
})

export default defineHarness({
  id: 'scoring/pickoff/runner-drags',
  title: 'Dragging a runner records pickoffs and advances him',
  kind: 'e2e',
  covers: [
    'src/app/scoring/runnerDrag.ts',
    'src/app/scoring/RunnerDragTargets.tsx',
    'src/app/field/FieldCanvas.tsx',
    'src/common/scoring/apply.ts'
  ],
  stack: 'isolated',
  fixtures: ['pickoff-game'],
  exclusive: false,
  surfaces: {
    'web-safari-ios': {
      // The scoring field draws in 3D: a GPU, so a physical iPhone.
      devices: [
        { role: 'device', needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 10,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'repeated-pickoffs': async ctx => {
      const game = await openGame(ctx)
      const { m } = game.app
      try {
        await m.assertVisible({ text: '^Ball$', timeout: 30000 })
        await walk(game)
        await m.assertVisible({ text: '^Visitor 01$', timeout: 15000 })
        await m.takeScreenshot({ path: ctx.artifact('before.png') })
        await drag(
          m,
          { text: '^Visitor 01$', index: 0 },
          percent(SAFE_AT_FIRST)
        )
        await until(
          async () => pickoffs((await game.read()).actions) === 1,
          'Scoring did not accept the runner drag',
          12000,
          500
        )
        await sleep(2500)
        await m.takeScreenshot({ path: ctx.artifact('after-pickoff.png') })
        const count = countOf((await game.read()).line)
        // Grab the athlete's body, not its nameplate: the overlapping
        // defender intercepted precisely this touch before the reset fix.
        for (let attempt = 2; attempt <= 3; attempt++) {
          await drag(m, { point: RUNNER_BODY }, percent(SAFE_AT_FIRST))
          await until(
            async () => pickoffs((await game.read()).actions) === attempt,
            'Scoring did not accept the runner drag',
            12000,
            500
          )
          await sleep(2500)
        }
        expect(countOf((await game.read()).line)).to.deep.equal(count)
        await drag(m, { point: RUNNER_BODY }, SAFE_AT_SECOND)
        await m.assertVisible({ text: '^Steal$', timeout: 3000 })
        await m.tapOn({ text: '^Steal$' })
        await until(
          async () => (await game.read()).line.offense.second != null,
          'The runner never reached second',
          12000,
          500
        )
        await m.waitForAnimationToEnd()
        await m.takeScreenshot({ path: ctx.artifact('after-advance.png') })
      } finally {
        writeFileSync(
          ctx.artifact('scoring-state.json'),
          JSON.stringify(await game.read().catch(() => null), null, 2)
        )
      }
    },

    'runner-drag-targets': async ctx => {
      const game = await openGame(ctx)
      const { m } = game.app
      const log = (line: string): void => {
        game.lines.push(line)
      }
      try {
        await m.assertVisible({ text: '^Ball$', timeout: 30000 })
        await walk(game)
        await m.assertVisible({ text: '^Visitor 01$', timeout: 15000 })
        await m.takeScreenshot({ path: ctx.artifact('before.png') })
        const root = (await m.hierarchy()) as {
          bounds?: { height: number }
        }
        const height = root.bounds?.height ?? 0
        expect(height, 'The screen has a height').to.be.greaterThan(0)
        const outAtFirst = {
          x: SAFE_AT_FIRST.x,
          y: SAFE_AT_FIRST.y + (OUT_BELOW_SAFE / height) * 100
        }

        // Safe at first: a failed pickoff, the runner stays.
        await drag(m, { point: RUNNER_BODY }, percent(SAFE_AT_FIRST))
        await until(
          async () => pickoffs((await game.read()).actions) === 1,
          'safe on 1 was not recorded',
          12000,
          500
        )
        await m.takeScreenshot({ path: ctx.artifact('1-safe.png') })
        log('safe on 1')
        await sleep(2500)

        // Out at first: picked off.
        const runner = (await game.read()).proof.bases[0]
        expect(runner, 'a runner on first').to.not.equal(null)
        await drag(m, { point: RUNNER_BODY }, percent(outAtFirst))
        await sleep(1000)
        if ((await game.app.nodes()).some(n => labelOf(n) === 'Picked Off'))
          await m.tapOn({ text: '^Picked Off$' })
        await until(
          async () => {
            const read = await game.read()
            return read.line.outs === 1 && read.proof.bases[0] !== runner
          },
          'out on 1 was not recorded',
          12000,
          500
        )
        await m.takeScreenshot({ path: ctx.artifact('1-out.png') })
        log('out on 1')
        await sleep(2500)

        // The next batter walks; Safe at second: he steals.
        await walk(game)
        await drag(m, { point: RUNNER_BODY }, SAFE_AT_SECOND)
        await m.assertVisible({ text: '^Steal$', timeout: 5000 })
        await m.tapOn({ text: '^Steal$' })
        await until(
          async () => (await game.read()).line.offense.second != null,
          'safe on 2 was not recorded',
          12000,
          500
        )
        await m.takeScreenshot({ path: ctx.artifact('2-safe.png') })
        log('safe on 2')
      } finally {
        writeFileSync(
          ctx.artifact('runner-drags.log'),
          game.lines.join('\n') + '\n'
        )
      }
    }
  }
})
