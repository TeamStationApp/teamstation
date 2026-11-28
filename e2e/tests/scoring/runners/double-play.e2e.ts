import { writeFileSync } from 'node:fs'

import { expect } from 'chai'

import { runnerTargets } from '../../../../src/app/scoring/runnerDrag'
import type { TeamStationClient } from '../../../../src/common/api'
import type { ScoringAction } from '../../../../src/common/scoring/actions'
import type { GameState } from '../../../../src/common/scoring/state'
import { eventually } from '../../../core/readback'
import type { E2eContext } from '../../../core/spec'
import { defineCoachSpec } from '../../../rigs/coach/coachApp'
import { maestroDriver, setTrajectory } from '../../../rigs/fieldPointer'
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
 * to drag. Once it is dragged, the relay plays itself out: the throw to 2nd
 * forces the runner from 1st, the throw to 1st retires the batter, with the
 * credits a hand-scored relay records, and any runner the ground ball moved
 * answers Safe, Out or Back before the play can close.
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

/** Whether Caught out reads "Did not tag" under its label. */
async function subtextShown(field: ScoringField): Promise<boolean> {
  if (!field.web) return await field.showing(/Did not tag/)
  return (await field.app.web!.page.evaluate(
    `(() => { const n = document.querySelector('[aria-label="Caught out"]'); return n != null && n.textContent.includes('Did not tag') })()`
  )) as boolean
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
      expect(await subtextShown(field), 'Did not tag').equals(true)
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
  // The last strikeout leaves the runner on 2nd to confirm where he stands.
  await sleep(1500)
  if (await field.showing('Finish at-bat')) await field.tap('Finish at-bat')
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

/** Steals of the next base by the runner on each of `bases`, in order. */
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

const clients = new WeakMap<ScoringField, Promise<TeamStationClient>>()

interface StoredPlay {
  result: { eventType: string }
  runners: Array<{
    movement: {
      start: string | null
      end: string | null
      outNumber?: number | null
      isOut: boolean
    }
    details: { movementReason?: string | null; runner: { id: number } }
    credits: Array<{
      credit: string
      player?: { id: number }
      position?: string
    }>
  }>
}

/** The stored game, read as the scorekeeper, signed in once per scenario. */
async function storedPlays(
  ctx: E2eContext,
  field: ScoringField
): Promise<{ plays: StoredPlay[]; currentPlay: StoredPlay | null }> {
  let client = clients.get(field)
  if (client == null) {
    client = (async () => {
      const { TeamStationClient } = await import('../../../../src/common/api')
      const { signInTestAccount } =
        await import('../../../../src/test/passwordFixtures')
      const api = `${ctx.stack.origin}/api/v1`
      return new TeamStationClient({
        baseUrl: api,
        token: await signInTestAccount(api, field.world.accounts.scorekeeper)
      })
    })()
    clients.set(field, client)
  }
  return (await (await client).gameEvents(field.world.ids.game)) as never
}

/**
 * A stored play as a scorer would compare two: its result, and each runner
 * by the base he left, where he ended, which out he was, why, and who was
 * credited by position. Ids, times and sequence numbers are left out.
 */
function normalized(play: StoredPlay): unknown {
  return {
    eventType: play.result.eventType,
    runners: play.runners.map(runner => ({
      start: runner.movement.start,
      end: runner.movement.end,
      outNumber: runner.movement.outNumber ?? null,
      isOut: runner.movement.isOut,
      reason: runner.details.movementReason ?? null,
      credits: runner.credits.map(
        credit => `${credit.credit} ${credit.position ?? '?'}`
      )
    }))
  }
}

/** The outs the scoreboard summary reads, or null while it shows none. */
async function outsShown(field: ScoringField): Promise<number | null> {
  const found = (await field.labels(/ \d+ outs /)).map(label =>
    Number(/ (\d+) outs /.exec(label)![1])
  )
  return found[0] ?? null
}

/** Whether a runner is drawn on base `n` (web only: its R`n` nameplate). */
async function runnerDrawn(field: ScoringField, n: number): Promise<boolean> {
  return (await plateOf(field, `R${n}`)) != null
}

/** Taps Undo, which names the step it takes back. */
async function undo(field: ScoringField): Promise<string> {
  const [label] = await field.labels(/^Undo (?!.*Nothing)/)
  if (label == null) throw new Error('Nothing to undo')
  await field.tap(label)
  return label
}

/** The trajectory as the scorer drags it, to `angle`, and accepted. */
async function dragTrajectory(field: ScoringField, angle = 55): Promise<void> {
  await field.shown(/^Drag up and down for ball trajectory/)
  await sleep(800)
  if (field.web) {
    await setTrajectory(maestroDriver(field.m), angle)
    return
  }
  const [summary] = await field.labels(/-?\d+°/)
  const shown = Number(/(-?\d+)°/.exec(summary ?? '45°')![1])
  const rect = (await field.field()).rect
  const centre = { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 }
  await field.m.dragAndDrop({
    from: { point: point(centre) },
    to: { point: point({ x: centre.x, y: centre.y - (angle - shown) * 2 }) },
    holdDuration: 100,
    duration: 600
  })
}

/** More, Double Play, then `kind`. */
async function chooseDoublePlay(
  field: ScoringField,
  kind: string
): Promise<void> {
  expect(await openDoublePlays(field), 'Double Play').equals(true)
  await field.tap(kind)
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

/** Holds the runner standing on `base` and lets go on the Out beside him. */
async function holdRunnerOut(field: ScoringField, base: number): Promise<void> {
  const shape = await field.field()
  const at = shape.base(base, 3)
  const rect = shape.rect
  const anchor = shape.base(base, 9)
  const out = runnerTargets(
    { x: anchor.x - rect.x, y: anchor.y - rect.y },
    rect.width,
    rect.height,
    base
  ).out
  await field.m.dragPath({
    points: [
      point(at),
      point({ x: at.x + 1, y: at.y }),
      point({
        x: rect.x + out.x + out.width / 2,
        y: rect.y + out.y + out.height / 2
      })
    ],
    holdDuration: 600,
    duration: 1500
  })
}

/** The stored game's last play once the at-bat after it has begun. */
async function lastPlay(
  ctx: E2eContext,
  field: ScoringField,
  count: number
): Promise<StoredPlay> {
  let found: StoredPlay | undefined
  await eventually(async () => {
    const stored = await storedPlays(ctx, field)
    expect(stored.plays.length, 'plays stored').equals(count)
    found = stored.plays.at(-1)
  }, 30000)
  return found!
}

async function sixFourThree(ctx: E2eContext): Promise<void> {
  // A walk: a runner on 1st, nobody out.
  const field = await openScoringField(ctx, WALK)
  const before = (await storedPlays(ctx, field)).plays.length
  const batter = await field.batter()
  const video = ctx.artifact('double-play-643.mp4')
  await field.m.startRecording({ path: video })
  await chooseDoublePlay(field, '6-4-3')
  await dragTrajectory(field)
  // SS to 2B, the runner out at 2nd, 2B to 1B, the batter out: on its own.
  await field.shown(/ 2 outs /, 60000)
  await sleep(2500)
  await fetchRecording(field.m, await field.m.stopRecording(), video)
  const menu = await lastPlay(ctx, field, before + 1)
  await ctx.checkpoint('relayed', {
    expect: [{ text: 'Ball' }],
    readBack: async () => {
      expect(await outsShown(field)).equals(2)
      expect(await field.showing('Time to edit play')).equals(false)
      expect(await field.batter()).not.equals(batter)
      if (field.web)
        for (const base of [1, 2, 3])
          expect(await runnerDrawn(field, base), `runner on ${base}`).equals(
            false
          )
      expect(menu.result.eventType).equals('grounded_into_double_play')
      // SS assists and 2B puts out the runner from 1st; 2B assists and 1B
      // puts out the batter.
      expect(
        menu.runners.map(runner => [
          runner.details.movementReason,
          runner.movement.outNumber,
          runner.credits.map(credit => `${credit.credit} ${credit.position}`)
        ])
      ).deep.equals([
        ['Force Out', 1, ['f_assist SS', 'f_putout 2B']],
        ['Ground Out', 2, ['f_assist 2B', 'f_putout 1B']]
      ])
    }
  })
  // Undo takes back the trajectory, relay and all; then the menu choice.
  expect(await undo(field)).matches(/^Undo \d+° /)
  await field.shown(/^Drag up and down for ball trajectory/)
  expect(await undo(field)).equals('Undo Double Play 6-4-3')
  await field.shown('Ball')
  await ctx.checkpoint('undone', {
    expect: [{ text: 'Ball' }],
    readBack: async () => {
      expect(await outsShown(field)).equals(0)
      if (field.web)
        expect(await runnerDrawn(field, 1), 'runner on 1st').equals(true)
      await eventually(async () => {
        expect((await storedPlays(ctx, field)).plays.length).equals(before)
      }, 30000)
    }
  })
  // Again, to the end.
  await chooseDoublePlay(field, '6-4-3')
  await dragTrajectory(field)
  await field.shown(/ 2 outs /, 60000)
  const again = await lastPlay(ctx, field, before + 1)

  // The same play scored by hand, in the next half: a third out, a walk.
  await field.seed([...STRIKEOUT, ...WALK])
  await field.reopen()
  await field.shown(/ 0 outs /)
  const handCount = (await storedPlays(ctx, field)).plays.length
  await field.tap('Swing in Play')
  await field.tap('Batter Out')
  await field.tap('Ground Out')
  await field.shown(/^Tap or drag a player to where the ball was fielded/)
  await sleep(800)
  const shortstop = (await field.field()).fielder('SS', 5)
  await field.m.dragAndDrop({
    from: { point: point(shortstop) },
    to: { point: point({ x: shortstop.x, y: shortstop.y - 4 }) },
    holdDuration: 100,
    duration: 500
  })
  await dragTrajectory(field)
  await field.shown(/^Tap or drag the next defender/)
  await tapFielder(field, '2B')
  await sleep(1500)
  await holdRunnerOut(field, 2)
  await field.shown(/ 1 outs /, 30000)
  await tapFielder(field, '1B')
  await sleep(1500)
  await field.shown('Finish defensive play')
  await field.tap('Finish defensive play')
  await field.shown(/ 2 outs /, 60000)
  const hand = await lastPlay(ctx, field, handCount + 1)
  const difference =
    JSON.stringify(normalized(again)) === JSON.stringify(normalized(hand))
      ? ''
      : `menu:  ${JSON.stringify(normalized(again))}\nhand:  ${JSON.stringify(normalized(hand))}`
  writeFileSync(
    ctx.artifact('double-play-credits.log'),
    [
      `# GET ${ctx.stack.origin}/api/v1/games/<game>/events as the scorekeeper (token not written)`,
      '# the menu 6-4-3, the last play of the top half, as stored:',
      JSON.stringify(again, null, 1),
      '# the hand-scored 6-4-3 (Ground Out, SS, the same trajectory, tap 2B, hold the runner out at 2nd, tap 1B, Done), the last play of the bottom half:',
      JSON.stringify(hand, null, 1),
      '# normalized (ids, times and sequence numbers removed; credits by position):',
      JSON.stringify(normalized(again)),
      JSON.stringify(normalized(hand)),
      '# difference:',
      difference,
      ''
    ].join('\n')
  )
  await ctx.checkpoint('hand-scored', {
    expect: [{ text: 'Ball' }],
    readBack: async () => {
      expect(normalized(hand)).deep.equals(normalized(again))
    }
  })
}

async function groundOtherRunners(ctx: E2eContext): Promise<void> {
  // A walk, two steals and a walk: runners on 1st and 3rd, nobody out.
  const field = await openScoringField(ctx, WALK)
  await field.seed(stealing(1))
  await field.seed(stealing(2))
  await field.seed(WALK)
  await field.reopen()
  await field.shown(/ 0 outs /)
  const video = ctx.artifact('double-play-other-runners.mp4')
  await field.m.startRecording({ path: video })
  await chooseDoublePlay(field, '4-6-3')
  await dragTrajectory(field)
  await field.shown(/^Pushed runner decision for /, 60000)
  const [popup] = await field.labels(/^Pushed runner decision for /)
  const name = popup.replace(/^Pushed runner decision for /, '')
  await sleep(1500)
  await ctx.checkpoint('home-pop-up', {
    expect: [{ text: 'Safe' }, { text: 'Out' }, { text: 'Back' }],
    readBack: async () => {
      expect(await field.labels(/^Pushed runner decision for /)).length(1)
      // No timer while he is asked.
      expect(await field.showing('Time to edit play')).equals(false)
      if (field.web)
        expect(await disabled(field, `Back ${name}`), 'Back').equals(false)
    }
  })
  await field.tap(`Safe ${name}`)
  await field.shown('Ball', 30000)
  await sleep(2000)
  await fetchRecording(field.m, await field.m.stopRecording(), video)
  await ctx.checkpoint('scored', {
    expect: [{ text: 'Ball' }],
    readBack: async () => {
      expect(await outsShown(field)).equals(2)
      expect(await field.labels(/^Pushed runner decision for /)).deep.equals([])
      // He scored and the bases are empty: the play closes with no window.
      expect(await field.showing('Time to edit play')).equals(false)
      await eventually(async () => {
        const last = (await storedPlays(ctx, field)).plays.at(-1)!
        expect(last.result.eventType).equals('grounded_into_double_play')
        expect(
          last.runners.some(
            runner =>
              runner.movement.start === '3B' && runner.movement.end === 'score'
          ),
          'the run'
        ).equals(true)
      }, 30000)
    }
  })

  // The next half: two walks, runners on 1st and 2nd, nobody out.
  await field.seed([...STRIKEOUT, ...WALK, ...WALK])
  await field.reopen()
  await field.shown(/ 0 outs /)
  await chooseDoublePlay(field, '6-4-3')
  await dragTrajectory(field)
  await field.shown(/^Pushed runner decision for /, 60000)
  const [third] = await field.labels(/^Pushed runner decision for /)
  const runner = third.replace(/^Pushed runner decision for /, '')
  await sleep(1500)
  await ctx.checkpoint('third-pop-up', {
    expect: [{ text: 'Back' }],
    readBack: async () => {
      expect(await field.showing('Time to edit play')).equals(false)
      if (field.web)
        expect(await disabled(field, `Back ${runner}`), 'Back').equals(false)
    }
  })
  await field.tap(`Back ${runner}`)
  await field.shown('Time to edit play', 30000)
  await ctx.checkpoint('went-back', {
    expect: [{ text: 'Time to edit play' }],
    readBack: async () => {
      expect(await outsShown(field)).equals(2)
      if (field.web) {
        expect(await runnerDrawn(field, 2), 'runner on 2nd').equals(true)
        expect(await runnerDrawn(field, 3), 'runner on 3rd').equals(false)
      }
    }
  })
}

/** Whether the control labelled `label` is disabled on the page. */
async function disabled(field: ScoringField, label: string): Promise<boolean> {
  return (await field.app.web!.page.evaluate(
    `(() => { const n = document.querySelector('[aria-label=${JSON.stringify(label)}]'); return n != null && n.getAttribute('aria-disabled') === 'true' })()`
  )) as boolean
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
    'src/app/scoring/DropMenuView.tsx',
    'src/app/scoring/scoringFlow.ts',
    'src/app/scoring/battedBall.ts',
    'src/app/scoring/runnerChain.ts',
    'src/app/scoring/RunnerControls.tsx'
  ],
  minutes: 12,
  faults: ['api-500', 'hidden-element'],
  scenarios: {
    'menu-visibility': menuVisibility,
    'six-four-three': sixFourThree,
    'ground-other-runners': groundOtherRunners
  }
})
