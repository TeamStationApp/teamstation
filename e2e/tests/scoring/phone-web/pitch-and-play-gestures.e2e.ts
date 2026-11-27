import { BASES } from '../../../../src/app/field/fieldModel'
import { TERRAIN } from '../../../../src/app/field/terrain'
import type { HarnessContext } from '../../../core/spec'
import { defineHarness } from '../../../core/spec'
import {
  cancelRunner,
  center,
  DEFENDERS,
  dragRunner,
  fieldAndTrajectory,
  loadBases,
  type PhoneScorer,
  withPhoneScorer
} from '../../../rigs/scoring/phoneWebScorer'

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** A runner on first: a Single fielded and finished. */
async function singleToFirst(s: PhoneScorer): Promise<void> {
  const button = await s.find(/^Swing in Play$/)
  // An upward drag from the button's chevrons, released on the reversed
  // menu's Single row.
  await s.gesture([
    { x: button.x + button.width - 12, y: button.y + button.height / 2 },
    { x: button.x + button.width / 2, y: button.y - 132 }
  ])
  await fieldAndTrajectory(s)
  await s.visible('^Finish at-bat$')
  await s.visible(
    'Drag any other runners to advance them or have them called out'
  )
  await s.shot('correction-countdown')
  await s.tap('Finish at-bat')
  await s.visible('Batter Player 2')
  await s.absent('^Finish at-bat$')
}

/**
 * More's Put Batter on Base and its Second, in landscape: the menu is
 * dragged up from beside More and its child panel opens on the field's
 * right half.
 */
async function moreLandscape(s: PhoneScorer): Promise<void> {
  await s.orient('landscape')
  await sleep(900)
  await s.touch(center(await s.find(/^More$/)))
  const g = await s.geometry()
  const button = await s.find(/^More$/)
  await s.gesture(
    [
      { x: button.x + 80, y: button.y - 25 },
      { x: button.x + 80, y: g.field.y + 25 }
    ],
    80
  )
  await s.touch(center(await s.find(/^Put Batter on Base$/)))
  const child = await s.find(/^Second$/)
  if (!(child.x >= g.field.x + g.field.width / 2))
    throw new Error('Second must open on the field’s right half in landscape')
  await s.touch(center(child))
  await s.find(/^Cancel$/)
  await s.shot('more-submenu-landscape')
  await s.touch(center(await s.find(/^Cancel$/)))
}

/**
 * A home run dragged in the park or into the stands, with the bases empty
 * or loaded: the in-park runners each take home on Safe, the score shows,
 * nothing is left to answer, and Undo takes the play back.
 */
async function homeRun(
  ctx: HarnessContext,
  outside: boolean,
  loaded: boolean
): Promise<void> {
  await withPhoneScorer(ctx, async s => {
    await s.orient('portrait')
    await s.freshGame()
    if (loaded) await loadBases(s)
    await s.tap('Swing in Play')
    await s.tap('Home Run')
    const g = await s.geometry()
    await s.gesture([
      g.project(0, -18.44, 6),
      g.project(0, -100, 0.7),
      ...(outside ? [g.project(0, -129, 7)] : [])
    ])
    await s.visible(
      outside
        ? 'fielded ball. Home Run|trajectory.*Home Run'
        : 'In-the-park Home Run'
    )
    await s.shot(
      `home-run-${outside ? 'stands' : 'inside'}-${loaded ? 'loaded' : 'empty'}-trajectory`
    )
    const start = {
      x: g.field.x + g.field.width / 2,
      y: g.field.y + g.field.height * 0.55
    }
    await s.gesture([start, { x: start.x, y: start.y + 35 }])
    if (loaded && !outside) {
      for (const name of ['Player 8', 'Player 7', 'Player 6']) {
        await s.visible(`Home plate decision for ${name}`)
        await s.tap('Safe')
      }
    }
    await s.visible('Batter Player 2', 45000)
    await s.visible(`Owls ${loaded ? 4 : 1} · Hawks 0`)
    await s.absent('^Finish at-bat$')
    await s.absent('Home plate decision')
    await s.shot(
      `home-run-${outside ? 'stands' : 'inside'}-${loaded ? 'loaded' : 'empty'}-complete`
    )
    await s.m.tapOn({ text: '^Undo ', enabled: true })
    await s.absent('Batter Player 2')
  })
}

/**
 * Scoring by touch in Safari on an iPhone: a long touch opens the swing
 * menu with no text selection, More opens and closes, each pitch shows,
 * a swing dragged into its menu is fielded and finished, a runner dragged
 * onto Out or Safe asks why (in portrait and landscape) and a Steal is
 * accepted, a ground out's relay goes through first, second and short, the
 * sound toggles, and More's Hit by Pitch awards first.
 */
export default defineHarness({
  id: 'scoring/phone-web/pitch-and-play-gestures',
  title:
    'Safari scoring takes pitches, swings, runner drags, relays, More awards and home runs by touch',
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
  minutes: 10,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: {
    'touch-journey': async ctx => {
      await withPhoneScorer(ctx, async s => {
        const { m } = s
        await s.orient('portrait')
        await s.freshGame()
        await s.shot('ready-portrait')
        await m.longPressOn({ text: '^Swing in Play$', enabled: true })
        await s.visible('^Single$')
        await s.absent('^(Copy|Look Up|Translate|Select All)$')
        await s.shot('long-touch-menu')
        let g = await s.geometry()
        await s.touch({
          x: g.field.x + 15,
          y: g.field.y + g.field.height * 0.45
        })
        await s.absent('^Single$')
        await s.touch(center(await s.find(/^More$/)))
        await m.assertVisible({ text: '^Wild Pitch$', timeout: 5000 })
        await s.shot('more-menu')
        await s.touch({ x: g.field.x + g.field.width - 15, y: g.field.y + 200 })
        await s.absent('^Wild Pitch$')

        for (const pitch of [
          'Ball',
          'Called Strike',
          'Swing and Miss',
          'Foul Ball'
        ]) {
          await s.tap(pitch)
          await s.visible('^Ball$')
          await s.shot(pitch.toLowerCase().replaceAll(' ', '-'))
        }
        await s.visible('Pitches 4')
        await singleToFirst(s)

        await dragRunner(s, 1, 'out')
        await s.visible('^Caught Stealing$')
        await s.shot('out-reason-portrait')
        await cancelRunner(s)
        await dragRunner(s, 1, 'safe')
        await s.visible('^Steal$')
        await s.shot('safe-reason-portrait')
        await cancelRunner(s)

        await s.orient('landscape')
        await sleep(500)
        await s.shot('ready-landscape')
        await dragRunner(s, 1, 'out')
        await s.visible('^Caught Stealing$')
        await s.shot('out-reason-landscape')
        await cancelRunner(s)
        await dragRunner(s, 1, 'safe')
        await s.visible('^Steal$')
        await s.shot('safe-reason-landscape')
        await cancelRunner(s)
        await s.orient('portrait')
        await dragRunner(s, 1, 'safe')
        await s.visible('^Steal$')
        await s.tap('Steal')
        await s.visible('^Swing in Play$')
        await s.shot('steal-accepted')

        await s.tap('Swing in Play')
        await s.tap('Batter Out')
        await s.tap('Ground Out')
        await fieldAndTrajectory(s)
        await s.visible('Tap and drag the next defender')
        await s.shot('receiver-choice')
        g = await s.geometry()
        const first = DEFENDERS['1B']
        await s.gesture([
          g.project(first.x, first.z, 6),
          g.project(BASES[1].x, BASES[1].z, TERRAIN.players)
        ])
        await s.visible('Tap and drag the next defender')
        for (const point of [DEFENDERS['2B'], DEFENDERS.SS]) {
          await s.gesture([
            g.project(point.x, point.z, 6),
            g.project(point.x, point.z, TERRAIN.players)
          ])
          await s.visible('Tap and drag the next defender')
          await s.shot('relay-possession')
        }
        await s.tap('Finish defensive play')
        await s.visible('^Finish at-bat$')
        await s.shot('throw-out-correction')
        await s.visible('Batter Player 3')
        await s.absent('^Finish at-bat$')
        await s.shot('natural-countdown-next-batter')

        await s.tap('Open scoring menu')
        await s.tap('Settings')
        await s.tap('Toggle scoring sound')
        await s.shot('sound-toggled')
        await s.tap('Cancel')
        await s.tap('Ball')
        await s.visible('^Ball$')
        await s.tap('Open scoring menu')
        await s.tap('Settings')
        await s.tap('Toggle scoring sound')
        await s.tap('Cancel')
        await s.touch(center(await s.find(/^More$/)))
        await s.tap('Hit by Pitch')
        await s.visible('^Finish at-bat$')
        await s.tap('Finish at-bat')
        await s.visible('Batter Player 4')
        await s.shot('more-award-completed')
        s.log('PASS: Safari interaction sequence')
      })
    },
    // A runner dragged halfway to second, back past halfway and off the
    // field is cancelled: one press turning through several points, which
    // maestro-d cannot draw, so the scenario blocks there.
    'reverse-halfway-cancels': async ctx => {
      await withPhoneScorer(ctx, async s => {
        await s.orient('portrait')
        await s.freshGame()
        await singleToFirst(s)
        const g = await s.geometry()
        const along = (
          fraction: number
        ): { x: number; y: number; pause: number } => {
          const a = BASES[1]
          const b = BASES[2]
          return {
            ...g.project(
              a.x + (b.x - a.x) * fraction,
              a.z + (b.z - a.z) * fraction,
              TERRAIN.players
            ),
            pause: 700
          }
        }
        await s.gesture([
          g.project(BASES[1].x, BASES[1].z, 6),
          along(0.35),
          along(0.7),
          along(0.35),
          {
            x: g.field.x + g.field.width - 8,
            y: g.field.y + g.field.height * 0.65
          }
        ])
        await s.absent('^(Safe|Out) drag target$')
        await s.absent('^Runner (advance|out)$')
        await s.shot('reverse-halfway-cancelled')
      })
    },
    // In portrait the finger crosses from More to Put Batter on Base, over to
    // its child panel and back, twice, and lets go on Second: one press
    // through several points, which maestro-d cannot draw, so it blocks.
    'more-submenu-portrait': async ctx => {
      await withPhoneScorer(ctx, async s => {
        await s.orient('portrait')
        await s.freshGame()
        await s.touch(center(await s.find(/^More$/)))
        const parent = await s.find(/^Put Batter on Base$/)
        const button = await s.find(/^More$/)
        const g = await s.geometry()
        if (!(parent.x + parent.width <= g.field.x + g.field.width / 2 + 1))
          throw new Error('Put Batter on Base must sit on the left half')
        await s.touch({ x: g.field.x + g.field.width - 15, y: g.field.y + 100 })
        // The child panel is bottom:128 with three 44px rows: its middle row.
        const right = {
          x: g.field.x + g.field.width * 0.75,
          y: g.field.y + g.field.height - 128 - 66
        }
        const p = center(parent)
        const b = center(button)
        await s.gesture([
          b,
          { ...b, y: b.y - 20, pause: 500 },
          p,
          { ...p, x: p.x + 1, pause: 500 },
          { x: right.x, y: p.y },
          right,
          { x: right.x, y: p.y },
          p,
          { ...p, x: p.x + 1, pause: 500 },
          { x: right.x, y: p.y },
          right
        ])
        await s.visible('^Put Batter on Base$')
        await s.shot('more-submenu-portrait')
        await s.tap('Cancel')
        await s.absent('^First$')
      })
    },
    'more-submenu-landscape': async ctx => {
      await withPhoneScorer(ctx, async s => {
        await s.freshGame()
        await moreLandscape(s)
        await s.orient('portrait')
      })
    },
    'home-run-inside-empty': async ctx => {
      await homeRun(ctx, false, false)
    },
    'home-run-inside-loaded': async ctx => {
      await homeRun(ctx, false, true)
    },
    'home-run-stands-empty': async ctx => {
      await homeRun(ctx, true, false)
    },
    'home-run-stands-loaded': async ctx => {
      await homeRun(ctx, true, true)
    },
    // Each pitch's motion plays out and the controls come back; a Single's
    // flight and trajectory wait, and Finish at-bat closes it.
    motion: async ctx => {
      await withPhoneScorer(ctx, async s => {
        await s.orient('portrait')
        await s.freshGame()
        await s.shot('motion-ready')
        for (const pitch of [
          'Ball',
          'Called Strike',
          'Swing and Miss',
          'Foul Ball'
        ]) {
          await s.tap(pitch)
          await sleep(2000)
          await s.visible('^Ball$')
          await s.shot(`motion-${pitch.toLowerCase().replaceAll(' ', '-')}`)
        }
        await s.tap('Swing in Play')
        await s.tap('Single')
        await fieldAndTrajectory(s)
        await s.visible('^Finish at-bat$')
        await s.tap('Finish at-bat')
        await s.shot('completed')
      })
    }
  }
})
