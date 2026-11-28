import { execFileSync } from 'node:child_process'
import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { runnerTargets } from '../../../../src/app/scoring/runnerDrag'
import type { ScoringAction } from '../../../../src/common/scoring/actions'
import type { GameState } from '../../../../src/common/scoring/state'
import { eventually } from '../../../core/readback'
import type { E2eContext } from '../../../core/spec'
import { defineCoachSpec } from '../../../rigs/coach/coachApp'
import {
  openScoringField,
  type ScoringField,
  WALK
} from '../../../rigs/scoring/scoringField'

/**
 * A runner dragged one base toward a base another runner holds pushes that
 * runner on toward the next base, as far as the drag has come, and so on
 * down the chain of occupied bases. Once the dragged runner is Safe or Out,
 * every pushed runner answers Safe, Out or Back at once; Back only once the
 * runner behind him is out. The chain applies lead runner first.
 */

interface Point {
  x: number
  y: number
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const point = (at: Point): string => `${Math.round(at.x)},${Math.round(at.y)}`

/** Saves the recording `stopRecording` answered with to `path` here. */
async function fetchRecording(
  m: any,
  stopped: unknown,
  path: string
): Promise<void> {
  const found =
    typeof stopped === 'string'
      ? stopped
      : /[^"\s]*recordings\/[^"\s]+\.mp4/.exec(JSON.stringify(stopped))?.[0]
  if (found == null)
    throw new Error(`No recording saved: ${JSON.stringify(stopped)}`)
  const bytes: unknown = await m.artifact(found)
  writeFileSync(
    path,
    Buffer.isBuffer(bytes) ? bytes : Buffer.from(bytes as ArrayBuffer)
  )
}

/** The frame of `video` at `seconds`, written to `png`. */
function frameAt(video: string, seconds: number, png: string): void {
  execFileSync('ffmpeg', [
    '-y',
    '-loglevel',
    'error',
    '-ss',
    Math.max(0, seconds).toFixed(3),
    '-i',
    video,
    '-frames:v',
    '1',
    png
  ])
}

/** Runner `n`'s nameplate (R1–R3) on the page, or null where none is drawn. */
async function plateOf(
  field: ScoringField,
  label: string
): Promise<Point | null> {
  return (await field.app.web!.page.evaluate(
    `(() => { const n = document.querySelector('[data-nameplate][data-position="${label}"]'); if (n == null) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`
  )) as Point | null
}

interface Stroke {
  /** Seconds into the recording at which the stroke reached each point. */
  at: number[]
  /** The web page's samples of the watched nameplate, on the same clock. */
  samples: Array<{ t: number; plate: Point | null }>
}

/**
 * One slow stroke through `points` with nothing else pressed, recorded from
 * `recordingStart` (Date.now() when the recording began): when it reached
 * each point, by the rule `dragPath` shares its duration by, and on the
 * web, where `watch`'s nameplate was while it ran.
 */
async function stroke(
  field: ScoringField,
  points: Point[],
  recordingStart: number,
  watch?: string
): Promise<Stroke> {
  const holdDuration = 300
  const duration = 6000
  const legs = points
    .slice(1)
    .map((at, index) =>
      Math.hypot(at.x - points[index].x, at.y - points[index].y)
    )
  const total = legs.reduce((sum, leg) => sum + leg, 0)
  const samples: Stroke['samples'] = []
  const running = { done: false }
  const sampling = (async () => {
    if (!field.web || watch == null) return
    while (!running.done) {
      samples.push({
        t: (Date.now() - recordingStart) / 1000,
        plate: await plateOf(field, watch)
      })
      await sleep(50)
    }
  })()
  const start = (Date.now() - recordingStart) / 1000
  try {
    await field.m.dragPath({
      points: points.map(point),
      holdDuration,
      duration
    })
  } finally {
    running.done = true
    await sampling
  }
  let along = 0
  const at = [start + holdDuration / 1000]
  for (const leg of legs) {
    along += leg
    at.push(start + (holdDuration + (duration * along) / total) / 1000)
  }
  return { at, samples }
}

/** The sample taken nearest `t`. */
function sampleAt(
  samples: Stroke['samples'],
  t: number
): Point | null | undefined {
  let best: Stroke['samples'][number] | undefined
  for (const sample of samples)
    if (best == null || Math.abs(sample.t - t) < Math.abs(best.t - t))
      best = sample
  return best?.plate
}

/** How far `at` is along the line from `from` to `to`, as a share of it. */
const share = (from: Point, to: Point, at: Point): number => {
  const dx = to.x - from.x
  const dy = to.y - from.y
  return ((at.x - from.x) * dx + (at.y - from.y) * dy) / (dx * dx + dy * dy)
}

/** Steals by every runner on base `from`, then the given walks: the seed. */
function stealing(...bases: number[]): (game: GameState) => ScoringAction[] {
  return game => {
    const offense = game.liveData.linescore.offense
    const holders = [offense.first, offense.second, offense.third]
    return bases.map(base => ({
      type: 'runnerMovement',
      runner: holders[base - 1]!.id,
      to: (['2B', '3B', 'home'] as const)[base - 1],
      reason: 'Steal'
    }))
  }
}

/** Whether the control labelled `label` is disabled on the page. */
async function disabled(field: ScoringField, label: string): Promise<boolean> {
  if (!field.web) return false
  return (await field.app.web!.page.evaluate(
    `(() => { const n = document.querySelector('[aria-label=${JSON.stringify(label)}]'); return n != null && n.getAttribute('aria-disabled') === 'true' })()`
  )) as boolean
}

/**
 * Drags the runner on `base` one base on and drops him on Safe or Out: down
 * on the runner, along to the next base (where the drop targets appear) and
 * onto the target, one stroke.
 */
async function dropRunner(
  field: ScoringField,
  base: number,
  decision: 'Safe' | 'Out'
): Promise<void> {
  const shape = await field.field()
  const from = shape.base(base, 3)
  const next = shape.base(base + 1, 3)
  const rect = shape.rect
  const anchor = shape.base(base + 1, 9)
  const targets = runnerTargets(
    { x: anchor.x - rect.x, y: anchor.y - rect.y },
    rect.width,
    rect.height,
    base + 1
  )
  const target = targets[decision === 'Safe' ? 'safe' : 'out']
  await field.m.dragPath({
    points: [
      point(from),
      point(next),
      point({
        x: rect.x + target.x + target.width / 2,
        y: rect.y + target.y + target.height / 2
      })
    ],
    holdDuration: 300,
    duration: 2000
  })
}

/** Taps whoever plays `position` where he stands. */
async function tapFielder(
  field: ScoringField,
  position: string
): Promise<void> {
  await sleep(800)
  const at = (await field.field()).fielder(position, 5)
  await field.m.tapOnPoint({ point: point(at) })
}

/** Caught Stealing: the catcher throws to `receiver`, who makes the tag. */
async function caughtStealing(
  field: ScoringField,
  receiver: string
): Promise<void> {
  await field.shown('Caught Stealing')
  await field.tap('Caught Stealing')
  await field.shown(/^Tap or drag a player to where the ball was fielded/)
  await tapFielder(field, 'C')
  await field.shown(/^Tap or drag the next defender/)
  await tapFielder(field, receiver)
  await field.shown('Done')
  await field.tap('Done')
}

async function gameEvents(
  ctx: E2eContext,
  field: ScoringField
): Promise<unknown> {
  const { TeamStationClient } = await import('../../../../src/common/api')
  const { signInTestAccount } =
    await import('../../../../src/test/passwordFixtures')
  const api = `${ctx.stack.origin}/api/v1`
  const client = new TeamStationClient({
    baseUrl: api,
    token: await signInTestAccount(api, field.world.accounts.scorekeeper)
  })
  return await client.gameEvents(field.world.ids.game)
}

/** The stolen bases the stored game records, in order. */
const steals = (game: unknown): string[] =>
  JSON.stringify(game).match(/stolen_base_(2b|3b|home)/g) ?? []

export default defineCoachSpec({
  id: 'scoring/runners/chain-advance',
  title:
    'A runner dragged toward an occupied base pushes the runners in the way, who each answer Safe, Out or Back',
  covers: [
    'src/app/scoring/runnerChain.ts',
    'src/app/scoring/runnerDrag.ts',
    'src/app/field/FieldScene.tsx',
    'src/app/scoring/RunnerControls.tsx',
    'src/app/scoring/runnerControlLayout.ts',
    'src/app/scoring/scoringFlow.ts',
    'src/app/scoring/scoringMachine.ts',
    'src/app/scoring/scoringMotion.ts',
    'src/app/scoring/ScoringScreen.tsx'
  ],
  minutes: 10,
  faults: ['api-500', 'hidden-element'],
  scenarios: {
    'double-steal': async ctx => {
      // Two walks: runners on first and second, nobody out.
      const field = await openScoringField(ctx, [...WALK, ...WALK])
      const shape = await field.field()
      const video = ctx.artifact('chain-drag.mp4')
      await field.m.startRecording({ path: video })
      const recorded = Date.now()
      const first = shape.base(1, 3)
      const second = shape.base(2, 3)
      const halfway = {
        x: (first.x + second.x) / 2,
        y: (first.y + second.y) / 2
      }
      const plateBefore = field.web ? await plateOf(field, 'R2') : null
      // Halfway to second, on to second, and back to first, where it cancels.
      const pushing = await stroke(
        field,
        [first, halfway, second, first],
        recorded,
        'R2'
      )
      await sleep(1000)
      await fetchRecording(field.m, await field.m.stopRecording(), video)
      writeFileSync(
        ctx.artifact('chain-drag-samples.json'),
        JSON.stringify({ plateBefore, ...pushing }, null, 1)
      )
      frameAt(video, pushing.at[1], ctx.artifact('chain-drag-halfway.png'))
      frameAt(video, pushing.at[2], ctx.artifact('chain-drag-after.png'))
      await ctx.checkpoint('drag-cancelled', {
        expect: [{ text: 'Ball' }],
        readBack: async () => {
          if (field.web) {
            // Halfway, the runner on second had come halfway to third.
            const third = shape.base(3, 3)
            const mid = sampleAt(pushing.samples, pushing.at[1])
            expect(mid, 'the runner on second’s plate halfway').not.equals(null)
            const moved = share(
              plateBefore!,
              {
                x: plateBefore!.x + (third.x - second.x),
                y: plateBefore!.y + (third.y - second.y)
              },
              mid!
            )
            expect(moved, 'how far toward third he was pushed')
              .greaterThan(0.25)
              .and.lessThan(0.75)
            // Released back at first: both back where they stood.
            const after = await plateOf(field, 'R2')
            expect(
              Math.hypot(after!.x - plateBefore!.x, after!.y - plateBefore!.y)
            ).lessThan(4)
          }
          expect(steals(await gameEvents(ctx, field))).deep.equals([])
        }
      })
      // On to Safe: Steal; then the runner pushed to third answers.
      await dropRunner(field, 1, 'Safe')
      await field.shown('Steal')
      await field.tap('Steal')
      await field.shown(/^Pushed runner decision for /)
      const pushed = await field.labels(/^Pushed runner decision for /)
      expect(pushed, 'one pushed runner').length(1)
      const name = pushed[0].replace(/^Pushed runner decision for /, '')
      await ctx.checkpoint('pop-up', {
        expect: [{ text: 'Safe' }, { text: 'Out' }, { text: 'Back' }],
        readBack: async () => {
          if (field.web)
            expect(await disabled(field, `Back ${name}`), 'Back').equals(true)
        }
      })
      await field.tap(`Safe ${name}`)
      await field.shown('Steal')
      await field.tap('Steal')
      await field.shown('Ball')
      await ctx.checkpoint('both-stole', {
        expect: [{ text: 'Ball' }],
        readBack: async () => {
          expect(
            await field.labels(/^Pushed runner decision for /)
          ).deep.equals([])
          await eventually(async () => {
            expect(steals(await gameEvents(ctx, field))).deep.equals([
              'stolen_base_3b',
              'stolen_base_2b'
            ])
          }, 20000)
        }
      })
      await field.tap('Undo')
      await field.shown(/^Pushed runner decision for /)
      await field.tap('Undo')
      await sleep(1500)
      await ctx.checkpoint('undone', {
        expect: [{ text: 'Ball' }],
        readBack: async () => {
          expect(
            await field.labels(/^Pushed runner decision for /)
          ).deep.equals([])
          await eventually(async () => {
            expect(steals(await gameEvents(ctx, field))).deep.equals([])
          }, 20000)
        }
      })
      // Runners on first and third: the same stroke pushes nobody.
      await field.seed(stealing(2))
      await field.reopen()
      const corners = await field.field()
      const plate3 = field.web ? await plateOf(field, 'R3') : null
      const video2 = ctx.artifact('chain-drag-corners.mp4')
      await field.m.startRecording({ path: video2 })
      const recorded2 = Date.now()
      const a = corners.base(1, 3)
      const b = corners.base(2, 3)
      const still = await stroke(
        field,
        [a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, a],
        recorded2,
        'R3'
      )
      await sleep(1000)
      await fetchRecording(field.m, await field.m.stopRecording(), video2)
      frameAt(video2, still.at[1], ctx.artifact('chain-drag-corners.png'))
      await ctx.checkpoint('corners-not-pushed', {
        expect: [{ text: 'Ball' }],
        readBack: async () => {
          if (field.web) {
            const mid = sampleAt(still.samples, still.at[1])
            expect(mid, 'the runner on third’s plate').not.equals(null)
            expect(Math.hypot(mid!.x - plate3!.x, mid!.y - plate3!.y)).lessThan(
              4
            )
          }
        }
      })
    },
    'bases-loaded-back': async ctx => {
      const field = await openScoringField(ctx, [...WALK, ...WALK, ...WALK])
      const video = ctx.artifact('chain-back.mp4')
      await field.m.startRecording({ path: video })
      try {
        await dropRunner(field, 1, 'Out')
        await caughtStealing(field, '2B')
        await field.shown(/^Pushed runner decision for /)
        const pushed = await field.labels(/^Pushed runner decision for /)
        expect(pushed, 'two pushed runners, to third and home').length(2)
        const [toThird, toHome] = pushed.map(label =>
          label.replace(/^Pushed runner decision for /, '')
        )
        await field.m.takeScreenshot({ path: ctx.artifact('chain-popups.png') })
        await ctx.checkpoint('two-pop-ups', {
          expect: [{ text: 'Back' }],
          readBack: async () => {
            if (field.web)
              expect(
                await disabled(field, `Back ${toHome}`),
                'home Back'
              ).equals(true)
          }
        })
        // Back for the runner headed home does nothing yet.
        await field.tap(`Out ${toThird}`)
        await caughtStealing(field, '3B')
        await field.shown(/^Pushed runner decision for /)
        await ctx.checkpoint('home-back-enabled', {
          expect: [{ text: 'Back' }],
          readBack: async () => {
            expect(
              await field.labels(/^Pushed runner decision for /)
            ).deep.equals([`Pushed runner decision for ${toHome}`])
            if (field.web)
              expect(
                await disabled(field, `Back ${toHome}`),
                'home Back'
              ).equals(false)
          }
        })
        await field.tap(`Back ${toHome}`)
        await field.shown('Ball')
      } finally {
        await sleep(1000)
        await fetchRecording(field.m, await field.m.stopRecording(), video)
      }
      await ctx.checkpoint('one-runner-on-third', {
        expect: [{ text: 'Ball' }],
        readBack: async () => {
          expect(field.web ? await plateOf(field, 'R3') : {}).not.equals(null)
          if (field.web) {
            expect(await plateOf(field, 'R1')).equals(null)
            expect(await plateOf(field, 'R2')).equals(null)
          }
          await eventually(async () => {
            const game = (await gameEvents(ctx, field)) as {
              linescore?: unknown
            }
            const text = JSON.stringify(game)
            expect(text.match(/caught_stealing_(2b|3b|home)/g)).deep.equals([
              'caught_stealing_3b',
              'caught_stealing_2b'
            ])
          }, 20000)
        },
        ask: 'One runner stands on third base, the scoreboard shows two outs and no run scored.'
      })
    }
  }
})
