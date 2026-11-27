import { initialHitTarget } from '../../../../src/app/field/trajectoryGuide'
import type { HarnessContext } from '../../../core/spec'
import { defineHarness } from '../../../core/spec'
import {
  DEFENDERS,
  withPhoneScorer
} from '../../../rigs/scoring/phoneWebScorer'

/**
 * A home run's landing dragged relative to where the finger starts: the
 * chip reads In-the-park until the drag reaches the stands, and the play
 * scores itself with no Safe to answer and no edit window. The in-park drag
 * crosses the warning track twice on its way, a path through several points
 * on one press, which maestro-d cannot draw: that scenario blocks there.
 */
async function homeRun(ctx: HarnessContext, outside: boolean): Promise<void> {
  await withPhoneScorer(ctx, async s => {
    await s.orient('portrait')
    await s.freshGame({ restart: true })
    await s.tap('Swing in Play')
    await s.tap('Home Run')
    await s.visible('Home run type: In-the-park Home Run')
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
    await s.shot(outside ? 'stands-trajectory-chip' : 'in-park-trajectory-chip')
    await s.gesture([start, { x: start.x, y: start.y - 30 }], 80)
    await s.visible('Batter Player 2')
    await s.absent('^Safe$')
    await s.absent('Time to edit play')
    await s.shot(outside ? 'stands-finished' : 'in-park-finished')
  })
}

/**
 * Scoring on the 3D field in Safari on an iPhone by dragging: home runs
 * placed relative to the finger, and batter interference's relay tapped
 * and dragged through three defenders to one out.
 */
export default defineHarness({
  id: 'scoring/phone-web/field-gestures',
  title:
    'Safari field drags place home runs relative to the finger and relay batter interference',
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
  minutes: 5,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'in-park-home-run': async ctx => {
      await homeRun(ctx, false)
    },
    'stands-home-run': async ctx => {
      await homeRun(ctx, true)
    },
    'interference-relay': async ctx => {
      await withPhoneScorer(ctx, async s => {
        await s.orient('portrait')
        await s.freshGame({ restart: true })
        await s.tap('Swing in Play')
        await s.tap('Batter Out')
        await s.tap('Batter Interference')
        await s.visible('Tap or drag a player to where the ball was fielded')
        const relay = await s.geometry()
        await s.gesture([relay.project(0, -18.44, 6)], 80)
        await s.visible('Drag up and down for ball trajectory')
        const arcStart = {
          x: relay.field.x + relay.field.width * 0.25,
          y: relay.field.y + relay.field.height * 0.6
        }
        await s.gesture([arcStart, { x: arcStart.x, y: arcStart.y - 25 }], 80)
        await s.visible('Tap or drag the next defender')
        for (const [id, name] of [
          ['1B', 'Player 3'],
          ['2B', 'Player 4']
        ]) {
          const { x, z } = DEFENDERS[id]
          await s.gesture([relay.project(x, z, 6)], 80)
          await s.visible(`Undo Throw to ${name}`)
          await s.visible('Tap or drag the next defender')
        }
        await s.gesture(
          [
            relay.project(DEFENDERS.SS.x, DEFENDERS.SS.z, 6),
            relay.project(-10, -35, 6)
          ],
          80
        )
        await s.visible('Undo Throw to Player 5')
        await s.visible('Tap or drag the next defender')
        await s.shot('three-recipient-relay')
        await s.tap('Finish defensive play')
        await s.visible('Batter Player 2')
        await ctx.checkpoint(
          'interference-one-out',
          { expect: [{ text: 'Batter Player 2' }, { text: '1 outs' }] },
          s.m
        )
        await s.shot('interference-one-out')
        s.log('PASS Safari interference submenu and tapped/dragged relays')
      })
    }
  }
})
