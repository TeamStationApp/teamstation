import { BASES } from '../../../../src/app/field/fieldModel'
import { initialHitTarget } from '../../../../src/app/field/trajectoryGuide'
import { runnerTargets } from '../../../../src/app/scoring/runnerDrag'
import type { HarnessContext } from '../../../core/spec'
import { defineHarness } from '../../../core/spec'
import {
  DEFENDERS,
  type FieldGeometry,
  withPhoneScorer
} from '../../../rigs/scoring/phoneWebScorer'

/** The centre of the Safe target for a runner going to `base`. */
function safeTarget(g: FieldGeometry, base: number): { x: number; y: number } {
  const next = g.project(BASES[base].x, BASES[base].z, 9)
  const rect = runnerTargets(
    { x: next.x - g.field.x, y: next.y - g.field.y },
    g.field.width,
    g.field.height,
    base
  ).safe
  return {
    x: g.field.x + rect.x + rect.width / 2,
    y: g.field.y + rect.y + rect.height / 2
  }
}

/**
 * A runner put on first, then dragged through second onto Safe, and the
 * advance credited to a Wild Pitch or a Passed Ball, which More offers only
 * with a runner on: the pitch count stays, and Undo takes the credit back.
 * The drag turns at second on one press, which maestro-d cannot draw: the
 * scenario blocks there, after the menus' checks.
 */
async function advanceReason(
  ctx: HarnessContext,
  reason: 'Wild Pitch' | 'Passed Ball'
): Promise<void> {
  await withPhoneScorer(ctx, async s => {
    await s.orient('portrait')
    await s.freshGame({ restart: true })
    await s.tap('More')
    await s.absent('^Wild Pitch$')
    await s.absent('^Passed Ball$')
    await s.tap('Put Batter on Base')
    await s.tap('First')
    await s.visible('Batter Player 2')
    await s.visible('^Called Strike$')
    await s.absent('Confirm Placements')
    await s.absent('Time to edit play')
    await s.tap('More')
    await s.absent('^Put Batter on Base$')
    await s.tap('Dismiss More')
    await s.tap('Ball')
    await s.visible('^Called Strike$')
    const g = await s.geometry()
    await s.gesture(
      [
        g.project(BASES[1].x, BASES[1].z, 6),
        g.project(BASES[2].x, BASES[2].z, 6),
        safeTarget(g, 2)
      ],
      500
    )
    await s.visible('Runner advance')
    await s.tap(reason)
    await s.visible(`Undo ${reason}`)
    await s.visible('^Called Strike$')
    await s.shot(reason.toLowerCase().replaceAll(' ', '-'))
    await s.tap(`Undo ${reason}`)
    await s.visible('Batter Player 2')
  })
}

/**
 * A home run dragged in the park or into the stands celebrates (HOME RUN)
 * and is gone within six and a half seconds, with nothing left to answer.
 * The in-park drag crosses the warning track twice on one press, which
 * maestro-d cannot draw: that scenario blocks there.
 */
async function celebration(
  ctx: HarnessContext,
  outside: boolean
): Promise<void> {
  await withPhoneScorer(ctx, async s => {
    await s.orient('portrait')
    await s.freshGame({ restart: true })
    await s.tap('Swing in Play')
    await s.tap('Home Run')
    await s.visible('Home run type: In-the-park Home Run')
    await s.shot(
      outside ? 'stands-location-guidance' : 'in-park-location-guidance'
    )
    const g = await s.geometry()
    const start = {
      x: g.field.x + g.field.width * 0.25,
      y: g.field.y + g.field.height * 0.64
    }
    const initialTarget = initialHitTarget('R')
    const initial = g.project(initialTarget.x, initialTarget.z)
    const target = g.project(0, outside ? -133 : -95, outside ? 8 : 0.7)
    await s.gesture(
      [
        start,
        ...(!outside
          ? [10, -10].map(x => {
              const cross = g.project(x, -95, 0.7)
              return {
                x: start.x + cross.x - initial.x,
                y: start.y + cross.y - initial.y,
                pause: 300
              }
            })
          : []),
        { x: start.x + target.x - initial.x, y: start.y + target.y - initial.y }
      ],
      80
    )
    await s.visible('Drag up and down for ball trajectory')
    await s.visible(
      outside
        ? 'Home run type: Home Run'
        : 'Home run type: In-the-park Home Run'
    )
    await s.shot(
      outside ? 'stands-trajectory-guidance' : 'in-park-trajectory-guidance'
    )
    await s.gesture([start, { x: start.x, y: start.y - 30 }], 80)
    await s.visible('HOME RUN')
    await s.shot(outside ? 'stands-led-celebration' : 'in-park-led-celebration')
    await s.visible('Batter Player 2')
    await new Promise(resolve => setTimeout(resolve, 6500))
    await s.absent('HOME RUN')
    await s.absent('^Safe$')
    await s.absent('Time to edit play')
    await s.shot(outside ? 'stands-finished' : 'in-park-finished')
  })
}

/**
 * A swung or bunted ball fielded and its trajectory set: a Single waits for
 * Finish at-bat, a caught ball and a ground out (thrown to first) go on to
 * the next batter by themselves, and a bunt offers no Home Run.
 */
async function fielded(
  ctx: HarnessContext,
  bunt: boolean,
  outcome: 'Single' | 'Ball Caught' | 'Ground Out'
): Promise<void> {
  const caught = outcome === 'Ball Caught'
  await withPhoneScorer(ctx, async s => {
    await s.orient('portrait')
    await s.freshGame({ restart: true })
    await s.tap(bunt ? 'Bunt in Play' : 'Swing in Play')
    if (bunt) await s.absent('^Home Run$')
    if (outcome !== 'Single') {
      await s.tap('Batter Out')
      await s.tap(outcome)
    } else await s.tap('Single')
    await s.visible('Tap or drag a player to where the ball was fielded')
    const g = await s.geometry()
    await s.gesture([g.project(0, -18.44, 6), g.project(20, -40, 0.7)], 80)
    await s.visible('Drag up and down for ball trajectory')
    await s.shot(caught ? 'caught-trajectory' : 'single-trajectory')
    const start = {
      x: g.field.x + g.field.width * 0.25,
      y: g.field.y + g.field.height * 0.6
    }
    await s.gesture([start, { x: start.x, y: start.y - 25 }], 80)
    if (outcome === 'Ground Out') {
      await s.visible('Tap or drag the next defender')
      const receiver = g.project(DEFENDERS['1B'].x, DEFENDERS['1B'].z, 6)
      await s.m.tapOnPoint({
        x: Math.round(receiver.x),
        y: Math.round(receiver.y)
      })
      await s.tap('Finish defensive play')
    }
    if (caught || outcome === 'Ground Out') await s.visible('Batter Player 2')
    else {
      await s.visible('Finish at-bat')
      await s.tap('Finish at-bat')
    }
    await ctx.checkpoint(
      `${outcome.toLowerCase().replaceAll(' ', '-')}-finished`,
      { expect: [{ text: 'Batter Player 2' }] },
      s.m
    )
    await s.shot(`${outcome}-finished`)
  })
}

/**
 * Scoring feedback in Safari on an iPhone: advance credits, home-run
 * celebrations, fielded outcomes, the bunt's menus and the controls a
 * fielding step disables.
 */
export default defineHarness({
  id: 'scoring/phone-web/play-feedback',
  title:
    'Safari scoring credits advances, celebrates home runs, completes fielded plays and disables controls mid-play',
  kind: 'e2e',
  covers: ['src/app/scoring/**', 'src/app/field/**'],
  stack: 'isolated',
  fixtures: ['scoring-preview'],
  exclusive: false,
  surfaces: {
    'web-safari-ios': {
      // The field draws in 3D: a GPU, so a physical iPhone.
      devices: [
        { role: 'browser', needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    }
  },
  services: [],
  apps: [],
  secrets: [],
  costUsd: 0,
  minutes: 4,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'wild-pitch-advance': async ctx => {
      await advanceReason(ctx, 'Wild Pitch')
    },
    'passed-ball-advance': async ctx => {
      await advanceReason(ctx, 'Passed Ball')
    },
    'in-park-celebration': async ctx => {
      await celebration(ctx, false)
    },
    'stands-celebration': async ctx => {
      await celebration(ctx, true)
    },
    'swing-single': async ctx => {
      await fielded(ctx, false, 'Single')
    },
    'swing-ball-caught': async ctx => {
      await fielded(ctx, false, 'Ball Caught')
    },
    'swing-ground-out': async ctx => {
      await fielded(ctx, false, 'Ground Out')
    },
    'bunt-single': async ctx => {
      await fielded(ctx, true, 'Single')
    },
    'bunt-ground-out': async ctx => {
      await fielded(ctx, true, 'Ground Out')
    },
    // More's pitch heading, a flick off More that opens nothing, and a bunt
    // undone back to the swing's full menu. The flick turns towards the
    // field's right on one press, which maestro-d cannot draw: it blocks
    // there, after More's heading checks.
    'bunt-menus': async ctx => {
      await withPhoneScorer(ctx, async s => {
        await s.orient('portrait')
        await s.freshGame({ restart: true })
        await s.tap('More')
        await s.absent('^Between pitches$')
        await s.absent("^Didn't see it$")
        await s.visible('^This pitch$')
        await s.tap('Dismiss More')
        const more = await s.find(/^More$/)
        const start = {
          x: more.x + more.width / 2,
          y: more.y + more.height / 2
        }
        const field = await s.find(/^Baseball field\./)
        await s.gesture(
          [
            start,
            { x: start.x, y: start.y - 25 },
            { x: field.x + field.width * 0.9, y: start.y - 160 }
          ],
          80
        )
        await s.absent('^Hit by Pitch$')
        await s.tap('More')
        await s.visible('^Hit by Pitch$')
        await s.tap('Dismiss More')
        await s.tap('Bunt in Play')
        await s.absent('^Home Run$')
        await s.tap('Single')
        await s.tap('Undo Bunt: Single')
        await s.visible('Pitches 0')
        await s.tap('Swing in Play')
        await s.visible('^Home Run$')
        await s.shot('bunt-undo-swing-menu')
        await s.tap('Dismiss outcomes')
      })
    },
    // While a fielder is to be placed, the pitch controls and More open
    // nothing; More's menus are larger; a runner dragged out and back is
    // cancelled, and one dragged on to Safe asks why. Both runner drags
    // turn on one press, which maestro-d cannot draw: the scenario blocks
    // there, after the controls' and More's checks.
    'disabled-controls': async ctx => {
      await withPhoneScorer(ctx, async s => {
        await s.orient('portrait')
        await s.freshGame({ restart: true })
        await s.tap('Swing in Play')
        await s.tap('Single')
        await s.visible('Tap or drag a player to where the ball was fielded')
        for (const label of [
          'Ball',
          'Called Strike',
          'Swing and Miss',
          'Foul Ball',
          'More',
          'Swing in Play'
        ]) {
          const n = (await s.nodes()).find(node => node.text === label)
          if (n?.bounds == null) throw new Error(`Missing ${label}`)
          await s.gesture(
            [
              {
                x: n.bounds.x + n.bounds.width / 2,
                y: n.bounds.y + n.bounds.height / 2
              }
            ],
            80
          )
          await s.absent('^Hit by Pitch$')
          await s.absent('^Single$')
          await s.visible('Tap or drag a player to where the ball was fielded')
        }
        await s.shot('disabled-bottom-controls')
        await s.tap('Undo Single')
        await s.tap('More')
        await s.shot('larger-more-menu')
        await s.tap('Put Batter on Base')
        await s.shot('larger-more-submenu')
        await s.tap('First')
        await s.visible('Batter Player 2')
        const g = await s.geometry()
        const from = BASES[1]
        const to = BASES[2]
        const p = (t: number): { x: number; y: number } =>
          g.project(
            from.x + (to.x - from.x) * t,
            from.z + (to.z - from.z) * t,
            0.7
          )
        await s.gesture(
          [g.project(from.x, from.z, 6), p(0.25), p(0.75), p(0.25), p(0)],
          500
        )
        await s.absent('Safe drag target')
        await s.absent('Runner advance')
        await s.gesture(
          [g.project(from.x, from.z, 6), p(0.75), safeTarget(g, 2)],
          500
        )
        await s.visible('Runner advance')
        await s.shot('runner-safe-reasons')
        await s.tap('Cancel')
        await s.absent('Safe drag target')
        await s.absent('Runner advance')
        await s.shot('cancelled-runner-return')
        s.log('PASS Safari selected scoring-feedback scenarios')
      })
    }
  }
})
