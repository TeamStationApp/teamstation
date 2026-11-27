import { strict as assert } from 'node:assert'
import { writeFileSync } from 'node:fs'

import type { FixtureManifest } from '../../../core/fixtures'
import { BlockedError } from '../../../core/result'
import {
  defineHarness,
  type HarnessContext,
  type HarnessScenario
} from '../../../core/spec'
import { stackSql } from '../../../rigs/coach/coachApp'
import {
  type Book,
  bookReader,
  flat,
  holdRequests,
  listOf,
  literal,
  type Node,
  openScorer,
  pause,
  type Scorer,
  SCORER_ROLE,
  textOf,
  until
} from '../../../rigs/scoring/scorerSheets'

/**
 * The scorekeeper's roster editor on the scoring screen, on Safari on an
 * iPhone and in the develop app on one: the lineup and its drag, Defense,
 * the team's roster and each player's settings (jersey, positions, names),
 * a save the server refuses or holds, a roster that fails to refresh or
 * comes back empty, a scorekeeper whose role is taken away, and the
 * game-only players the editor makes. What the editor saved is read back
 * from the stack's database and API, and the scored pitch must survive
 * every visit.
 */

const WORLD = 'roster-edit'

export interface Roster {
  ctx: HarnessContext
  s: Scorer
  world: FixtureManifest
  game: string
  teams: { away: string; home: string }
  users: { away: string[]; home: string[] }
  gumbos: { away: number[]; home: number[] }
  book: () => Promise<Book>
}

/** The scenario's own roster-edit world and its scorer, signed in. */
export async function beginRoster(ctx: HarnessContext): Promise<Roster> {
  const world = await ctx.fixture(WORLD)
  const s = await openScorer(ctx)
  const read = bookReader(ctx, world.accounts.scorer)
  const game = world.ids.game
  return {
    ctx,
    s,
    world,
    game,
    teams: { away: world.ids.rosterAwayTeam, home: world.ids.rosterHomeTeam },
    users: {
      away: listOf(world.ids, 'rosterAwayUsers'),
      home: listOf(world.ids, 'rosterHomeUsers')
    },
    gumbos: {
      away: listOf(world.ids, 'rosterAwayGumbos').map(Number),
      home: listOf(world.ids, 'rosterHomeGumbos').map(Number)
    },
    book: async () => await read(game)
  }
}

/** Every play of the book, the open at-bat last. */
export function playsOf(book: Book): any[] {
  return [
    ...book.plays,
    ...(book.currentPlay == null ? [] : [book.currentPlay])
  ]
}

async function hasPitch(run: Roster): Promise<boolean> {
  const { storedRecordOf } =
    await import('../../../../src/common/scoring/gumbo')
  return playsOf(await run.book()).some(
    play =>
      storedRecordOf(play)?.actions.some(action => action.type === 'pitch') ===
      true
  )
}

/** A player's names and jersey on a team, as the server keeps them. */
async function stored(
  run: Roster,
  side: 'away' | 'home',
  index: number
): Promise<{ first: string; last: string; jersey: string | null }> {
  const { rows } = await stackSql(
    run.ctx,
    'select u.first_name as first, u.last_name as last, m.jersey from users u join memberships m on m.user_id = u.id where u.id = $1 and m.team_id = $2',
    [run.users[side][index], run.teams[side]]
  )
  assert.equal(rows.length, 1, 'The player is on the team once')
  return rows[0] as { first: string; last: string; jersey: string | null }
}

async function shown(run: Roster, label: string): Promise<void> {
  await run.s.shown(literal(label))
}

/** A player's row on the roster, once the roster has loaded and he is clear. */
async function tapPlayer(run: Roster, label: string): Promise<void> {
  const loading = async (): Promise<boolean> =>
    (await run.s.nodes()).some(
      node =>
        textOf(node) === 'Loading team roster' ||
        node.id === 'Loading team roster'
    )
  await until(loading, busy => !busy, 'the roster to finish loading', 30000)
  await run.s.m.waitForAnimationToEnd({ timeout: 3000 })
  await run.s.reach(label)
  await run.s.tap(label)
}

/** Types into a settings field, then puts the keyboard away. */
async function input(run: Roster, label: string, value: string): Promise<void> {
  const { s } = run
  await s.tap(label)
  await s.m.eraseText({ characters: 200 })
  if (value !== '') await s.m.inputText({ text: value })
  if (s.native) await s.m.hideKeyboard()
  else await s.m.tapOn({ text: '^Done$', timeout: 10000 })
}

/** Safari's own Back or Forward. */
async function browserStep(
  run: Roster,
  direction: 'Back' | 'Forward'
): Promise<void> {
  const target = flat((await run.s.m.hierarchy()) as Node).find(
    node => node.id === direction + 'Button'
  )?.bounds
  assert(target != null, `Safari's ${direction} is there`)
  await run.s.point(target.x + target.width / 2, target.y + target.height / 2)
}

async function keyboardAway(run: Roster): Promise<void> {
  const { s } = run
  if (!s.native) {
    await s.m.tapOn({ text: '^Done$', timeout: 10000 })
    return
  }
  await s.m.hideKeyboard()
  for (
    let count = 0;
    count < 3 && (await s.nodes()).some(node => node.type === 'Keyboard');
    count++
  )
    await s.m.pressKey('Enter')
}

/** The open game's scoring screen and its Set Team Rosters. */
async function openRosters(run: Roster): Promise<void> {
  const { s } = run
  await s.open(`games/${run.game}/score`)
  await s.shown('Open scoring menu', 60000)
  await pause(1500)
}

async function menuRosters(run: Roster): Promise<void> {
  const { s } = run
  for (let attempt = 0; attempt < 6; attempt++) {
    if ((await s.find('Set Team Rosters')) != null) break
    await s.tap('Open scoring menu')
  }
  await s.tap('Set Team Rosters')
}

/** One pitch scored and saved: what every later visit must leave alone. */
async function scoreOnePitch(run: Roster): Promise<void> {
  const { s } = run
  const end = Date.now() + 45000
  const accepted = async (): Promise<boolean> =>
    (await s.texts()).some(text => text.startsWith('Undo Ball'))
  while (!(await hasPitch(run)) && Date.now() < end)
    if (await accepted()) await pause()
    else {
      await s.tap('Ball')
      // An accepted pitch may wait for its debounced save: only a warm-start
      // tap that was ignored is tried again.
      const persisted = Date.now() + 5000
      while (
        !(await hasPitch(run)) &&
        !(await accepted()) &&
        Date.now() < persisted
      )
        await pause()
    }
  assert(await hasPitch(run), 'A scored pitch is required for continuity')
  const { storedRecordOf } =
    await import('../../../../src/common/scoring/gumbo')
  const pitches = playsOf(await run.book()).flatMap(play =>
    (storedRecordOf(play)?.actions ?? []).filter(
      action => action.type === 'pitch'
    )
  )
  assert.equal(pitches.length, 1, 'Continuity starts with exactly one pitch')
}

/** The last roster setup the book holds. */
async function latestSetup(run: Roster): Promise<any> {
  const { recordOf } = await import('../../../../src/common/scoring/gumbo')
  const actions = playsOf(await run.book()).flatMap(
    play =>
      recordOf(play, {
        away: { id: run.teams.away },
        home: { id: run.teams.home }
      })?.actions ?? []
  )
  const action = actions
    .filter(
      (action: any) => action.type === 'lineup' && action.kind === 'roster'
    )
    .at(-1) as any
  assert(action?.setup != null, 'The book holds a roster setup')
  return action.setup
}

/** Names: a persisted player's names, validated, refused, then saved. */
async function names(run: Roster, persistedOnly: boolean): Promise<void> {
  const { s, ctx } = run
  await s.tap('Roster')
  await tapPlayer(run, 'Mookie Betts')
  await shown(run, 'FIRST NAME')
  await input(run, 'First name', '')
  await input(run, 'Last name', '')
  await input(run, 'Jersey number', '14')
  await s.reach('Save')
  await s.tap('Save')
  await shown(run, 'Enter a player name.')
  for (let count = 0; count < 2; count++)
    await s.m.swipe({ start: '65%,35%', end: '65%,75%', duration: 400 })
  await input(run, 'First name', 'Paul')
  await input(run, 'Last name', 'Goldschmidt')
  // The server refuses the save.
  const setFault = ctx.stack.setFault
  if (setFault == null)
    throw new BlockedError('needs a stack whose fault server can be set')
  await s.reach('Save')
  await setFault('api-500')
  try {
    await s.tap('Save')
    await shown(run, 'The server answered 500')
    await s.capture('names-error')
  } finally {
    await setFault(null)
  }
  await s.tap('Save')
  await shown(run, 'Saved.')
  await until(
    async () => await stored(run, 'away', 0),
    row =>
      row.first === 'Paul' && row.last === 'Goldschmidt' && row.jersey === '14',
    'the names and jersey saved on the server'
  )
  for (let count = 0; count < 2; count++)
    await s.m.swipe({ start: '65%,35%', end: '65%,75%', duration: 400 })
  await shown(run, 'Paul Goldschmidt')
  await s.capture('names-settings')
  await s.tap('Back')
  await shown(run, 'Paul Goldschmidt')
  await s.reach('Paul Goldschmidt')
  await s.capture('names-roster')
  assert(
    await hasPitch(run),
    'Editing a persisted name must preserve the scored pitch'
  )
  if (persistedOnly) return

  await s.tap('Create Player')
  await input(run, 'First Name', 'Jose')
  await input(run, 'Last Name', 'Ramirez')
  await input(run, 'Jersey Number', '11')
  await s.reach('Create Player')
  await s.tap('Create Player')
  await shown(run, 'Jose Ramirez')
  await s.reach('Jose Ramirez')
  await s.capture('local-card')
  await s.tap('Save Rosters')
  const hasJose = async (): Promise<boolean> => {
    try {
      return Object.values((await latestSetup(run)).players).some(
        (player: any) => player.fullName === 'Jose Ramirez'
      )
    } catch {
      return false
    }
  }
  await until(
    hasJose,
    found => found,
    'creation to persist the game-only identity',
    30000
  )
  const before = await latestSetup(run)
  const original = Object.values(before.players).find(
    (player: any) => player.fullName === 'Jose Ramirez'
  ) as any
  assert(original.local === true)
  assert.deepEqual(before.players[original.id], original)
  assert(
    before.sides.away.players.includes(original.id) === true ||
      before.sides.home.players.includes(original.id) === true,
    'The saved guest belongs to a game roster under its scoring identity'
  )
  const reopen = async (): Promise<void> => {
    await s.shown('Open scoring menu')
    await s.tap('Open scoring menu')
    await s.tap('Set Team Rosters')
    await s.tap('Roster')
  }
  await reopen()
  await tapPlayer(run, 'Jose Ramirez')
  await shown(run, 'Edit Player')
  await input(run, 'Last Name', 'Altuve')
  await s.tap('Cancel')
  await shown(run, 'Jose Ramirez')
  assert(
    !(await s.texts()).some(text => text.startsWith('Jose Altuve,')),
    'Cancel keeps the name'
  )
  await tapPlayer(run, 'Jose Ramirez')
  await input(run, 'Last Name', 'Altuve')
  await input(run, 'Jersey Number', '00')
  await s.tap('Throws L')
  await s.tap('Bats S')
  await s.tap('Player position DH')
  await s.capture('names-local')
  await s.reach('Save Player')
  await s.tap('Save Player')
  await shown(run, 'Jose Altuve')
  await s.tap('Save Rosters')
  await until(
    async () => await latestSetup(run),
    setup => setup.players[original.id]?.fullName === 'Jose Altuve',
    'the same game-only player to keep his corrected name',
    30000
  )
  const after = await latestSetup(run)
  assert.deepEqual(after.sides, before.sides)
  assert.deepEqual(after.tagOrder, before.tagOrder)
  assert.equal(after.players[original.id].id, original.id)
  assert.equal(after.players[original.id].jersey, '00')
  assert.equal(after.players[original.id].throws, 'left')
  assert.equal(after.players[original.id].bats, 'switch')
  assert(after.players[original.id].positions.includes('DH') === true)
  assert(
    await hasPitch(run),
    'Local-player editing must retain the scored pitch'
  )
  await reopen()
  await shown(run, 'Jose Altuve')
  await tapPlayer(run, 'Jose Altuve')
  await shown(run, 'Edit Player')
  writeFileSync(
    ctx.artifact(`${s.surface}-names-report.json`),
    JSON.stringify(
      {
        id: original.id,
        player: after.players[original.id],
        retainedPitch: await hasPitch(run),
        assignmentsUnchanged: true
      },
      null,
      2
    )
  )
}

/** Mookie Betts's settings beside each team, saved, held, refused and revoked. */
async function settings(run: Roster, all: boolean): Promise<void> {
  const { s, ctx } = run
  const setFault = ctx.stack.setFault
  if (setFault == null)
    throw new BlockedError('needs a stack whose fault server can be set')
  const bookBefore = JSON.stringify(await run.book())
  await tapPlayer(run, 'Mookie Betts')
  await shown(run, 'JERSEY NUMBER')
  await shown(run, 'Mookie Betts')
  await s.capture('player-settings-after')
  await input(run, 'Jersey number', '12')
  await s.tap('P')
  await s.tap('SS')
  // Settings beside a team edits the jersey and positions; how a player bats
  // and throws is edited away from a team.
  await s.reach('Save')
  await s.tap('Save')
  await until(
    async () => await stored(run, 'away', 0),
    row => row.jersey === '12',
    "the away team's jersey 12 saved"
  )
  await s.tap('Back')
  await shown(run, 'Tap player to edit.')
  await shown(run, 'Mookie Betts, jersey 12, bats right, throws right')
  assert.equal(
    JSON.stringify(await run.book()),
    bookBefore,
    'Settings typing and saves must not change scoring events'
  )
  await s.reach('Mookie Betts')
  await s.capture('roster-return')
  if (s.native && all) {
    await tapPlayer(run, 'Mookie Betts')
    await shown(run, 'JERSEY NUMBER')
    await s.tap('Stats')
    await s.tap('Back')
    await shown(run, 'Tap player to edit.')
  }
  if (all) {
    // Forward can reopen the child; its own tabs remain part of the visit.
    if (!s.native) {
      await browserStep(run, 'Forward')
      await shown(run, 'JERSEY NUMBER')
      await browserStep(run, 'Back')
      await shown(run, 'Tap player to edit.')
      await browserStep(run, 'Forward')
      await shown(run, 'JERSEY NUMBER')
      await s.tap('Stats')
      await s.tap('Back')
      await shown(run, 'Tap player to edit.')
    }
    await s.tap('Home Team')
    await shown(run, 'Mookie Betts, jersey 1, bats right, throws right')
    await s.tapStarts('Mookie Betts, jersey 1, bats right, throws right,')
    await shown(run, 'JERSEY NUMBER')
    await input(run, 'Jersey number', '0')
    await s.reach('Save')
    await s.tap('Save')
    await until(
      async () => await stored(run, 'home', 0),
      row => row.jersey === '0',
      "the home team's jersey 0 saved"
    )
    await s.tap('Back')
    await shown(run, 'Mookie Betts, jersey 0')
    await s.tap('Away Team')
    await s.reach('Mookie Betts')
  }
  // A save the server holds: Back returns to the roster at once, and the
  // roster shows the jersey once the save lands.
  await tapPlayer(run, 'Mookie Betts')
  await shown(run, 'JERSEY NUMBER')
  await input(run, 'Jersey number', '14')
  const settingsPath = `/api/v1/teams/${run.teams.away}/players/${run.users.away[0]}/settings`
  await holdRequests(ctx, settingsPath, 8000)
  try {
    await s.reach('Save')
    await s.tap('Save')
    assert.equal(
      (await stored(run, 'away', 0)).jersey,
      '12',
      'The held save has not reached the server'
    )
    await s.tap('Back')
    await shown(run, 'Tap player to edit.')
  } finally {
    await holdRequests(ctx, null)
  }
  await s.shown(literal('Mookie Betts, jersey 14'), 45000)
  await s.reach('Mookie Betts')
  // A refused save stays on the form; Back keeps the draft, and a roster
  // that cannot refresh says so until it is retried.
  await tapPlayer(run, 'Mookie Betts')
  await shown(run, 'JERSEY NUMBER')
  await input(run, 'Jersey number', '13')
  await s.reach('Save')
  await setFault('api-500')
  try {
    await s.tap('Save')
    await shown(run, 'The server answered 500')
    await s.capture('settings-save-error')
    await s.tap('Back')
    await shown(run, 'Unable to refresh the roster.')
    await s.capture('roster-refresh-error')
  } finally {
    await setFault(null)
  }
  await s.tap('Retry loading roster')
  await shown(run, 'Mookie Betts, jersey 14')
  if (all) {
    await until(
      async () =>
        (await s.nodes()).some(
          node =>
            textOf(node) === 'Loading team roster' ||
            node.id === 'Loading team roster'
        ),
      busy => !busy,
      'the roster refresh to finish before the draft is saved'
    )
    await s.tap('Lineup')
    assert(
      !(await s.texts()).includes('Remove Aaron Judge'),
      'The staged lineup survives every player visit'
    )
    await s.tap('Save Rosters')
    await until(
      async () => await s.nodes(),
      nodes =>
        !nodes.some(
          node => textOf(node) === 'Save Rosters' || node.id === 'Save Rosters'
        ) && nodes.some(node => textOf(node)?.startsWith('Undo ') === true),
      'the roster sheet to close before Undo'
    )
    await s.tapStarts('Undo ')
    await s.tapStarts('Undo ')
    await shown(run, 'Nothing to undo')
    await until(
      async () => await hasPitch(run),
      pitched => !pitched,
      'Undo to clear the pitch after undoing the roster change',
      15000
    )
    await s.tap('Open scoring menu')
    await s.tap('Set Team Rosters')
    await s.tap('Roster')
  }
  // The scorekeeper's role taken away: settings and the full name go.
  await s.reach('Mookie Betts')
  await stackSql(ctx, 'delete from scope_roles where user_id = $1', [
    run.world.accounts.scorer.userId
  ])
  await tapPlayer(run, 'Mookie Betts')
  await shown(run, 'Videos')
  await until(
    async () => await s.nodes(),
    nodes =>
      !nodes.some(
        node =>
          textOf(node) === 'Settings' ||
          node.id === 'Settings' ||
          textOf(node)?.includes('JERSEY NUMBER') === true ||
          node.id === 'JERSEY NUMBER' ||
          textOf(node)?.includes('Mookie Betts') === true
      ),
    'revoked Settings and private full name to be gone',
    30000
  )
  await s.tap('Back')
  await shown(run, 'Player settings are unavailable for this team.')
  assert(
    !(await s.texts()).some(text => text.includes('Mookie Betts')),
    'Revoked full names are removed'
  )
  await s.capture('permission-revoked')
  const { makeId } = await import('../../../../src/common/ids')
  for (const team of [run.teams.away, run.teams.home])
    await stackSql(
      ctx,
      "insert into scope_roles (id, user_id, scope_type, scope_id, role, granted_at) values ($1, $2, 'team', $3, 'scorekeeper', now())",
      [makeId('scopeRole'), run.world.accounts.scorer.userId, team]
    )
  await s.tap('Cancel')
  await s.tap('Open scoring menu')
  await s.tap('Set Team Rosters')
  await s.tap('Roster')
  await shown(run, 'Mookie Betts, jersey 14')
  await tapPlayer(run, 'Mookie Betts')
  await shown(run, 'JERSEY NUMBER')
  // The team's roster set aside: it comes back with nobody on it.
  await stackSql(
    ctx,
    'update memberships set team_id = $1 where team_id = $2',
    [run.world.ids.spareTeam, run.teams.away]
  )
  try {
    await s.tap('Back')
    await shown(run, 'No players on this team.')
    await s.capture('roster-empty')
  } finally {
    await stackSql(
      ctx,
      'update memberships set team_id = $1 where team_id = $2',
      [run.teams.away, run.world.ids.spareTeam]
    )
  }
}

/**
 * The lineup's drag, Defense's clear and drop, the placeholder picker, a
 * game-only player, the history's tags and an exit with a save unsent.
 */
async function regressions(run: Roster): Promise<void> {
  const { s, ctx } = run
  // Earlier Settings visits can move this player below the first viewport;
  // a standalone run gets the same ordering, so it scrolls too.
  await stackSql(
    ctx,
    "update memberships set jersey = '14' where user_id = $1 and team_id = $2",
    [run.users.away[0], run.teams.away]
  )
  await openRosters(run)
  await s.tap('Open scoring menu')
  await s.tap('Set Team Rosters')
  // The scorer keeps score for both teams, so the editor, its Defense bench
  // and the team roster name the players in full.
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
  const order = [
    ...new Set((await s.texts()).filter(text => text.startsWith('Reorder ')))
  ]
  assert.deepEqual(order.slice(0, 2), [
    'Reorder Mike Trout',
    'Reorder Mookie Betts'
  ])
  await s.tap('Defense')
  await shown(run, 'CF')
  await s.tap('Lineup')
  await s.tap('Create Player')
  await keyboardAway(run)
  await s.reach('Create Placeholder Player')
  await s.tap('Create Placeholder Player')
  await shown(run, 'Select number of players to create')
  await s.tap('Cancel')
  await input(run, 'First Name', 'Jose')
  await input(run, 'Last Name', 'Ramirez')
  await input(run, 'Jersey Number', '11')
  await s.reach('Create Player')
  await s.tap('Create Player')
  await shown(run, 'Jose Ramirez')
  await s.tap('Create Player')
  await keyboardAway(run)
  await s.reach('Create Placeholder Player')
  await s.tap('Create Placeholder Player')
  await s.tap('Create')
  await s.tap('Cancel')
  await s.tap('Roster')
  await shown(run, 'game-only player')
  await s.tap('Defense')
  await s.tap('Clear P')
  await shown(run, 'Assign P')
  const defenders = await s.nodes()
  const pitcher = defenders.find(
    node => textOf(node) === 'Mookie Betts'
  )?.bounds
  const place = defenders.find(node => textOf(node) === 'Assign P')?.bounds
  assert(pitcher != null && place != null)
  await s.m.dragAndDrop({
    from: {
      point: `${Math.round(pitcher.x + pitcher.width / 2)},${Math.round(pitcher.y + pitcher.height / 2)}`
    },
    to: {
      point: `${Math.round(place.x + place.width / 2)},${Math.round(place.y + place.height / 2)}`
    },
    holdDuration: 700,
    duration: 1000
  })
  await shown(run, 'Clear P')
  await s.tap('Cancel')
  // The pitch stays unsent while the stack holds the game's saves.
  await holdRequests(ctx, `/api/v1/games/${run.game}/events`, 10000)
  try {
    await s.tap('Ball')
    await shown(run, 'Undo Ball')
    await s.tap('Open scoring menu')
    await s.tap('Set Team Rosters')
    await s.tap('Roster')
    await tapPlayer(run, 'Mookie Betts')
    await shown(run, 'JERSEY NUMBER')
    await s.tap('Home')
    await shown(run, 'Discard and Exit')
    await s.capture('pending-exit')
    await s.tap('Cancel')
    await shown(run, 'JERSEY NUMBER')
    await s.tap('Back')
    await shown(run, 'Tap player to edit.')
  } finally {
    await holdRequests(ctx, null)
  }
  await until(
    async () => await run.book(),
    book => book.currentPlay != null,
    'the held pitch to reach the server',
    40000
  )
  await s.tap('Cancel')
  await shown(run, 'Undo Ball')
  await s.m.waitForAnimationToEnd({ timeout: 3000 })
  const undo = (await s.nodes()).find(
    node => textOf(node) === 'Undo Ball'
  )?.bounds
  assert(undo != null)
  await s.m.tapOnPoint({
    x: Math.round(undo.x + undo.width / 2),
    y: Math.round(undo.y + undo.height / 2),
    longPress: true,
    duration: 650
  })
  await shown(run, 'Tap event to assign a tag.')
  await s.capture('history-continuity')
  await s.tap('Dismiss scoring history')
  await s.tapStarts('Undo ')
  await shown(run, 'Nothing to undo')
}

function section(name: string): HarnessScenario {
  return async ctx => {
    const run = await beginRoster(ctx)
    const { s } = run
    if (name === 'lineup-regressions') {
      await regressions(run)
      return
    }
    await openRosters(run)
    if (['all', 'names-persisted', 'names'].includes(name))
      await scoreOnePitch(run)
    await menuRosters(run)
    await shown(run, 'Lineup')
    if (name === 'names' || name === 'names-persisted') {
      await names(run, name === 'names-persisted')
      return
    }
    await s.capture('lineup')
    if (name === 'all') await s.tap('Remove Aaron Judge')
    await s.tap('Defense')
    await s.capture('defense')
    await s.tap('Roster')
    await s.capture('edit-roster')
    await shown(run, 'Mookie Betts')
    await shown(run, 'bats right, throws right')
    await s.tap('Home Team')
    await shown(run, 'Mookie Betts')
    await s.tap('Away Team')
    if (name !== 'm1') await settings(run, name === 'all')
    if (name === 'all') {
      await s.tap('Cancel')
      await s.open(`teams/${run.teams.away}?tab=roster`)
      await shown(run, 'Mookie Betts')
      await s.reach('Mookie Betts')
      await s.tapStarts('Mookie Betts')
      await shown(run, 'Settings')
      await s.tap('Settings')
      await shown(run, 'JERSEY NUMBER')
      await shown(run, 'Mookie Betts')
      await s.tap('Back')
    } else await s.tap('Cancel')
    await s.open(
      `players/${run.gumbos.away[0]}?tab=settings&onTeam=${run.teams.away}`
    )
    await shown(run, 'JERSEY NUMBER')
    await shown(run, 'Mookie Betts')
    if (name === 'm1') await s.capture('player-settings')
    if (name === 'all') await regressions(run)
  }
}

const SECTIONS = ['all', 'names', 'names-persisted', 'm1', 'lineup-regressions']

export default defineHarness({
  id: 'scoring/roster-edit/player-settings',
  title:
    "A scorekeeper edits the roster and players' settings from the scoring screen without losing the book",
  kind: 'e2e',
  covers: [
    'src/app/scoring/ScoringScreen.tsx',
    'src/app/scoring/scoringRosterEdit.ts',
    'src/app/scoring/PlayerEntrySheet.tsx',
    'src/app/screens/PlayerSettingsTab.tsx',
    'src/server/routes/players.ts',
    'src/server/routes/teams.ts'
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
  // The scenarios set and clear `api-500` themselves, as setup.
  faults: [],
  manual: false,
  sendsNoMail: true,
  scenarios: Object.fromEntries(SECTIONS.map(name => [name, section(name)]))
})
