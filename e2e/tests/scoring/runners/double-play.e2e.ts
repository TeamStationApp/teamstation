import { execFileSync } from 'node:child_process'
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
 * answers Safe, Out or Back before the play can close. Caught out doubles
 * off the runner who did not tag: one on 1st or 3rd by the catcher's throw to
 * that base (or the baseman's own tag), one on 2nd by whoever the scorer says
 * took the throw (or the catcher's tag), and with several runners on by the
 * defender the scorer drags onto the occupied base he tagged.
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
      position?: { abbreviation?: string }
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
        credit => `${credit.credit} ${credit.position?.abbreviation ?? '?'}`
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

const DOUBLE_PLAY = 'grounded_into_double_play'

/** The stored game's plays, once there are more than `after` and the last is a double play. */
async function doublePlayStored(
  ctx: E2eContext,
  field: ScoringField,
  after: number
): Promise<StoredPlay> {
  let found: StoredPlay | undefined
  await eventually(async () => {
    const { plays } = await storedPlays(ctx, field)
    expect(plays.length, 'plays stored').greaterThan(after)
    expect(plays.at(-1)?.result.eventType).equals(DOUBLE_PLAY)
    found = plays.at(-1)
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
  const menu = await doublePlayStored(ctx, field, before)
  writeFileSync(
    ctx.artifact('double-play-menu.json'),
    JSON.stringify(menu, null, 1)
  )
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
          runner.details.movementReason ?? null,
          runner.movement.outNumber,
          runner.credits.map(
            credit => `${credit.credit} ${credit.position?.abbreviation}`
          )
        ])
      ).deep.equals([
        ['r_force_out', 1, ['f_assist SS', 'f_putout 2B']],
        [null, 2, ['f_assist 2B', 'f_putout 1B']]
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
        const { plays } = await storedPlays(ctx, field)
        expect(plays.at(-1)?.result.eventType).not.equals(DOUBLE_PLAY)
      }, 30000)
    }
  })
  // Again, to the end.
  await chooseDoublePlay(field, '6-4-3')
  await dragTrajectory(field)
  await field.shown(/ 2 outs /, 60000)
  const again = await doublePlayStored(ctx, field, before)

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
  await field.shown(/^Undo Force out /, 30000)
  await tapFielder(field, '1B')
  await sleep(1500)
  await field.shown('Finish defensive play')
  await field.tap('Finish defensive play')
  await field.shown(/ 2 outs /, 60000)
  const hand = await doublePlayStored(ctx, field, handCount)
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

/**
 * Drags whoever plays `position` from where he stands to where the ball was
 * caught: `up` points up the screen, `right` to the right, at a fielder's
 * height so the grab's lift is the drop's too.
 */
async function placeCatch(
  field: ScoringField,
  position: string,
  up: number,
  right = 0
): Promise<void> {
  await field.shown(/^Tap or drag a player to where the ball was fielded/)
  await sleep(800)
  const at = (await field.field()).fielder(position, 5)
  await field.m.dragAndDrop({
    from: { point: point(at) },
    to: { point: point({ x: at.x + right, y: at.y - up }) },
    holdDuration: 100,
    duration: 600
  })
}

/** The last stored play, once there are more than `after`. */
async function lastStored(
  ctx: E2eContext,
  field: ScoringField,
  after: number,
  check: (play: StoredPlay) => void
): Promise<StoredPlay> {
  let found: StoredPlay | undefined
  await eventually(async () => {
    const { plays } = await storedPlays(ctx, field)
    expect(plays.length, 'plays stored').greaterThan(after)
    found = plays.at(-1)!
    check(found)
  }, 30000)
  return found!
}

/** The runner who left `base` in `play`: out there, credited by position. */
function doubledOff(play: StoredPlay, base: string): string[] {
  const runner = play.runners.find(found => found.movement.start === base)
  expect(runner, `the runner from ${base}`).not.equals(undefined)
  expect(runner!.movement.isOut, `the runner from ${base} out`).equals(true)
  return runner!.credits.map(
    credit => `${credit.credit} ${credit.position?.abbreviation}`
  )
}

/** Where the element labelled `label` is drawn, or null. */
async function boundsOf(
  field: ScoringField,
  label: string
): Promise<{ x: number; y: number; width: number; height: number } | null> {
  if (field.web)
    return (await field.app.web!.page.evaluate(
      `(() => { const n = [...document.querySelectorAll('[aria-label=${JSON.stringify(label)}]')].find(n => n.getClientRects().length > 0); if (n == null) return null; const r = n.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height } })()`
    )) as never
  const { flatten, labelOf } = await import('../../../rigs/coach/coachApp')
  const node = flatten(await field.m.hierarchy()).find(
    found => labelOf(found) === label && found.bounds != null
  )
  return node?.bounds ?? null
}

async function caughtOneRunner(ctx: E2eContext): Promise<void> {
  // A walk: a runner on 1st, nobody out.
  const field = await openScoringField(ctx, WALK)
  const before = (await storedPlays(ctx, field)).plays.length
  const video = ctx.artifact('caught-out-one.mp4')
  await field.m.startRecording({ path: video })
  await chooseDoublePlay(field, 'Caught out')
  // The center fielder runs back for it.
  await placeCatch(field, 'CF', 40)
  await dragTrajectory(field, 30)
  // His throw to 1B doubles the runner off: two out, nobody on, no window.
  await field.shown(/ 2 outs /, 60000)
  await sleep(2500)
  await fetchRecording(field.m, await field.m.stopRecording(), video)
  await ctx.checkpoint('thrown-to-first', {
    expect: [{ text: 'Ball' }],
    readBack: async () => {
      expect(await outsShown(field)).equals(2)
      expect(await field.showing('Time to edit play')).equals(false)
      if (field.web)
        for (const base of [1, 2, 3])
          expect(await runnerDrawn(field, base), `runner on ${base}`).equals(
            false
          )
      await lastStored(ctx, field, before, play => {
        expect(doubledOff(play, '1B')).deep.equals([
          'f_assist CF',
          'f_putout 1B'
        ])
      })
    }
  })

  // The next half: a third out, a walk and two steals put a runner on 3rd.
  await field.seed([...STRIKEOUT, ...WALK])
  await field.seed(stealing(1))
  await field.seed(stealing(2))
  await field.reopen()
  await field.shown(/ 0 outs /)
  const second = (await storedPlays(ctx, field)).plays.length
  await chooseDoublePlay(field, 'Caught out')
  // The third baseman catches it a step from where he stands: his own tag.
  await placeCatch(field, '3B', 6, -4)
  await dragTrajectory(field, 60)
  await field.shown(/ 2 outs /, 60000)
  await ctx.checkpoint('tagged-at-third', {
    expect: [{ text: 'Ball' }],
    readBack: async () => {
      expect(await outsShown(field)).equals(2)
      expect(await field.showing('Time to edit play')).equals(false)
      await lastStored(ctx, field, second, play => {
        expect(doubledOff(play, '3B')).deep.equals(['f_putout 3B'])
      })
    }
  })
}

const NEXT_DEFENDER =
  'Tap or drag the next defender, or hit Done to finish the out.'

async function caughtSecondDone(ctx: E2eContext): Promise<void> {
  // A walk and a steal: a runner on 2nd, nobody out.
  const field = await openScoringField(ctx, WALK)
  await field.seed(stealing(1))
  await field.reopen()
  await field.shown(/ 0 outs /)
  const before = (await storedPlays(ctx, field)).plays.length
  await chooseDoublePlay(field, 'Caught out')
  await placeCatch(field, 'LF', 20)
  await dragTrajectory(field, 30)
  await field.shown(NEXT_DEFENDER, 60000)
  await sleep(1500)
  await field.m.takeScreenshot({ path: ctx.artifact('caught-out-second.png') })
  await ctx.checkpoint('next-defender', {
    expect: [{ text: NEXT_DEFENDER }],
    readBack: async () => {
      // No timer while he is asked.
      expect(await field.showing('Time to edit play')).equals(false)
      expect(await outsShown(field)).equals(1)
    }
  })
  // The shortstop took the throw at 2nd: that is the out, nobody else asked.
  await tapFielder(field, 'SS')
  await field.shown(/ 2 outs /, 60000)
  await sleep(1500)
  await ctx.checkpoint('thrown-to-second', {
    expect: [{ text: 'Ball' }],
    readBack: async () => {
      expect(await field.showing(NEXT_DEFENDER)).equals(false)
      expect(await outsShown(field)).equals(2)
      await lastStored(ctx, field, before, play => {
        expect(doubledOff(play, '2B')).deep.equals([
          'f_assist LF',
          'f_putout SS'
        ])
      })
    }
  })

  // The next half: a third out, a walk and a steal; Done this time.
  await field.seed([...STRIKEOUT, ...WALK])
  await field.seed(stealing(1))
  await field.reopen()
  await field.shown(/ 0 outs /)
  const second = (await storedPlays(ctx, field)).plays.length
  await chooseDoublePlay(field, 'Caught out')
  await placeCatch(field, 'LF', 20)
  await dragTrajectory(field, 30)
  await field.shown(NEXT_DEFENDER, 60000)
  await sleep(1000)
  await field.tap('Finish defensive play')
  await field.shown(/ 2 outs /, 60000)
  await ctx.checkpoint('done', {
    expect: [{ text: 'Ball' }],
    readBack: async () => {
      expect(await field.showing(NEXT_DEFENDER)).equals(false)
      await lastStored(ctx, field, second, play => {
        // The left fielder ran it in and tagged 2nd himself.
        expect(doubledOff(play, '2B')).deep.equals(['f_putout LF'])
      })
    }
  })
}

const TAG_INSTRUCTION = 'Drag the defender who tagged a base to that base.'

async function caughtTagBase(ctx: E2eContext): Promise<void> {
  // A walk, two steals and a walk: runners on 1st and 3rd, nobody out.
  const field = await openScoringField(ctx, WALK)
  await field.seed(stealing(1))
  await field.seed(stealing(2))
  await field.seed(WALK)
  await field.reopen()
  await field.shown(/ 0 outs /)
  const before = (await storedPlays(ctx, field)).plays.length
  const video = ctx.artifact('caught-out-tag.mp4')
  await field.m.startRecording({ path: video })
  const recorded = Date.now()
  await chooseDoublePlay(field, 'Caught out')
  await placeCatch(field, 'RF', 20)
  await dragTrajectory(field, 30)
  await field.shown(TAG_INSTRUCTION, 60000)
  await sleep(1500)
  const shape = await field.field()
  const first = shape.base(1, 0)
  const third = shape.base(3, 0)
  await ctx.checkpoint('tag-a-base', {
    expect: [
      { text: TAG_INSTRUCTION },
      { text: 'Tag 1st' },
      { text: 'Tag 3rd' }
    ],
    readBack: async () => {
      expect(await field.showing('Tag 2nd'), 'Tag 2nd').equals(false)
      expect(await field.showing('Time to edit play')).equals(false)
      // "Tag 1st" right of 1st, "Tag 3rd" left of 3rd.
      const right = await boundsOf(field, 'Tag 1st')
      const left = await boundsOf(field, 'Tag 3rd')
      expect(right, 'Tag 1st').not.equals(null)
      expect(left, 'Tag 3rd').not.equals(null)
      expect(right!.x, 'Tag 1st right of 1st').greaterThan(first.x)
      expect(left!.x + left!.width, 'Tag 3rd left of 3rd').lessThan(third.x)
    }
  })
  // One slow stroke: the first baseman onto 1st and on to the empty 2nd,
  // let go there. The frame at 1st shows the diamonds; the drop is refused.
  const from = shape.fielder('1B', 5)
  const atFirst = shape.base(1, 5)
  const atSecond = shape.base(2, 5)
  const points = [from, atFirst, atSecond]
  const holdDuration = 300
  const duration = 6000
  const legs = [
    Math.hypot(atFirst.x - from.x, atFirst.y - from.y),
    Math.hypot(atSecond.x - atFirst.x, atSecond.y - atFirst.y)
  ]
  const start = (Date.now() - recorded) / 1000
  await field.m.dragPath({
    points: points.map(point),
    holdDuration,
    duration
  })
  // A moment after the stroke reaches 1st, so the diamonds are drawn there.
  const reached =
    start +
    (holdDuration + (duration * (legs[0] + 2)) / (legs[0] + legs[1])) / 1000
  await sleep(1500)
  await ctx.checkpoint('refused-on-second', {
    expect: [{ text: TAG_INSTRUCTION }],
    readBack: async () => {
      expect(await outsShown(field)).equals(1)
      expect(await field.showing('Tag 1st')).equals(true)
      const { plays, currentPlay } = await storedPlays(ctx, field)
      expect(plays.length).equals(before)
      expect(
        (currentPlay?.runners ?? []).some(
          runner => runner.movement.start != null && runner.movement.isOut
        ),
        'a runner out'
      ).equals(false)
    }
  })
  // Onto 1st: the right fielder's throw to 1B doubles the runner off.
  await field.m.dragAndDrop({
    from: { point: point(from) },
    to: { point: point(atFirst) },
    holdDuration: 100,
    duration: 800
  })
  await field.shown('Time to edit play', 60000)
  const window = await field.countdown()
  await sleep(6500)
  await fetchRecording(field.m, await field.m.stopRecording(), video)
  frameAt(video, reached, ctx.artifact('caught-tag-base-after.png'))
  await ctx.checkpoint('tagged-first', {
    expect: [{ text: 'Ball' }],
    readBack: async () => {
      // The runner on 3rd had the five-second window, then the play closed.
      expect(window, 'the window').not.equals(null)
      if (window!.max != null) expect(window!.max).equals(5)
      expect(window!.now).within(1, 5)
      expect(await outsShown(field)).equals(2)
      expect(await field.showing('Tag 1st')).equals(false)
      if (field.web) {
        expect(await runnerDrawn(field, 1), 'runner on 1st').equals(false)
        expect(await runnerDrawn(field, 3), 'runner on 3rd').equals(true)
      }
      await lastStored(ctx, field, before, play => {
        expect(doubledOff(play, '1B')).deep.equals([
          'f_assist RF',
          'f_putout 1B'
        ])
      })
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
    'src/app/scoring/RunnerControls.tsx',
    'src/app/scoring/TagBaseLabels.tsx',
    'src/app/scoring/battedBallField.ts',
    'src/app/field/FieldScene.tsx',
    'src/app/field/DestinationMarker.tsx'
  ],
  minutes: 20,
  faults: ['api-500', 'hidden-element'],
  scenarios: {
    'menu-visibility': menuVisibility,
    'six-four-three': sixFourThree,
    'ground-other-runners': groundOtherRunners,
    'caught-one-runner': caughtOneRunner,
    'caught-second-done': caughtSecondDone,
    'caught-tag-base': caughtTagBase
  }
})
