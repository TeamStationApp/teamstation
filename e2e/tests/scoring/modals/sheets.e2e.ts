import { strict as assert } from 'node:assert'
import { writeFileSync } from 'node:fs'

import type { FixtureManifest } from '../../../core/fixtures'
import { BlockedError } from '../../../core/result'
import {
  defineHarness,
  type HarnessContext,
  type HarnessScenario
} from '../../../core/spec'
import { turnWheel, wheelAt, wheelValue } from '../../../rigs/iosWheel'
import {
  type Book,
  bookReader,
  flat,
  holdRequests,
  listOf,
  type Node,
  openScorer,
  pause,
  type Scorer,
  SCORER_ROLE,
  textOf,
  until
} from '../../../rigs/scoring/scorerSheets'

/**
 * The scoring screen's sheets as a scorekeeper of both teams drives them,
 * on Safari on an iPhone and in the develop app on one: Settings, Set Team
 * Rosters and Create Player, the placeholder picker, the tiebreaker runner,
 * Overrides, End Half Inning, End Game and Exit Current Game, and the runner
 * and error decisions raised from the field. Each scenario opens games of
 * its own `scoring-sheets` world, and reads what the screen saved back from
 * the stack's API.
 */

const WORLD = 'scoring-sheets'

/** One scenario's scorer, world and the games it has opened. */
export interface Sheets {
  ctx: HarnessContext
  s: Scorer
  world: FixtureManifest
  book: (gameId: string) => Promise<Book>
  /** The game the screen opened last. */
  game: string
  ready: string[]
  noPitcher: string[]
}

export async function begin(ctx: HarnessContext): Promise<Sheets> {
  const world = await ctx.fixture(WORLD)
  const s = await openScorer(ctx)
  return {
    ctx,
    s,
    world,
    book: bookReader(ctx, world.accounts.scorer),
    game: '',
    ready: listOf(world.ids, 'readyGames'),
    noPitcher: listOf(world.ids, 'noPitcherGames')
  }
}

/**
 * Opens a game no scenario has scored, on its first pitch, or, `missing`,
 * one whose home lineup has no pitcher; or `existing` again.
 */
export async function open(
  run: Sheets,
  missing = false,
  existing?: string
): Promise<void> {
  const pool = missing ? run.noPitcher : run.ready
  const game = existing ?? pool.shift()
  if (game == null) throw new Error('The world has no unopened game left')
  run.game = game
  await run.s.open(`games/${game}/score`)
  // The menu button is an icon: in a browser its name is only its
  // aria-label, which maestro-d's hierarchy leaves out, so the page is read.
  if (run.s.web != null)
    await run.s.web.page.waitForSelector('[aria-label="Open scoring menu"]', {
      timeout: 45000
    })
  else await run.s.shown('^Open scoring menu$', 45000)
  if (existing == null) {
    // The pad's buttons draw their names in capitals in a browser; the
    // page's own label is the name.
    if (run.s.web != null && !missing)
      await run.s.web.page.waitForSelector('[aria-label="Ball"]')
    else await run.s.shown(missing ? 'Assign a pitcher' : '^Ball$')
  }
}

/** Waits until the open game's book, as the server keeps it, matches. */
export async function waitForBook(
  run: Sheets,
  matches: (game: Book) => boolean,
  what: string
): Promise<Book> {
  return await until(async () => await run.book(run.game), matches, what)
}

/** The screen's hierarchy beside its picture, as the legacy capture kept it. */
async function capture(run: Sheets, state: string): Promise<void> {
  await run.s.capture(state)
  writeFileSync(
    run.ctx.artifact(`${run.s.surface}-${state}.json`),
    JSON.stringify(await run.s.m.hierarchy(), null, 2)
  )
}

/**
 * Nothing the sheets asked of the server failed: the checkpoint's
 * invariants read the stack's 5xx since the scenario began.
 */
async function settled(run: Sheets, id: string): Promise<void> {
  await run.ctx.checkpoint(
    id,
    { expect: [{ text: 'Open scoring menu', timeout: 20000 }] },
    run.s.m
  )
}

/** The field's viewport and the camera the scoring screen opens with. */
async function fieldOf(run: Sheets): Promise<{
  rect: NonNullable<Node['bounds']>
  project: (x: number, z: number, y?: number) => { x: number; y: number }
}> {
  const { PerspectiveCamera, Vector3 } = await import('three')
  const { applyFieldCamera } =
    await import('../../../../src/app/field/cameraModel')
  const nodes = await run.s.nodes()
  const all = flat((await run.s.m.hierarchy()) as Node)
  const rect = (
    run.s.native
      ? all.find(node => node.type === 'Window')
      : (nodes.find(
          node => textOf(node)?.startsWith('Baseball field.') === true
        ) ?? all.find(node => node.type === 'WebView'))
  )?.bounds
  assert(rect != null, 'The field viewport must be measurable')
  const camera = new PerspectiveCamera()
  applyFieldCamera(camera, {
    width: rect.width,
    height: rect.height,
    view: 'home',
    zoom: 1.25,
    tilt: (-11 * Math.PI) / 180,
    heightOffset: 33,
    bottomExtension: 112
  })
  return {
    rect,
    project: (x, z, y = 3) => {
      const v = new Vector3(x, y, z).project(camera)
      return {
        x: rect.x + ((v.x + 1) * rect.width) / 2,
        y: rect.y + ((1 - v.y) * rect.height) / 2
      }
    }
  }
}

const at = (p: { x: number; y: number }): string =>
  `${Math.round(p.x)},${Math.round(p.y)}`

/** Settings, a pitch and its Undo, a roster save and its Undo, and the confirmations. */
export async function behavior(run: Sheets): Promise<void> {
  const { s } = run
  await open(run)
  await s.menu('Settings')
  for (const label of [
    'Toggle scoring sound',
    'Toggle play animations',
    'Toggle switch-hitter help'
  ]) {
    await s.tap(label)
    await s.tap(label)
  }
  await s.tap('Reset shown count')
  await s.shown('Switch-hitter help shown 0 of 3 times')
  await s.reach('Done', { foot: 100 })
  await s.tap('Done')
  await s.menu('Settings')
  await s.shown('Switch-hitter help shown 0 of 3 times')
  await s.reach('Done', { foot: 100 })
  await s.tap('Done')
  await s.tap('Ball')
  await s.shown('Undo Ball')
  await s.tap('Undo Ball')
  await s.menu('Set Team Rosters')
  await s.tap('Home')
  await s.tap('Away')
  await s.tap('Defense')
  await s.tap('Lineup')
  await s.tap('Create Player')
  await s.input('First Name', 'Jose')
  await s.m.pressKey('Enter')
  await s.input('Last Name', 'Ramirez')
  await s.m.pressKey('Enter')
  await s.input('Jersey Number', '11')
  await s.finishKeyboard()
  for (const label of [
    'Player position P',
    'Player position SS',
    'Throws L',
    'Bats S'
  ])
    await s.tap(label)
  await s.reach('Save and Create Another Player')
  await s.tap('Save and Create Another Player')
  await s.shown('First Name')
  await s.input('First Name', 'Gerrit')
  await s.m.pressKey('Enter')
  await s.input('Last Name', 'Cole')
  await s.m.pressKey('Enter')
  await s.input('Jersey Number', '12')
  await s.finishKeyboard()
  await s.reach('Create Player')
  await s.tap('Create Player')
  await s.shown('Gerrit Cole')
  await s.shown('Jose Ramirez')
  await s.tap('Save Rosters')
  await s.shown('Undo Set team roster')
  await s.menu('Set Team Rosters')
  await s.shown('Gerrit Cole')
  await s.tap('Cancel')
  await s.shown('Undo ')
  await s.tapStarts('Undo ')
  await s.menu('Set Team Rosters')
  assert(
    !(await s.texts()).includes('Gerrit Cole'),
    'Undo takes the roster save back'
  )
  await s.tap('Cancel')
  for (const [label, undo] of [
    ['End Half Inning', 'Undo End half inning'],
    ['End Game', 'Undo End game']
  ]) {
    await s.menu(label)
    await s.tap(`Confirm ${label}`)
    await s.shown(undo)
    await s.tap(undo)
  }
}

/**
 * The pitcher fielding a ball in play, its trajectory set, and the error's
 * credit asked for.
 */
export async function openErrorDecision(run: Sheets): Promise<void> {
  const { s } = run
  await open(run)
  await s.tap('Swing in Play')
  await s.tap('Error')
  if (s.web != null) {
    const { maestroDriver, setTrajectory, tapFielder } =
      await import('../../../rigs/fieldPointer')
    const pointer = maestroDriver(s.m)
    await tapFielder(pointer, 'P')
    await setTrajectory(pointer)
  } else {
    const { createPlayers } =
      await import('../../../../src/app/field/fieldModel')
    const field = await fieldOf(run)
    const pitcher = createPlayers().find(player => player.id === 'P')!
    const spot = field.project(pitcher.position.x, pitcher.position.z, 5)
    await s.point(spot.x, spot.y)
    await s.shown('Drag up and down for ball trajectory')
    await pause(2000)
    await s.m.dragAndDrop({
      from: { point: at(spot) },
      to: { point: at({ x: spot.x, y: spot.y - 15 }) },
      holdDuration: 100,
      duration: 500
    })
  }
  await s.shown('Finish defensive play')
  await s.tap('Finish defensive play')
  await s.shown('Who committed the error')
}

/** End Game from an at-bat, a ball in play, an error's credit and the tiebreaker. */
export async function endGameBehavior(run: Sheets): Promise<void> {
  const { s } = run
  await open(run)
  await s.tap('Ball')
  await s.menu('End Game')
  await s.shown('The open at-bat is saved with its pitches')
  await s.tap('Cancel')
  await s.shown('Undo Ball')
  await s.menu('End Game')
  await s.tap('Confirm End Game')
  await waitForBook(
    run,
    game =>
      game.plays.map(play => play.result?.eventType).join(',') ===
        'ts_at_bat_ended,final_score' && game.currentPlay == null,
    'the interrupted at-bat and the final score'
  )
  await s.tap('Undo End game')
  await s.shown('1 balls 0 strikes')
  await s.tap('Undo Ball')

  await s.tap('Swing in Play')
  await s.tap('Single')
  const gameId = run.game
  const live = await waitForBook(
    run,
    game =>
      Array.isArray(game.currentPlay?.playEvents) &&
      game.currentPlay.playEvents.some(
        (event: any) => event.details?.isInPlay === true
      ),
    'the pitch in play'
  )
  await s.menu('End Game')
  await s.shown('The pitch in play is left out of the book')
  await s.tap('Confirm End Game')
  await waitForBook(
    run,
    game =>
      game.currentPlay == null &&
      game.plays.length === 1 &&
      game.plays[0].result?.eventType === 'final_score',
    'a final score with no filed pitch'
  )
  await open(run, false, gameId)
  await s.tap('Undo Last play')
  const restored = await waitForBook(
    run,
    game => game.currentPlay != null && game.plays.length === 0,
    'the reopened batted ball'
  )
  assert.deepEqual(
    restored.currentPlay?.playEvents,
    live.currentPlay?.playEvents,
    'Undo brings the ball in play back as it was'
  )

  await openErrorDecision(run)
  await s.tap('End Game')
  await s.shown('What is still undecided is left undecided')
  await s.tap('Cancel')
  await s.shown('Who committed the error')
  await s.tap('End Game')
  await s.tap('Confirm End Game')
  const filed = await waitForBook(
    run,
    game => game.currentPlay == null && game.plays.length === 2,
    'the chosen result and the final score'
  )
  assert.equal(filed.plays[0].result?.eventType, 'field_error')

  await open(run)
  await s.menu('Set Team Rosters')
  await s.shown('Roster')
  await s.tap('Cancel')
  await s.menu('End Game')
  await s.shown('End the game at Owls 0, Hawks 0')
  await s.tap('Cancel')
  await s.tap('More')
  await s.tap('Place a Runner (Tiebreaker)')
  await s.tap('End Game')
  await s.tap('Cancel')
  await s.shown('Place runner on base')
  await s.tap('End Game')
  await s.tap('Confirm End Game')
  await s.shown('Game over')
}

/** The tiebreaker's runner, Mike Trout, put on first. */
async function placeRunner(run: Sheets): Promise<void> {
  const { s } = run
  await s.tap('More')
  await s.tap('Place a Runner (Tiebreaker)')
  await s.tap('Place runner on base')
  await s.tap('Place runner on 1B')
  await s.shown('Select Runner for 1B')
  await s.tap('Select runner #2 Mike Trout')
  await s.tap('Cancel')
  await s.shown('Undo Place Mike Trout on 1B')
  await pause(4000)
}

/** The runner and error decisions the field raises, captured. */
async function advancedSheets(run: Sheets, section: string): Promise<void> {
  const { s } = run
  await open(run)
  // Safari exposes the canvas's fallback text while WebGL draws: these
  // nameplates come from the real scene, so they prove it mounted.
  await s.shown('Mike Trout')
  if (section !== 'error') {
    const { BASES } = await import('../../../../src/app/field/fieldModel')
    const { runnerTargets } =
      await import('../../../../src/app/scoring/runnerDrag')
    await placeRunner(run)
    // A pitch finishes opening setup before the field gesture.
    await s.tap('Ball')
    await s.shown('Undo Ball')
    await pause(4000)
    const { rect, project } = await fieldOf(run)
    // The runner's figure at first: his nameplate is below the body that
    // takes a press, and the catcher wears the same name.
    const start = project(BASES[1].x, BASES[1].z, 6)
    const anchor = project(BASES[2].x, BASES[2].z, 9)
    const targets = runnerTargets(
      { x: anchor.x - rect.x, y: anchor.y - rect.y },
      rect.width,
      rect.height,
      2
    )
    for (const [target, title, state] of [
      [targets.safe, '^Runner advance$', 'runner-advance'],
      [targets.out, '^Runner out$', 'runner-out']
    ] as const) {
      await s.m.dragAndDrop({
        from: { point: at(start) },
        to: {
          point: at({ x: rect.x + target.x + 40, y: rect.y + target.y + 33 })
        },
        holdDuration: 700,
        duration: 1200
      })
      await s.shown(title)
      await capture(run, state)
      await s.tap('Cancel')
    }
  }
  await openErrorDecision(run)
  await capture(run, 'error-credit')
  await s.tap('Cancel')
}

/** Create Player, then the placeholder picker, set to `count`. */
async function placeholderCount(run: Sheets, count: number): Promise<void> {
  const { s } = run
  await s.menu('Set Team Rosters')
  await s.tap('Create Player')
  await s.finishKeyboard()
  await s.reach('Create Placeholder Player')
  await s.tap('Create Placeholder Player')
  await s.shown('Select number of players to create')
  if (s.native) {
    for (let attempt = 0; attempt < 20; attempt++) {
      const wheel = (await s.nodes()).find(node => node.type === 'PickerWheel')
      assert(wheel?.bounds != null, 'The count is a picker wheel')
      const selected = Number(textOf(wheel)?.split(',')[0])
      assert(Number.isInteger(selected))
      if (selected === count) break
      assert(attempt < 19, 'The picker reaches the count')
      await s.point(
        wheel.bounds.x + wheel.bounds.width / 2,
        wheel.bounds.y + wheel.bounds.height * (selected < count ? 0.64 : 0.36)
      )
    }
  } else {
    for (let attempt = 0; attempt < 8; attempt++) {
      const nodes = await s.nodes()
      const wheel = nodes.find(
        node => textOf(node) === 'Number of placeholder players'
      )?.bounds
      const target = nodes.find(
        node => textOf(node) === `Player count ${count}`
      )?.bounds
      assert(wheel != null)
      if (
        target != null &&
        target.y >= wheel.y &&
        target.y + target.height <= wheel.y + wheel.height
      ) {
        await s.point(target.x + target.width / 2, target.y + target.height / 2)
        break
      }
      assert(attempt < 7, 'The picker reaches its largest count')
      await s.m.swipe({
        startX: Math.round(wheel.x + wheel.width / 2),
        endX: Math.round(wheel.x + wheel.width / 2),
        startY: Math.round(wheel.y + wheel.height - 20),
        endY: Math.round(wheel.y + 20),
        duration: 1
      })
    }
  }
  await s.tap('Create')
  await s.shown('Create Player')
  await s.tap('Cancel')
  await s.reach(count === 1 ? 'Add OWLS A to Lineup' : 'Add OWLS P to Lineup', {
    top: 200,
    foot: 180,
    x: '25%'
  })
  await s.shown(count === 1 ? 'OWLS A' : 'OWLS P')
  await s.tap('Save Rosters')
  await s.shown('Undo Set team roster')
  await s.tap('Undo Set team roster')
}

/** The tiebreaker and Overrides, each with its Undo. */
async function forms(run: Sheets): Promise<void> {
  const { s } = run
  await placeRunner(run)
  await s.tap('Undo Place Mike Trout on 1B')
  await s.menu('Overrides')
  await s.tap('Owls score')
  await s.shown('Owls: 0')
  await s.shown('Done')
  await s.tap('Cancel')
  await s.tap('Cancel')
  await s.menu('Overrides')
  await s.tap('Balls 2')
  await s.tap('Apply Override')
  await s.shown('Undo Override')
  await s.tap('Undo Override')
}

/** The sheets' shells captured, before the scenario's own checks. */
async function shells(run: Sheets, section: string): Promise<void> {
  const { s } = run
  if (section !== 'player') {
    await s.menu('Settings')
    await s.shown('^Scoring sound$')
    await capture(run, 'settings')
    await s.reach('Done', { foot: 100 })
    await s.tap('Done')
  }
  await s.menu('Set Team Rosters')
  await s.shown('^Save Rosters$')
  await capture(run, 'roster-lineup')
  await s.tap('Defense')
  await capture(run, 'roster-defense')
  await s.tap('Create Player')
  await s.shown('^First Name$')
  await capture(run, 'create-player')
  await s.finishKeyboard()
  await s.reach('Create Player')
  await s.tap('Create Player')
  await s.shown('Enter a player name')
  await capture(run, 'player-validation')
  await s.reach('Create Placeholder Player')
  await s.tap('Create Placeholder Player')
  await s.shown('Select number of players to create')
  await capture(run, 'placeholders')
  await s.tap('Cancel')
  await s.tap('Cancel')
  await s.tap('Cancel')
}

/** The tiebreaker, Overrides, End Half Inning, End Game and Exit, captured. */
async function confirmations(run: Sheets): Promise<void> {
  const { s, ctx } = run
  await s.tap('More')
  await s.tap('Place a Runner (Tiebreaker)')
  await s.shown('^Place runner on base$')
  await capture(run, 'tiebreaker')
  await s.tap('Cancel')
  for (const [label, state] of [
    ['Overrides', 'overrides'],
    ['End Half Inning', 'end-half'],
    ['End Game', 'end-game']
  ]) {
    await s.menu(label)
    await capture(run, state)
    await s.tap('Cancel')
  }
  // The pitch stays unsent while the stack holds the game's saves.
  await holdRequests(ctx, `/api/v1/games/${run.game}/events`)
  try {
    await s.tap('Ball')
    await s.menu('Exit Current Game')
    await s.shown('Discard and Exit')
    await capture(run, 'exit')
    await s.tap('Cancel')
  } finally {
    await holdRequests(ctx, null)
  }
}

/** The pitcher's place, its sheet and the existing player assigned there. */
async function defensive(run: Sheets): Promise<void> {
  const { s } = run
  await open(run, true)
  await s.tap('Assign P')
  await s.shown('^Assign pitcher$')
  await s.shown('Bench')
  await s.shown('Fielders')
  await capture(run, 'defensive')
  await s.tap('Create Player')
  await s.shown('First Name')
  await s.tap('Cancel')
  await s.shown('^Assign pitcher$')
  await s.tap('Create Player')
  await s.finishKeyboard()
  await s.reach('Create Placeholder Player')
  await s.tap('Create Placeholder Player')
  await s.shown('Select number of players to create')
  await s.tap('Cancel')
  await s.shown('First Name')
  await s.tap('Cancel')
  await s.shown('^Assign pitcher$')
  await s.tap('Cancel')
  await s.shown('Assign P')
  await s.tap('Assign P')
  await s.tapStarts('Assign P #1 ')
  await s.shown('Undo')
  assert(
    !(await s.texts()).includes('Assign P'),
    'The pitcher is assigned: his place asks for nobody'
  )
}

/** The system's score and inning wheels in Overrides, in the app. */
async function overrideNumbers(run: Sheets): Promise<void> {
  const { s } = run
  await s.menu('Overrides')
  const options = Array.from({ length: 51 }, (_, i) => String(i))
  for (const [row, label, initial] of [
    ['Owls score', 'Owls', 0],
    ['Hawks score', 'Hawks', 0],
    ['Inning', 'Inning', 1]
  ] as const) {
    const reads = async (value: number): Promise<void> => {
      for (let tries = 0; tries < 20; tries++) {
        if (wheelValue(await wheelAt(s.m), options) === String(value)) return
        await s.m.waitForAnimationToEnd({ timeout: 1000 })
      }
      assert.fail(`${label} wheel does not read ${value}`)
    }
    await s.tap(row)
    await reads(initial)
    await s.m.waitForAnimationToEnd({ timeout: 3000 })
    const nodes = await s.nodes()
    const title = nodes.find(node => textOf(node) === label)?.bounds
    // The picker's frame: its wheel's bounds overhang it, for the rows it
    // curves away above and below.
    const wheel = nodes.find(node => node.type === 'Picker')?.bounds
    const done = nodes.find(node => textOf(node) === 'Done')?.bounds
    const cancel = nodes
      .filter(node => textOf(node) === 'Cancel')
      .at(-1)?.bounds
    assert(title != null && wheel != null && done != null && cancel != null)
    assert(title.y + title.height <= wheel.y, 'Title overlaps wheel')
    assert(wheel.height >= 132, 'Wheel must retain its three-row height')
    assert(wheel.y + wheel.height < done.y, 'Done overlaps wheel')
    assert(done.y + done.height < cancel.y, 'Cancel overlaps Done')
    await capture(run, `override-${label.toLowerCase()}`)
    const turn = async (): Promise<void> => {
      await turnWheel(
        s.m,
        async () => await wheelAt(s.m),
        String(initial + 1),
        options
      )
    }
    await turn()
    await s.tap('Cancel')
    await s.tap(row)
    await reads(initial)
    await turn()
    await s.tap('Done')
    await s.tap(row)
    await reads(initial + 1)
    await s.tap('Done')
  }
  await s.tap('Apply Override')
  await s.shown('Undo Override game state')
}

/** A scenario of the sheets, by the legacy run's section. */
function section(name: string): HarnessScenario {
  return async ctx => {
    if (name === 'preview')
      throw new BlockedError(
        "the controlled modal renderer (e2e/fixtures/scoringModalsPreview.tsx) is no entry of any build, so no stack serves its 'Controlled scoring modal fixtures' page"
      )
    if (name === 'override-numbers' && ctx.surface !== 'ios-app')
      throw new BlockedError(
        'the score and inning wheels are the app’s system pickers, which only ios-app draws'
      )
    const run = await begin(ctx)
    if (!['advanced', 'error'].includes(name)) await open(run)
    switch (name) {
      case 'override-numbers':
        await overrideNumbers(run)
        break
      case 'settings':
        await run.s.menu('Settings')
        await run.s.shown('Scoring sound')
        await capture(run, 'settings')
        await run.s.reach('Done', { foot: 100 })
        await run.s.tap('Done')
        return
      case 'defensive':
        await defensive(run)
        break
      case 'behavior':
        await behavior(run)
        await endGameBehavior(run)
        break
      case 'forms':
        await forms(run)
        break
      case 'extended':
      case 'picker':
        if (name === 'extended') await forms(run)
        for (const count of [1, 16]) await placeholderCount(run, count)
        break
      case 'placeholder':
        await run.s.menu('Set Team Rosters')
        await run.s.tap('Create Player')
        await run.s.shown('First Name')
        await run.s.finishKeyboard()
        await run.s.reach('Create Placeholder Player')
        await run.s.tap('Create Placeholder Player')
        await run.s.shown('Select number of players to create')
        await capture(run, 'placeholders')
        for (let i = 0; i < 3; i++) await run.s.tap('Cancel')
        return
      case 'basic':
      case 'player':
      case 'additional':
        if (name !== 'additional') await shells(run, name)
        await confirmations(run)
        if (name === 'basic') await behavior(run)
        break
      case 'advanced':
      case 'error':
        await advancedSheets(run, name)
        await defensiveShell(run)
        await behavior(run)
        break
      default:
        await shells(run, name)
        await confirmations(run)
        await defensiveShell(run)
        await behavior(run)
    }
    await settled(run, `${name}-settled`)
  }
}

/** A game whose home lineup has no pitcher: the pitcher's sheet, captured. */
async function defensiveShell(run: Sheets): Promise<void> {
  await open(run, true)
  await run.s.tap('Assign P')
  await run.s.shown('^Assign pitcher$')
  await capture(run, 'defensive')
  await run.s.tap('Cancel')
}

const SECTIONS = [
  'all-sheets',
  'settings',
  'defensive',
  'behavior',
  'extended',
  'picker',
  'forms',
  'placeholder',
  'basic',
  'player',
  'additional',
  'advanced',
  'error',
  'override-numbers',
  'preview'
]

export default defineHarness({
  id: 'scoring/modals/sheets',
  title:
    'The scoring sheets open, validate, save, cancel and undo as a scorekeeper uses them',
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringScreen.tsx',
    'src/app/scoring/ScoringSheet.tsx',
    'src/app/scoring/PlayerEntrySheet.tsx',
    'src/app/scoring/PlaceholderPlayersSheet.tsx',
    'src/app/scoring/TiebreakerSheets.tsx',
    'src/app/scoring/ErrorCreditSheet.tsx',
    'src/app/scoring/OverridesEditor.tsx',
    'src/app/scoring/runnerDrag.ts',
    'src/common/scoring/session.ts',
    'src/app/field/**'
  ],
  stack: 'isolated',
  fixtures: [WORLD],
  exclusive: false,
  surfaces: {
    // The scoring screen draws the field in 3D: a GPU, so a physical iPhone.
    'web-safari-ios': {
      devices: [
        { role: SCORER_ROLE, needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    },
    'ios-app': {
      devices: [
        { role: SCORER_ROLE, needs: ['ios-phone', 'gpu'], simulator: 'never' }
      ]
    }
  },
  services: [],
  apps: ['teamstation-ios'],
  secrets: [],
  costUsd: 0,
  minutes: 20,
  guards: [],
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: Object.fromEntries(
    SECTIONS.map(name => [name, section(name === 'all-sheets' ? 'all' : name)])
  )
})
