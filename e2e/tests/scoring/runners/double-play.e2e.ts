import { expect } from 'chai'

import type { ScoringAction } from '../../../../src/common/scoring/actions'
import type { GameState } from '../../../../src/common/scoring/state'
import type { E2eContext } from '../../../core/spec'
import { defineCoachSpec } from '../../../rigs/coach/coachApp'
import {
  openScoringField,
  type ScoringField,
  WALK
} from '../../../rigs/scoring/scoringField'

/**
 * More offers Double Play while fewer than two are out and a runner is on:
 * a row heading the menu whose submenu opens to its right, with the six
 * ground-ball double plays when a runner is on 1st and Caught out ("Did not
 * tag") with a runner on any base. Choosing a ground double play starts the
 * ball in play with its fielder assumed where he stands and the trajectory
 * to drag.
 */

interface Point {
  x: number
  y: number
}

const sleep = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

const GROUND = ['6-4-3', '4-6-3', '5-4-3', '3-6-3', '1-6-3', '1-4-3']
const ROWS = /^(6-4-3|4-6-3|5-4-3|3-6-3|1-6-3|1-4-3|Caught out)$/
const CALLED: ScoringAction = { type: 'pitch', call: 'C' }
const STRIKEOUT: ScoringAction[] = [CALLED, CALLED, CALLED]

/** The steal of 2nd by the runner on 1st, through the API: the seed. */
function stealSecond(game: GameState): ScoringAction[] {
  return [
    {
      type: 'runnerMovement',
      runner: game.liveData.linescore.offense.first!.id,
      to: '2B',
      reason: 'Steal'
    }
  ]
}

/** Where the nameplate of whoever plays `position` is drawn on the page. */
async function plateOf(
  field: ScoringField,
  position: string
): Promise<Point | null> {
  return (await field.app.web!.page.evaluate(
    `(() => { const n = document.querySelector('[data-nameplate][data-position="${position}"]'); if (n == null) return null; const r = n.getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2 } })()`
  )) as Point | null
}

/** Opens More and, when it is there, its Double Play submenu. */
async function openDoublePlays(field: ScoringField): Promise<boolean> {
  await field.tap('More')
  await field.shown('More scoring actions')
  await sleep(500)
  if (!(await field.showing('Double Play'))) return false
  await field.tap('Double Play')
  await field.shown('Double play')
  await sleep(500)
  return true
}

async function dismissMore(field: ScoringField): Promise<void> {
  await field.tap('Dismiss More')
  await field.shown('Ball')
}

/** The Double Play submenu's rows on screen, in screen order. */
const rowsShown = async (field: ScoringField): Promise<string[]> =>
  await field.labels(ROWS)

async function menuVisibility(ctx: E2eContext): Promise<void> {
  const field = await openScoringField(ctx, [])
  await field.shown('Ball')
  // Bases empty: no Double Play.
  await field.tap('More')
  await field.shown('More scoring actions')
  await sleep(500)
  await ctx.checkpoint('bases-empty', {
    expect: [{ text: 'Put Batter on Base' }],
    readBack: async () => {
      expect(await field.showing('Double Play'), 'Double Play').equals(false)
    }
  })
  await dismissMore(field)

  // A runner on 1st: all seven rows, to the right of the menu.
  await field.seed(WALK)
  await field.reopen()
  await field.shown('Ball')
  await field.tap('More')
  await field.shown('More scoring actions')
  await sleep(500)
  if (await field.showing('Double Play')) {
    await field.tap('Double Play')
    await field.shown('Double play')
    await sleep(500)
  }
  await field.m.takeScreenshot({ path: ctx.artifact('more-menu.png') })
  await ctx.checkpoint('runner-on-first', {
    expect: [{ text: 'Double Play' }, { text: 'Caught out' }],
    readBack: async () => {
      expect(await rowsShown(field)).deep.equals([...GROUND, 'Caught out'])
      expect(await field.showing(/Did not tag/), 'Did not tag').equals(true)
    }
  })
  // 6-4-3: the shortstop, where he stands, holds the ball for the trajectory.
  const shortstop = field.web ? await plateOf(field, 'SS') : null
  await field.tap('6-4-3')
  await field.shown('Drag up and down for ball trajectory.')
  await sleep(1000)
  await field.m.takeScreenshot({
    path: ctx.artifact('double-play-trajectory.png')
  })
  await ctx.checkpoint('trajectory', {
    expect: [{ text: 'Drag up and down for ball trajectory.' }],
    readBack: async () => {
      expect(await field.labels(/^Undo /)).deep.equals([
        'Undo Double Play 6-4-3'
      ])
      if (field.web) {
        expect(shortstop, 'the shortstop’s plate').not.equals(null)
        const now = await plateOf(field, 'SS')
        expect(now, 'the shortstop’s plate now').not.equals(null)
        expect(
          Math.hypot(now!.x - shortstop!.x, now!.y - shortstop!.y),
          'the shortstop moved'
        ).lessThan(4)
      }
    }
  })
  await field.tap('Undo Double Play 6-4-3')
  await field.shown('Ball')

  // The runner stole 2nd: only Caught out.
  await field.seed(stealSecond)
  await field.reopen()
  await field.shown('Ball')
  const second = await openDoublePlays(field)
  await ctx.checkpoint('runner-on-second', {
    expect: [{ text: 'Caught out' }],
    readBack: async () => {
      expect(second, 'Double Play').equals(true)
      expect(await rowsShown(field)).deep.equals(['Caught out'])
    }
  })
  await dismissMore(field)

  // Two outs: no Double Play.
  await field.seed([...STRIKEOUT, ...STRIKEOUT])
  await field.reopen()
  await field.shown('Ball')
  await field.tap('More')
  await field.shown('More scoring actions')
  await sleep(500)
  await ctx.checkpoint('two-outs', {
    expect: [{ text: 'Balk' }],
    readBack: async () => {
      expect(await field.showing('Double Play'), 'Double Play').equals(false)
    }
  })
  await dismissMore(field)
}

export default defineCoachSpec({
  id: 'scoring/runners/double-play',
  title:
    'More offers Double Play, whose submenu lists the double plays the bases allow',
  covers: [
    'src/app/scoring/doublePlay.ts',
    'src/app/scoring/moreActions.ts',
    'src/app/scoring/MoreMenu.tsx',
    'src/app/scoring/MoreMenu.native.tsx',
    'src/app/scoring/dropMenu.ts',
    'src/app/scoring/DropMenuView.tsx'
  ],
  minutes: 6,
  faults: ['api-500', 'hidden-element'],
  scenarios: {
    'menu-visibility': menuVisibility
  }
})
