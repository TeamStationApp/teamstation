import { strict as assert } from 'node:assert'

import { defineHarness, type HarnessScenario } from '../../../core/spec'
import {
  holdRequests,
  pause,
  SCORER_ROLE,
  textOf,
  until
} from '../../../rigs/scoring/scorerSheets'
import { begin, open, type Sheets } from '../modals/sheets.e2e'

/**
 * The scoring screen's polish, on Safari on an iPhone and in the develop app
 * on one: the roster's hold-and-drag, remove and tap-to-add, and a cancelled
 * draft; every sheet drawn in portrait with each position and setting
 * toggled; the tiebreaker's runner placed and the outs set and dragged, each
 * step undone and kept across a reopen, and the tiebreaker held back once a
 * pitch is thrown; and a long hold on Undo opening the tag editor. What the
 * screen saved is replayed from the book the stack's API keeps.
 */

/** The book's state, replayed as the screen replays it. */
async function stateOf(run: Sheets, setup: { value?: any }): Promise<any> {
  const { recordOf, replayPlays } =
    await import('../../../../src/common/scoring/gumbo')
  const book = await run.book(run.game)
  const teams = {
    away: { id: run.world.ids.readyAwayTeam },
    home: { id: run.world.ids.readyHomeTeam }
  }
  setup.value ??= recordOf(
    book.currentPlay ?? book.plays[0],
    teams
  )?.setupBefore
  if (setup.value == null) return undefined
  const result = replayPlays(book, {
    gamePk: run.game,
    teams: {
      away: { ...teams.away, name: 'Owls' },
      home: { ...teams.home, name: 'Hawks' }
    },
    setup: setup.value
  })
  assert.deepEqual(result.problems, [])
  return result.state
}

/** Waits until the saved state satisfies `check`. */
async function saved(
  run: Sheets,
  setup: { value?: any },
  check: (state: any) => boolean
): Promise<any> {
  try {
    return await until(
      async () => await stateOf(run, setup),
      state => state != null && check(state),
      'the persisted scoring state',
      15000
    )
  } catch (error) {
    const state = await stateOf(run, setup)
    const line = state?.liveData.linescore
    throw new Error(
      `${String(error)}: ${JSON.stringify({
        inning: line?.currentInning,
        top: line?.isTopInning,
        balls: line?.balls,
        strikes: line?.strikes,
        outs: line?.outs,
        completedPlays: state?.liveData.plays.allPlays.filter(
          (play: any) => play.about.isComplete
        ).length
      })}`
    )
  }
}

/** A pitch control, once the app has enabled it. */
async function pitch(run: Sheets, label: string): Promise<void> {
  if (run.s.native)
    await until(
      async () => await run.s.nodes(),
      nodes =>
        nodes.some(
          node =>
            textOf(node) === label &&
            node.type === 'Button' &&
            node.enabled !== false
        ),
      `${label} to be enabled`,
      15000
    )
  await run.s.tap(label)
}

/** More's menu, once its transition has settled. */
async function more(run: Sheets): Promise<void> {
  const end = Date.now() + 60000
  while (!(await run.s.texts()).includes('Dismiss More')) {
    assert(Date.now() < end, "More's menu opens once its transition settles")
    await run.s.tap('More')
    await pause()
  }
}

async function undo(run: Sheets): Promise<void> {
  const label = (await run.s.texts()).find(text => text.startsWith('Undo '))
  assert(label != null, 'Undo is offered')
  await run.s.tap(label)
}

/** The tiebreaker's row, shown but refusing a press once a pitch is in. */
async function disabledTiebreaker(run: Sheets): Promise<void> {
  const { s } = run
  await s.shown('More scoring actions')
  const target = (await s.nodes()).find(
    node =>
      textOf(node) === 'Place a Runner (Tiebreaker)' && node.bounds != null
  )?.bounds
  assert(target != null, 'The disabled tiebreaker row stays visible')
  const before = JSON.stringify(await run.book(run.game))
  // A disabled row is text, not a button.
  await s.point(target.x + target.width / 2, target.y + target.height / 2)
  await s.shown('More scoring actions')
  assert.equal(JSON.stringify(await run.book(run.game)), before)
  await s.tap('Dismiss More')
}

async function lineupOrder(run: Sheets): Promise<string[]> {
  return [
    ...new Set(
      (await run.s.texts()).filter(text => text.startsWith('Reorder '))
    )
  ]
}

async function rosterInteractions(run: Sheets): Promise<void> {
  const { s } = run
  await open(run)
  await s.menu('Set Team Rosters')
  assert.deepEqual((await lineupOrder(run)).slice(0, 2), [
    'Reorder Mookie Betts',
    'Reorder Mike Trout'
  ])
  const nodes = await s.nodes()
  const from = nodes.find(node => textOf(node) === 'Drag Mike Trout')?.bounds
  const to = nodes.find(node => textOf(node) === 'Reorder Mookie Betts')?.bounds
  assert(from != null && to != null)
  await s.m.dragAndDrop({
    from: {
      point: `${Math.round(from.x + from.width / 2)},${Math.round(from.y + from.height / 2)}`
    },
    to: { point: `${Math.round(to.x + to.width / 2)},${Math.round(to.y + 6)}` },
    holdDuration: 700,
    duration: 1000
  })
  assert.deepEqual((await lineupOrder(run)).slice(0, 2), [
    'Reorder Mike Trout',
    'Reorder Mookie Betts'
  ])
  await s.tap('Remove Mike Trout')
  await s.shown('Add Mike Trout to Lineup')
  await s.tap('Add Mike Trout to Lineup')
  assert.equal((await lineupOrder(run)).at(-1), 'Reorder Mike Trout')
  await s.tap('Cancel')
  await s.menu('Set Team Rosters')
  assert.deepEqual((await lineupOrder(run)).slice(0, 2), [
    'Reorder Mookie Betts',
    'Reorder Mike Trout'
  ])
  await s.tap('Cancel')
}

async function overrideAppearance(run: Sheets): Promise<void> {
  const { s } = run
  await s.menu('Overrides')
  await s.reach('Batter', { foot: 110 })
  await s.tap('Batter')
  await s.capture('overrides-choice')
  await s.tap('Cancel')
  await open(run, true)
  await s.tap('Assign P')
  await s.shown('Assign pitcher')
  await s.capture('defensive')
  await s.tap('Cancel')
}

async function appearance(run: Sheets): Promise<void> {
  const { s } = run
  await open(run)
  await s.menu('Set Team Rosters')
  await s.shown('Roster')
  await s.capture('roster')
  await s.tap('Defense')
  await s.capture('roster-defense')
  await s.tap('Lineup')
  await s.tap('Create Player')
  await s.finishKeyboard()
  await s.capture('player')
  for (const position of [
    'LF',
    'CF',
    'RF',
    '3B',
    'SS',
    '2B',
    '1B',
    'P',
    'C',
    'DH',
    'EH'
  ])
    await s.tap('Player position ' + position)
  await s.reach('Create Placeholder Player', { foot: 110 })
  await s.tap('Create Placeholder Player')
  await s.shown('Select number of players to create')
  await s.capture('placeholder')
  await s.tap('Cancel')
  await s.input('First Name', 'Jose')
  await s.m.pressKey('Enter')
  await s.input('Last Name', 'Ramirez')
  await s.m.pressKey('Enter')
  await s.input('Jersey Number', '11')
  await s.finishKeyboard()
  await s.reach('Create Player', { foot: 110 })
  await s.tap('Create Player')
  await s.shown('Jose Ramirez')
  await s.tap('Create Player')
  await s.finishKeyboard()
  await s.reach('Create Placeholder Player', { foot: 110 })
  await s.tap('Create Placeholder Player')
  await s.shown('Select number of players to create')
  await s.tap('Create')
  await s.shown('Save Rosters')
  await s.tap('Cancel')
  for (const [label, key] of [
    ['End Half Inning', 'half'],
    ['End Game', 'game']
  ]) {
    await s.menu(label)
    await s.capture(key)
    await s.tap('Cancel')
  }
  await s.menu('Settings')
  await s.shown('Scoring sound')
  await s.capture('settings')
  for (const label of [
    'Toggle scoring sound',
    'Toggle play animations',
    'Toggle switch-hitter help'
  ]) {
    await s.tap(label)
    await s.tap(label)
  }
  await s.reach('Done', { foot: 100 })
  await s.tap('Done')
  await overrideAppearance(run)
}

async function workflow(run: Sheets, basesOnly: boolean): Promise<void> {
  const { s } = run
  const setup: { value?: any } = {}
  const { baseIds } = await import('../../../../src/common/scoring/rules')
  const { storedRecordOf } =
    await import('../../../../src/common/scoring/gumbo')
  await open(run)
  const game = run.game
  const inspectSetupHistory = async (
    label: string,
    screenshot?: string
  ): Promise<void> => {
    await s.tap('Cancel')
    await s.shown(label)
    // Undo's accessible label stands in for its nested text in the device's
    // tree: the rendered control is kept for a person to read.
    if (screenshot != null) await s.capture(screenshot)
    await more(run)
    await s.tap('Place a Runner (Tiebreaker)')
    await s.shown('Place runner on base')
  }
  await more(run)
  await s.tap('Place a Runner (Tiebreaker)')
  await s.shown('Place runner on base')
  await s.capture('tiebreaker')
  await s.tap('Place runner on base')
  await s.shown('Place runner on 2B')
  await s.capture('bases')
  const bases = (await s.texts()).filter(text =>
    /^Place runner on [123]B$/.test(text)
  )
  assert.equal(new Set(bases).size, 3)
  if (basesOnly) {
    await s.tap('Cancel runner placement')
    await s.shown('Juan Soto')
    return
  }
  await s.tap('Place runner on 2B')
  await s.shown('Select Runner for 2B')
  await s.shown('Recently Batted Players')
  await s.capture('runner')
  const labels = (await s.texts()).filter(text =>
    text.startsWith('Select runner #')
  )
  assert.deepEqual(
    [...new Set(labels)],
    [
      'Select runner #9 Bobby Witt',
      'Select runner #8 Juan Soto',
      'Select runner #7 Francisco Lindor',
      'Select runner #6 Freddie Freeman',
      'Select runner #5 Bryce Harper',
      'Select runner #4 Aaron Judge',
      'Select runner #3 Shohei Ohtani',
      'Select runner #2 Mike Trout'
    ]
  )
  await s.tap('Select runner #9 Bobby Witt')
  await s.shown('Place runner on base')
  await saved(
    run,
    setup,
    state => baseIds(state).filter(id => id != null).length === 1
  )
  await inspectSetupHistory('Undo Place Bobby Witt on 2B', 'history-placement')
  const first = baseIds(await stateOf(run, setup))[1]
  assert(first != null)
  const unchanged = await stateOf(run, setup)
  await s.tap('Set Outs 1')
  await saved(run, setup, state => state.liveData.linescore.outs === 1)
  await inspectSetupHistory('Undo Set Outs')
  const actionsNow = async (): Promise<number> =>
    storedRecordOf((await run.book(game)).currentPlay)!.actions.length
  const beforeActions = await actionsNow()
  const nodes = await s.nodes()
  const from = nodes
    .filter(node => textOf(node) === 'Set Outs 1')
    .at(-1)?.bounds
  const to = nodes.filter(node => textOf(node) === 'Set Outs 2').at(-1)?.bounds
  assert(from != null && to != null)
  await s.m.dragAndDrop({
    from: {
      point: `${Math.round(from.x + from.width / 2)},${Math.round(from.y + from.height / 2)}`
    },
    to: {
      point: `${Math.round(to.x + to.width / 2)},${Math.round(to.y + to.height / 2)}`
    },
    holdDuration: 100,
    duration: 800
  })
  await saved(run, setup, state => state.liveData.linescore.outs === 2)
  await inspectSetupHistory('Undo Set Outs', 'history-outs')
  assert.equal(
    await actionsNow(),
    beforeActions + 1,
    'The outs drag commits once'
  )
  const now = await stateOf(run, setup)
  assert.deepEqual(now.liveData.boxscore, unchanged.liveData.boxscore)
  assert.deepEqual(baseIds(now), [null, first, null])
  await s.tap('Place runner on base')
  await s.tap('Place runner on 2B')
  await s.shown('Cancel runner placement')
  await s.tap('Place runner on 3B')
  await s.shown('Select Runner for 3B')
  await s.tap('Cancel')
  await s.shown('Place runner on 1B')
  await s.tap('Place runner on 3B')
  await s.tap('Select runner #8 Juan Soto')
  await s.shown('Place runner on base')
  await s.tap('Cancel')
  await saved(
    run,
    setup,
    state => baseIds(state).filter(id => id != null).length === 2
  )
  assert(baseIds(await stateOf(run, setup))[2] != null)
  const persisted = JSON.stringify(await run.book(game))
  await open(run, false, game)
  await s.shown('^Bobby W$')
  await s.shown('^Juan S$')
  if (s.native) await pause(3000)
  await s.capture('history-reopened')
  await more(run)
  await s.tap('Place a Runner (Tiebreaker)')
  await s.shown('Set Outs 2')
  await s.tap('Cancel')
  assert.equal(
    JSON.stringify(await run.book(game)),
    persisted,
    'Reopening keeps the saved setup'
  )
  for (const [outs, expected] of [
    [2, [null, first, null]],
    [1, [null, first, null]],
    [0, [null, first, null]],
    [0, [null, null, null]]
  ] as const) {
    await undo(run)
    await saved(
      run,
      setup,
      state =>
        state.liveData.linescore.outs === outs &&
        JSON.stringify(baseIds(state)) === JSON.stringify(expected)
    )
    if (outs === 2) await s.capture('history-undo')
  }
  await pitch(run, 'Ball')
  await saved(run, setup, state => state.liveData.linescore.balls === 1)
  await more(run)
  await disabledTiebreaker(run)
  await undo(run)
  await saved(run, setup, state => state.liveData.linescore.balls === 0)
  await more(run)
  await s.tap('Place a Runner (Tiebreaker)')
  await s.shown('Place runner on base')
  await s.tap('Cancel')
  for (let strike = 1; strike <= 3; strike++) {
    await pitch(run, 'Called Strike')
    await saved(run, setup, state =>
      strike < 3
        ? state.liveData.linescore.strikes === strike
        : state.liveData.plays.allPlays.some(
            (play: any) => play.about.isComplete === true
          )
    )
  }
  await s.menu('End Half Inning')
  await s.tap('Confirm End Half Inning')
  await saved(
    run,
    setup,
    state => state.liveData.linescore.isTopInning === false
  )
  if (s.native) await open(run, false, game)
  await more(run)
  await disabledTiebreaker(run)
  await s.menu('End Half Inning')
  await s.tap('Confirm End Half Inning')
  await saved(
    run,
    setup,
    state =>
      state.liveData.linescore.isTopInning === true &&
      state.liveData.linescore.currentInning === 2
  )
  if (s.native) await open(run, false, game)
  await more(run)
  await s.tap('Place a Runner (Tiebreaker)')
  await s.shown('Place runner on base')
  await s.tap('Place runner on base')
  await s.tap('Place runner on 1B')
  await s.shown('Select Runner for 1B')
  const recent = [
    ...new Set(
      (await s.texts()).filter(text => text.startsWith('Select runner #'))
    )
  ]
  assert.equal(recent[0], 'Select runner #1 Mookie Betts')
  assert(!recent.includes('Select runner #2 Mike Trout'))
  await s.tap('Cancel')
  await s.tap('Cancel runner placement')
}

async function tagsAndExit(run: Sheets): Promise<void> {
  const { s, ctx } = run
  await open(run)
  // The pitch stays unsent while the stack holds the game's saves.
  await holdRequests(ctx, `/api/v1/games/${run.game}/events`)
  try {
    await pitch(run, 'Ball')
    await s.shown('Undo Ball')
    const target = (await s.nodes())
      .filter(node => textOf(node)?.startsWith('Undo Ball') === true)
      .at(-1)?.bounds
    assert(target != null)
    await s.m.tapOnPoint({
      x: Math.round(target.x + target.width / 2),
      y: Math.round(target.y + target.height / 2),
      longPress: true,
      duration: s.native ? 2200 : 650
    })
    await s.shown('Tap event to assign a tag')
    await s.tap('Tag event: Ball')
    await s.shown('New tag')
    await s.capture('tag-editor')
    await s.tap('Cancel')
    await s.menu('Exit Current Game')
    await s.shown('Discard and Exit')
    await s.capture('exit')
    await s.tap('Cancel')
  } finally {
    await holdRequests(ctx, null)
  }
}

function section(name: string): HarnessScenario {
  return async ctx => {
    const run = await begin(ctx)
    const all = name === 'all'
    if (all || name === 'roster') await rosterInteractions(run)
    if (name === 'appearance-overrides') {
      await open(run)
      await overrideAppearance(run)
    }
    if (all || name === 'appearance') await appearance(run)
    if (all || name === 'workflow' || name === 'bases')
      await workflow(run, name === 'bases')
    if (all || name === 'appearance' || name === 'tags') await tagsAndExit(run)
  }
}

const SECTIONS = [
  'all',
  'roster',
  'appearance',
  'appearance-overrides',
  'workflow',
  'bases',
  'tags'
]

export default defineHarness({
  id: 'scoring/sheet-flows/roster-tiebreaker-tags',
  title:
    "The scoring screen's roster, sheets, tiebreaker and history behave and keep what they save",
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringScreen.tsx',
    'src/app/scoring/TiebreakerSheets.tsx',
    'src/app/scoring/PlayerEntrySheet.tsx',
    'src/app/scoring/scoringRosterEdit.ts',
    'src/common/scoring/rules.ts',
    'src/common/scoring/gumbo.ts'
  ],
  stack: 'isolated',
  fixtures: ['scoring-sheets'],
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
  scenarios: Object.fromEntries(SECTIONS.map(name => [name, section(name)]))
})
