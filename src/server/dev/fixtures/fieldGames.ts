import type { Kysely, Transaction } from 'kysely'

import {
  asPostEventsBody,
  type CurrentPlay,
  type GumboPlay
} from '../../../common/gumboPlay'
import type { ScoringAction } from '../../../common/scoring/actions'
import { newSetup, type RosterPlayer } from '../../../common/scoring/lineup'
import type {
  StoredDefaultLineup,
  StoredLineup
} from '../../../common/scoring/lineupHistory'
import { asScoringMutation } from '../../../common/scoring/scoringMutation'
import {
  type EventStore,
  ScoringSession,
  type SessionContext
} from '../../../common/scoring/session'
import { type Position, POSITIONS } from '../../../common/scoring/state'
import type { Database } from '../../db/database'
import { postGamePlays, readPlays } from '../../events/postPlays'
import { ensureGumboId } from '../../users/insertUser'
import { joinTeam } from '../lineupFixture'
import {
  createScoringGame,
  type ScoringGameFixture,
  userMinter
} from '../scoringGame'
import {
  createAccount,
  type FixtureAccount,
  type FixtureManifest,
  type Person,
  type WorldContext
} from './accounts'

/**
 * The scoring field's own games, for the scenarios that drag, place and
 * tag on the real scoring screen (`e2e/tests/scoring/{roster-drag,
 * roster-field, defensive-sheet, defensive-native, prior-runner, pickoff,
 * runner-drag, position-font-fit, event-tags}`). Each world is a league
 * game or a few between two teams, a scorer who keeps score for both, and,
 * where a scenario starts mid-game, the plays already scored, written as
 * the app writes them (`postGamePlays`).
 */

type Side = 'home' | 'away'

const SCORER: Person = { first: 'Bob', last: 'Uecker' }

interface Made {
  game: ScoringGameFixture
  gumbo: Record<Side, number[]>
}

/** Makes the teams and games, and every player's gumbo id, in roster order. */
async function makeGames(
  trx: Transaction<Database>,
  options: {
    games?: number
    names: Record<Side, readonly string[]>
    teams: Record<Side, string>
  }
): Promise<Made> {
  const game = await createScoringGame(trx, await userMinter(trx), options)
  const gumbo = { home: [] as number[], away: [] as number[] }
  for (const side of ['away', 'home'] as const)
    for (const userId of game.roster[side])
      gumbo[side].push(await ensureGumboId(trx, userId))
  return { game, gumbo }
}

/** Sets jerseys by roster index: `jerseys[side][i]` for player i. */
async function setJerseys(
  trx: Transaction<Database>,
  made: Made,
  jerseys: Partial<Record<Side, readonly string[]>>
): Promise<void> {
  for (const side of ['away', 'home'] as const) {
    const list = jerseys[side]
    if (list == null) continue
    const teamId = side === 'home' ? made.game.homeTeamId : made.game.awayTeamId
    for (const [i, jersey] of list.entries())
      await trx
        .updateTable('memberships')
        .set({ jersey })
        .where('user_id', '=', made.game.roster[side][i])
        .where('team_id', '=', teamId)
        .execute()
  }
}

/**
 * Each side's default lineup: its first nine batting one to nine, player i
 * at `POSITIONS[i]`, less the positions `open[side]` leaves to be assigned.
 */
async function setLineups(
  trx: Transaction<Database>,
  made: Made,
  jerseys: Record<Side, readonly string[]>,
  open: Partial<Record<Side, readonly Position[]>> = {}
): Promise<void> {
  for (const side of ['away', 'home'] as const) {
    const people = made.gumbo[side]
      .slice(0, POSITIONS.length)
      .map((gumboId, i) => ({ gumboId, jersey: jerseys[side][i] }))
    const defense = Object.fromEntries(
      POSITIONS.map((position, i) => [
        position,
        (open[side] ?? []).includes(position) ? null : people[i]
      ])
    ) as StoredLineup['defense']
    const value: StoredDefaultLineup = {
      lineup: { batters: people, defense },
      fromGameId: null,
      setAt: new Date().toISOString()
    }
    await trx
      .updateTable('teams')
      .set({ default_lineup: value })
      .where(
        'id',
        '=',
        side === 'home' ? made.game.homeTeamId : made.game.awayTeamId
      )
      .execute()
  }
}

/** Gives `account` a role on both teams. */
async function joinBoth(
  trx: Transaction<Database>,
  made: Made,
  account: FixtureAccount,
  role?: 'scorekeeper'
): Promise<void> {
  await joinTeam(trx, account.userId, made.game.awayTeamId, role)
  await joinTeam(trx, account.userId, made.game.homeTeamId, role)
}

/** Player i's jersey: i + 1. */
function counting(names: readonly string[]): string[] {
  return names.map((_, i) => String(i + 1))
}

/** The game's teams and its opening lineups, as the app's session has them. */
export function sessionContext(
  made: Made,
  names: Record<Side, readonly string[]>,
  jerseys: Record<Side, readonly string[]>,
  teamNames: Record<Side, string>
): Omit<SessionContext, 'gamePk'> {
  const teams = {
    away: { id: made.game.awayTeamId, name: teamNames.away },
    home: { id: made.game.homeTeamId, name: teamNames.home }
  }
  const roster = (side: Side): RosterPlayer[] =>
    made.gumbo[side].map((gumboId, i) => ({
      gumboId,
      shortName: names[side][i],
      jersey: jerseys[side][i],
      positions: i < POSITIONS.length ? [POSITIONS[i]] : [],
      bats: 'right',
      throws: 'right'
    }))
  return {
    teams,
    setup: newSetup(teams, { away: roster('away'), home: roster('home') })
  }
}

/**
 * Scores `actions` on a game as the app does, one save each, straight to
 * the database through the server's own write. `now` stamps each action.
 */
export async function scoreGame(
  db: Kysely<Database>,
  gameId: string,
  context: Omit<SessionContext, 'gamePk'>,
  actions: ScoringAction[],
  now?: () => Date
): Promise<void> {
  const load = async (id: string): ReturnType<EventStore['load']> => {
    const game = await db
      .selectFrom('games')
      .select(['currentPlay', 'scoring_mutation'])
      .where('id', '=', id)
      .executeTakeFirstOrThrow()
    return {
      plays: (await readPlays(db, id)).map(row => row.gumbo as GumboPlay),
      currentPlay: game.currentPlay as CurrentPlay | null,
      scoringMutation:
        game.scoring_mutation == null
          ? undefined
          : asScoringMutation(game.scoring_mutation)
    }
  }
  const store: EventStore = {
    load,
    save: async (id, change) => {
      await postGamePlays(
        db,
        id,
        asPostEventsBody({
          ...change,
          mode: 'live',
          source: { system: 'teamstation' }
        })
      )
      return await load(id)
    }
  }
  const session = await ScoringSession.open(
    store,
    gameId,
    { gamePk: gameId, ...context },
    {
      setTimer: () => null,
      clearTimer: () => undefined,
      ...(now == null ? {} : { now })
    }
  )
  for (const action of actions) {
    const problems = session.apply(action).problems
    if (problems.length > 0) throw new Error(problems[0].message)
    await session.flush()
  }
}

/** Players named `Player 1` … `Player n`. */
function numbered(n: number): string[] {
  return Array.from({ length: n }, (_, i) => `Player ${i + 1}`)
}

/** Scheduled games with a scorer, and the ids every world hands back. */
async function scorerWorld(
  context: WorldContext,
  world: string,
  options: {
    games?: number
    names: Record<Side, readonly string[]>
    teams: Record<Side, string>
    jerseys?: Record<Side, readonly string[]>
    open?: Partial<Record<Side, readonly Position[]>>
    lineups?: boolean
  }
): Promise<{
  made: Made
  scorer: FixtureAccount
  ids: Record<string, string>
}> {
  const scorer = await createAccount(context, world, 'scorer', SCORER)
  const jerseys = options.jerseys ?? {
    away: counting(options.names.away),
    home: counting(options.names.home)
  }
  const made = await context.db.transaction().execute(async trx => {
    const made = await makeGames(trx, options)
    await setJerseys(trx, made, jerseys)
    if (options.lineups !== false)
      await setLineups(trx, made, jerseys, options.open)
    await joinBoth(trx, made, scorer, 'scorekeeper')
    return made
  })
  const ids: Record<string, string> = {
    game: made.game.games[0],
    homeTeam: made.game.homeTeamId,
    awayTeam: made.game.awayTeamId
  }
  for (const [i, game] of made.game.games.entries()) ids[`game${i + 1}`] = game
  return { made, scorer, ids }
}

/**
 * `roster-players`: Visitors at Hosts, fourteen players a side named
 * `Player 1` … `Player 14`, wearing 1 … 14, the first nine of each the
 * default lineup at P … RF, the other five on the bench.
 */
export async function runRosterPlayers(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'roster-players'
  const { scorer, ids } = await scorerWorld(context, world, {
    names: { away: numbered(14), home: numbered(14) },
    teams: { away: 'Visitors', home: 'Hosts' }
  })
  return { world, nonce: context.nonce, accounts: { scorer }, ids }
}

/** The defensive sheet's roster: each side's twelve, by name and jersey. */
export const DEFENSE_NAMES = [
  'Mookie Betts',
  'Mike Trout',
  'Shohei Ohtani',
  'Aaron Judge',
  'Bryce Harper',
  'Freddie Freeman',
  'Francisco Lindor',
  'Juan Soto',
  'Bobby Witt',
  'Julio Rodriguez',
  'Nolan Arenado',
  'Ronald Acuna'
] as const
const DEFENSE_JERSEYS = [
  '50',
  '27',
  '17',
  '99',
  '3',
  '5',
  '12',
  '22',
  '7',
  '44',
  '',
  '0'
]

/**
 * `defense-gaps`: the Owls at the Hawks, twelve a side (`DEFENSE_NAMES`,
 * Mookie Betts #50, Mike Trout #27 … Nolan Arenado with no jersey). Each
 * side's first nine bat one to nine at P … RF, but the Hawks, who take the
 * field first, have nobody at P or LF: the game opens on "Assign a
 * pitcher".
 */
export async function runDefenseGaps(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'defense-gaps'
  const { scorer, ids } = await scorerWorld(context, world, {
    names: { away: DEFENSE_NAMES, home: DEFENSE_NAMES },
    teams: { away: 'Owls', home: 'Hawks' },
    jerseys: { away: DEFENSE_JERSEYS, home: DEFENSE_JERSEYS },
    open: { home: ['P', 'LF'] }
  })
  return { world, nonce: context.nonce, accounts: { scorer }, ids }
}

/**
 * `empty-defense`: the Owls at the Hawks with nobody on either roster, so
 * all nine of the Hawks' positions read "Assign …" when scoring opens.
 */
export async function runEmptyDefense(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'empty-defense'
  const { scorer, ids } = await scorerWorld(context, world, {
    names: { away: [], home: [] },
    teams: { away: 'Owls', home: 'Hawks' },
    lineups: false
  })
  return { world, nonce: context.nonce, accounts: { scorer }, ids }
}

const PICKOFF_NAMES: Record<Side, string[]> = {
  away: Array.from(
    { length: 9 },
    (_, i) => `Visitor ${String(i + 1).padStart(2, '0')}`
  ),
  home: Array.from(
    { length: 9 },
    (_, i) => `Host ${String(i + 1).padStart(2, '0')}`
  )
}

/**
 * `pickoff-game`: Silver Rockets at Copper Comets, nine a side named
 * `Visitor 01` … and `Host 01` …, in lineup at P … RF; three games
 * (`game1` … `game3`), none scored. `ids.context` is the teams and opening
 * lineups as JSON, for reading a stored game as a session.
 */
export async function runPickoffGame(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'pickoff-game'
  const teams = { away: 'Silver Rockets', home: 'Copper Comets' }
  const { made, scorer, ids } = await scorerWorld(context, world, {
    games: 3,
    names: PICKOFF_NAMES,
    teams
  })
  ids.context = JSON.stringify(
    sessionContext(
      made,
      PICKOFF_NAMES,
      {
        away: counting(PICKOFF_NAMES.away),
        home: counting(PICKOFF_NAMES.home)
      },
      teams
    )
  )
  return { world, nonce: context.nonce, accounts: { scorer }, ids }
}

const PRIOR_NAMES = DEFENSE_NAMES.slice(0, 9)

export const PRIOR_SCENARIOS = [
  'first',
  'second',
  'home',
  'pitched',
  'open',
  'occupied',
  'timed'
] as const
export type PriorScenario = (typeof PRIOR_SCENARIOS)[number]

/**
 * The plays before each prior-runner scenario, by roster index: `a(0)` is
 * the Owls' leadoff, Mookie Betts, `h(7)` the Hawks' center fielder.
 */
export function priorActions(
  scenario: PriorScenario,
  a: (i: number) => number,
  h: (i: number) => number
): ScoringAction[] {
  const hit: ScoringAction[] = [
    { type: 'ballInPlay', contact: 'swing', fielder: h(7) },
    { type: 'result', eventType: 'single' }
  ]
  const close: ScoringAction = { type: 'gameFlow', kind: 'closePlay' }
  const actions: ScoringAction[] = [...hit]
  if (scenario === 'timed') {
    actions[1] = { type: 'result', eventType: 'double' }
    actions.push(close)
  } else if (scenario === 'first' || scenario === 'pitched') {
    actions.push({ type: 'runnerMovement', runner: a(0), to: '2B' }, close)
  } else {
    actions.push(close)
    if (scenario !== 'occupied')
      actions.push({ type: 'baseRunning', kind: 'steal', runner: a(0) })
    if (scenario === 'home')
      actions.push({ type: 'baseRunning', kind: 'steal', runner: a(0) })
    actions.push(...hit)
    if (scenario === 'home')
      actions.push({ type: 'runnerMovement', runner: a(0), to: 'home' })
    if (scenario !== 'open') actions.push(close)
  }
  if (scenario === 'pitched')
    actions.push(
      { type: 'pitch', call: 'B' },
      { type: 'pitch', call: 'C' },
      { type: 'pitch', call: 'B' }
    )
  return actions
}

/**
 * `prior-runner`: the Owls at the Hawks, nine a side, and one game per
 * scenario (`ids.<scenario>`), each already scored to where the scenario
 * starts (`priorActions`). `ids.runner` is Mookie Betts's gumbo id, the
 * runner every scenario sends back; `ids.context` the teams and opening
 * lineups as JSON, for reading the stored game as a session.
 */
export async function runPriorRunner(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'prior-runner'
  const names = { away: PRIOR_NAMES, home: PRIOR_NAMES }
  const teams = { away: 'Owls', home: 'Hawks' }
  const { made, scorer, ids } = await scorerWorld(context, world, {
    games: PRIOR_SCENARIOS.length,
    names,
    teams
  })
  const jerseys = { away: counting(PRIOR_NAMES), home: counting(PRIOR_NAMES) }
  const session = sessionContext(made, names, jerseys, teams)
  for (const [i, scenario] of PRIOR_SCENARIOS.entries()) {
    const gameId = made.game.games[i]
    ids[scenario] = gameId
    let tick = 0
    await scoreGame(
      context.db,
      gameId,
      session,
      priorActions(
        scenario,
        n => made.gumbo.away[n],
        n => made.gumbo.home[n]
      ),
      () => new Date(Date.UTC(2026, 0, 1, 12, 0, tick++))
    )
  }
  ids.runner = String(made.gumbo.away[0])
  ids.context = JSON.stringify(session)
  return { world, nonce: context.nonce, accounts: { scorer }, ids }
}

/** Three swinging strikes, then the next batter's first pitch. */
function strikeoutThen(call: 'B' | 'C'): ScoringAction[] {
  return [
    { type: 'pitch', call: 'S' },
    { type: 'pitch', call: 'S' },
    { type: 'pitch', call: 'S' },
    { type: 'pitch', call }
  ]
}

/**
 * `event-tags`: Visitors at Hosts, twelve a side named `Visitor 01` … and
 * `Host 01` … (`Host 08` plays center), and four games:
 *
 * - `tagged`: Visitor 01 struck out swinging, then a Ball to Visitor 02:
 *   five events to tag;
 * - `second`: not scored;
 * - `edge`: called strike, called strike, swinging strike, then a Ball;
 * - `edgeHome`: as `tagged`, the game the edge scenarios land on.
 *
 * `scorer` keeps score for both teams; `admin`, a second scorer who has
 * tagged nothing; `member`, on the Hosts with no role, who may only read.
 */
export async function runEventTags(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'event-tags'
  const names = {
    away: Array.from(
      { length: 12 },
      (_, i) => `Visitor ${String(i + 1).padStart(2, '0')}`
    ),
    home: Array.from(
      { length: 12 },
      (_, i) => `Host ${String(i + 1).padStart(2, '0')}`
    )
  }
  const teams = { away: 'Visitors', home: 'Hosts' }
  const { made, scorer, ids } = await scorerWorld(context, world, {
    games: 4,
    names,
    teams
  })
  const admin = await createAccount(context, world, 'admin', {
    first: 'Vin',
    last: 'Scully'
  })
  const member = await createAccount(context, world, 'member', {
    first: 'Harry',
    last: 'Caray'
  })
  await context.db.transaction().execute(async trx => {
    await joinBoth(trx, made, admin, 'scorekeeper')
    await joinTeam(trx, member.userId, made.game.homeTeamId)
  })
  const jerseys = { away: counting(names.away), home: counting(names.home) }
  const session = sessionContext(made, names, jerseys, teams)
  const [tagged, second, edge, edgeHome] = made.game.games
  await scoreGame(context.db, tagged, session, strikeoutThen('B'))
  await scoreGame(context.db, edge, session, [
    { type: 'pitch', call: 'C' },
    { type: 'pitch', call: 'C' },
    { type: 'pitch', call: 'S' },
    { type: 'pitch', call: 'B' }
  ])
  await scoreGame(context.db, edgeHome, session, strikeoutThen('B'))
  Object.assign(ids, { tagged, second, edge, edgeHome })
  return {
    world,
    nonce: context.nonce,
    accounts: { scorer, admin, member },
    ids
  }
}
