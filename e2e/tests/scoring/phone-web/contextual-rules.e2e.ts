import { BlockedError } from '../../../core/result'
import { defineHarness } from '../../../core/spec'
import {
  cancelRunner,
  center,
  DEFENDERS,
  dragRunner,
  fieldAndTrajectory,
  HELD_FINGER,
  loadBases,
  withPhoneScorer
} from '../../../rigs/scoring/phoneWebScorer'

/**
 * The rules the scoring screen applies by context, in Safari on an iPhone:
 * no Fielder's Choice with the bases empty and one with them loaded, a home
 * run into the stands clamped to a 10° Line Drive, and a loaded Error's
 * relay, its involved jerseys, its credit, home plate's decision with Undo,
 * and third base's runner targets.
 */
export default defineHarness({
  id: 'scoring/phone-web/contextual-rules',
  title:
    "Safari scoring offers Fielder's Choice by context, clamps a stands home run and credits a loaded Error",
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
  minutes: 6,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    // The trajectory is dragged to the bottom and read while the finger is
    // still down (10° Line Drive), then let go: maestro-d lifts every finger
    // it puts down, so the scenario blocks once the control is up.
    'stands-line-drive-clamp': async ctx => {
      await withPhoneScorer(ctx, async s => {
        await s.orient('portrait')
        await s.freshGame()
        await s.tap('Swing in Play')
        await s.absent("^Fielder's Choice$")
        await s.tap('Home Run')
        const g = await s.geometry()
        await s.gesture(
          [
            g.project(0, -18.44, 6),
            g.project(0, -100, 0.7),
            g.project(0, -129, 7)
          ],
          0
        )
        await s.visible('Drag up and down for ball trajectory')
        throw new BlockedError(HELD_FINGER)
      })
    },
    'loaded-error-credit': async ctx => {
      await withPhoneScorer(ctx, async s => {
        await s.orient('portrait')
        await s.freshGame()
        await loadBases(s)
        await s.tap('Swing in Play')
        await s.visible("^Fielder's Choice$")
        await s.tap('Error')
        await fieldAndTrajectory(s)
        await s.visible('Tap and drag another defender')
        await s.absent('Home plate decision')
        const g = await s.geometry()
        const first = DEFENDERS['1B']
        await s.gesture(
          [
            g.project(first.x, first.z, 6),
            g.project(first.x + 4, first.z - 1, 6)
          ],
          0
        )
        await s.visible('Tap and drag another defender')
        await s.tap('Finish defensive play')
        await s.visible('Who committed the error')
        await s.shot('error-involved-jerseys')
        await s.tap('Cancel')
        await s.tap('Finish defensive play')
        const credits = (await s.nodes()).filter(n =>
          (n.text ?? '').startsWith('Error by ')
        )
        const credit = credits[credits.length - 1]?.text
        if (credit == null) throw new Error('No Error by … credit offered')
        await s.tap(credit)
        await s.visible('Home plate decision for Player 8')
        await s.shot('home-decision-right')
        await s.touch(center(await s.find(/^Undo /)))
        await s.visible('Who committed the error')
        await s.tap(credit)
        await s.tap('Safe')
        await s.visible('^Finish at-bat$')
        await s.tap('Finish at-bat')
        await ctx.checkpoint(
          'error-completed',
          { expect: [{ text: 'Batter Player 2' }] },
          s.m
        )
        await s.shot('error-completed')
        // The runner left at second shows third base's left-stacked targets.
        await dragRunner(s, 2, 'out')
        await s.visible('^Caught Stealing$')
        await cancelRunner(s)
        await s.shot('third-base-cancel')
        s.log(
          'PASS contextual choice, stands clamp, loaded Error relay/credit/Undo, home and third-base touch paths'
        )
      })
    }
  }
})
