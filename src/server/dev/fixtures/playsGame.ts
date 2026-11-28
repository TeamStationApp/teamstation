import type { Kysely } from 'kysely'

import { asPostEventsBody, type GumboPlay } from '../../../common/gumboPlay'
import { makeId } from '../../../common/ids'
import type { ScoringAction } from '../../../common/scoring/actions'
import { radarTargets } from '../../../common/scoring/radarSpeeds'
import {
  ScoringSession,
  type StoredGame
} from '../../../common/scoring/session'
import type { GameSetup, Side } from '../../../common/scoring/state'
import { withoutNames } from '../../../common/scoring/storedNames'
import {
  asImported,
  AWAY_PLAYERS,
  firstActionOfHalf,
  HOME_PLAYERS,
  MemoryStore,
  type Player,
  REPLAY_TEAMS,
  replayActions,
  replaySetup
} from '../../../test/replayGameFixture'
import type { Database } from '../../db/database'
import { postGamePlays } from '../../events/postPlays'
import { drain } from '../../statsBuilder/builder'
import { ensureGumboId, insertUser } from '../../users/insertUser'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

const PEOPLE = {
  member: { first: 'Walker', last: 'Buehler' },
  scorer: { first: 'Joe', last: 'Kelly' },
  outsider: { first: 'Brusdar', last: 'Graterol' }
}

/** Seconds between one scoring action and the next, in game order. */
const ACTION_STEP_MS = 20_000

type Db = Kysely<Database>
type Teams = Record<Side, { id: string; name: string }>

/**
 * What the Plays tab's scenarios read: a league, a season and two teams
 * playing the replay fixture's game stored five ways, and three accounts —
 * `member` on the home team, `scorer` keeping its score, and `outsider`, on
 * neither team.
 *
 * - `final`: the whole game, posted with a radar reading for every pitch and
 *   every ball put in play, so every pitch has a speed and every fair ball an
 *   exit velocity.
 * - `inProgress`: cut one pitch into Muncy's at-bat in the bottom of the 2nd.
 * - `mixed`: the first two innings imported with no pitches, the 3rd on
 *   scored in TeamStation.
 * - `imported`: the whole game as an importer stores it, no pitch at all,
 *   final.
 * - `onePitch`: the game's first pitch and nothing more, in progress.
 *
 * Every game starts when the world is made, so none not stored final has
 * ended. Each run makes its own of everything.
 */
export async function runPlaysGame(
  context: WorldContext
): Promise<FixtureManifest> {
  const { db, nonce } = context
  const world = 'plays-game'
  const member = await createAccount(context, world, 'member', PEOPLE.member)
  const scorer = await createAccount(context, world, 'scorer', PEOPLE.scorer)
  const outsider = await createAccount(
    context,
    world,
    'outsider',
    PEOPLE.outsider
  )
  const start = new Date()
  const leagueId = makeId('league')
  const seasonId = makeId('season')
  const teams: Teams = {
    away: { id: makeId('team'), name: REPLAY_TEAMS.away.name },
    home: { id: makeId('team'), name: REPLAY_TEAMS.home.name }
  }
  const games = {
    final: makeId('game'),
    inProgress: makeId('game'),
    mixed: makeId('game'),
    imported: makeId('game'),
    onePitch: makeId('game')
  }
  const setup = await db.transaction().execute(async trx => {
    await trx
      .insertInto('leagues')
      .values({ id: leagueId, name: `Plays League ${nonce}` })
      .execute()
    await trx
      .insertInto('seasons')
      .values({
        id: seasonId,
        league_id: leagueId,
        name: `Plays Season ${nonce}`,
        year: start.getUTCFullYear(),
        starts_on: `${start.getUTCFullYear()}-01-01`,
        ends_on: `${start.getUTCFullYear()}-12-31`
      })
      .execute()
    for (const team of [teams.away, teams.home]) {
      await trx.insertInto('teams').values(team).execute()
      await trx
        .insertInto('season_teams')
        .values({ season_id: seasonId, team_id: team.id })
        .execute()
    }
    const gumboIds = new Map<Player, number>()
    for (const [side, players] of [
      ['away', AWAY_PLAYERS],
      ['home', HOME_PLAYERS]
    ] as const)
      for (const [index, player] of players.entries())
        gumboIds.set(
          player,
          await addPlayer(trx, teams[side].id, player, index, side)
        )
    for (const [account, role] of [
      [member, undefined],
      [scorer, 'scorekeeper']
    ] as const) {
      await trx
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: account.userId as never,
          team_id: teams.home.id,
          role: 'member'
        })
        .execute()
      if (role != null)
        await trx
          .insertInto('scope_roles')
          .values({
            id: makeId('scopeRole'),
            user_id: account.userId as never,
            scope_type: 'team',
            scope_id: teams.home.id,
            role
          })
          .execute()
    }
    await trx
      .insertInto('games')
      .values(
        Object.values(games).map(id => ({
          id,
          home_team_id: teams.home.id,
          away_team_id: teams.away.id,
          season_id: seasonId,
          start_at: start,
          venue: 'Plays Field',
          status: 'scheduled' as const
        }))
      )
      .execute()
    return gameSetup(gumboIds, teams)
  })

  const actions = replayActions(setup)
  const score = async (
    gameId: string,
    taken: ScoringAction[],
    store = new MemoryStore()
  ): Promise<StoredGame> =>
    await scored(gameId, taken, setup, teams, store, start)

  // The whole game, its actions twenty seconds apart, each pitch and ball in
  // play read by the radar at its own moment.
  const final = restamped(await score(games.final, actions), start)
  await readRadar(db, games.final, final.plays)
  await post(db, games.final, final, 'teamstation')

  const inProgress = await score(
    games.inProgress,
    actions.slice(0, muncysFirstPitch(actions) + 1)
  )
  await post(db, games.inProgress, inProgress, 'teamstation')

  // Found in the fixture's own game: the actions are the same, one for one,
  // and its teams are the ones its records name.
  const third = firstActionOfHalf(replayActions(), 3, 'top')
  const whole = await score(games.mixed, actions)
  const store = new MemoryStore()
  for (const play of whole.plays.filter(one => (one.about.inning ?? 0) < 3))
    store.plays.set(play.about.atBatIndex, asImported(play))
  const mixed = await score(games.mixed, actions.slice(third), store)
  const imported = mixed.plays.filter(play => !('teamStation' in play))
  await post(
    db,
    games.mixed,
    { plays: imported, currentPlay: null },
    'importer',
    true
  )
  await post(
    db,
    games.mixed,
    {
      plays: mixed.plays.filter(play => 'teamStation' in play),
      currentPlay: mixed.currentPlay
    },
    'teamstation'
  )

  const importedWhole = await score(games.imported, actions)
  await post(
    db,
    games.imported,
    { plays: importedWhole.plays.map(asImported), currentPlay: null },
    'importer'
  )
  const last = importedWhole.plays.at(-1)!
  await db
    .updateTable('games')
    .set({
      status: 'final',
      away_score: last.result.awayScore ?? null,
      home_score: last.result.homeScore ?? null
    })
    .where('id', '=', games.imported)
    .execute()

  const firstPitch = actions.findIndex(action => action.type === 'pitch')
  const onePitch = await score(games.onePitch, actions.slice(0, firstPitch + 1))
  await post(db, games.onePitch, onePitch, 'teamstation')

  await drain(db, () => new Date())
  return {
    world,
    nonce,
    accounts: { member, scorer, outsider },
    ids: {
      league: leagueId,
      season: seasonId,
      awayTeam: teams.away.id,
      homeTeam: teams.home.id,
      awayTeamName: teams.away.name,
      homeTeamName: teams.home.name,
      ...games
    }
  }
}

/** A rostered player of the team, made for this world, and their scoring id. */
async function addPlayer(
  db: Db,
  teamId: string,
  player: Player,
  index: number,
  side: Side
): Promise<number> {
  const userId = await insertUser(db, {
    display_name: `${player.first} ${player.last}`,
    first_name: player.first,
    last_name: player.last,
    bats: 'right',
    throws: 'right'
  })
  await db
    .insertInto('memberships')
    .values({
      id: makeId('membership'),
      user_id: userId,
      team_id: teamId,
      role: 'member',
      is_player: true,
      // The visitors from 1 and the home side from 21, as the replay seed.
      jersey: String(index + (side === 'away' ? 1 : 21)),
      positions: player.position == null ? [] : [player.position]
    })
    .execute()
  return await ensureGumboId(db, userId)
}

/** The replay fixture's lineups, its players this world's and on its teams. */
function gameSetup(gumboIds: Map<Player, number>, teams: Teams): GameSetup {
  const setup = replaySetup(player => gumboIds.get(player)!)
  for (const [side, players] of [
    ['away', AWAY_PLAYERS],
    ['home', HOME_PLAYERS]
  ] as const)
    for (const [index, player] of players.entries()) {
      const record = setup.players[gumboIds.get(player)!]
      record.teamId = teams[side].id
      record.jersey = String(index + (side === 'away' ? 1 : 21))
    }
  return setup
}

/** Scores the actions into this world's game, as the scoring screen would. */
async function scored(
  gameId: string,
  actions: ScoringAction[],
  setup: GameSetup,
  teams: Teams,
  store: MemoryStore,
  now: Date
): Promise<StoredGame> {
  const session = await ScoringSession.open(
    store,
    gameId,
    { gamePk: gameId, teams, setup: structuredClone(setup) },
    { now: () => now, setTimer: () => null, clearTimer: () => undefined }
  )
  for (const [index, action] of actions.entries()) {
    const applied = session.apply(action)
    if (applied.problems.length > 0)
      throw new Error(
        `action ${index} ${JSON.stringify(action)}: ${applied.problems[0].message}`
      )
  }
  await session.flush()
  return store.stored()
}

/**
 * The plays with their actions one step apart in game order from `start`.
 * A session scored at one instant stamps every action alike, and then every
 * radar window would hold every reading.
 */
function restamped(game: StoredGame, start: Date): StoredGame {
  let step = 0
  const plays = [...game.plays]
    .sort((a, b) => a.about.atBatIndex - b.about.atBatIndex)
    .map(play => {
      const record = (play as { teamStation?: { actionTimes?: string[] } })
        .teamStation
      if (record?.actionTimes == null) return play
      return {
        ...play,
        teamStation: {
          ...record,
          actionTimes: record.actionTimes.map(() =>
            new Date(start.getTime() + ACTION_STEP_MS * step++).toISOString()
          )
        }
      }
    })
  return { ...game, plays }
}

/**
 * One radar reading per pitch and ball in play, at its own moment: the n-th
 * reads `70 + n mod 12` mph off the hand and `88 + n mod 10` off the bat.
 */
async function readRadar(
  db: Db,
  gameId: string,
  plays: GumboPlay[]
): Promise<void> {
  const targets = plays.flatMap(radarTargets)
  if (targets.length === 0) return
  await db
    .insertInto('scoreboard_log')
    .values(
      targets.map((target, n) => ({
        game_id: gameId,
        version: n + 1,
        at: new Date(target.at),
        cause: 'publisher' as const,
        actor_id: null,
        publisher: null,
        radar: JSON.stringify({
          pitchSpeed: 70 + (n % 12),
          exitVelocity: 88 + (n % 10)
        }),
        overrides: JSON.stringify({})
      }))
    )
    .execute()
}

/** Where `inProgressGame` cuts: the first pitch after Stanton moves to center. */
function muncysFirstPitch(actions: ScoringAction[]): number {
  return actions.findIndex(
    (action, i) =>
      action.type === 'pitch' &&
      i > 0 &&
      actions[i - 1].type === 'lineup' &&
      (actions[i - 1] as { kind?: string }).kind === 'position'
  )
}

async function post(
  db: Db,
  gameId: string,
  game: Pick<StoredGame, 'plays' | 'currentPlay'>,
  system: 'teamstation' | 'importer',
  live = system === 'teamstation'
): Promise<void> {
  // Posted as the app posts them, naming nobody.
  await postGamePlays(
    db,
    gameId,
    asPostEventsBody({
      plays: game.plays.map(play => withoutNames(play)),
      ...(live
        ? {
            currentPlay:
              game.currentPlay == null
                ? game.currentPlay
                : withoutNames(game.currentPlay),
            mode: 'live'
          }
        : {}),
      source: { system }
    }),
    undefined,
    undefined,
    { answer: 'all' }
  )
}
