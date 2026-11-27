import { makeId } from '../../../common/ids'
import { createGuestPlayer } from '../../games/guestPlayers'
import { ensureGumboId, insertUser } from '../../users/insertUser'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

type Hand = 'left' | 'right'
type Row = [string, string, Hand | 'switch', Hand]

const PEOPLE = {
  coach: { first: 'Dave', last: 'Martinez' },
  guardian: { first: 'Tony', last: 'Gwynn' },
  scorer: { first: 'Vin', last: 'Scully' },
  heron: { first: 'Tim', last: 'Raines' }
}

/** The Owls: Betts and Freeman first, then forty more. */
const OWLS: Row[] = [
  ['Mookie', 'Betts', 'right', 'right'],
  ['Freddie', 'Freeman', 'left', 'right'],
  ...[
    'Aaron Judge',
    'Juan Soto',
    'Shohei Ohtani',
    'Bryce Harper',
    'Trea Turner',
    'Corey Seager',
    'Marcus Semien',
    'Jose Altuve',
    'Alex Bregman',
    'Kyle Tucker',
    'Yordan Alvarez',
    'Rafael Devers',
    'Pete Alonso',
    'Francisco Lindor',
    'Ronald Acuna',
    'Matt Olson',
    'Austin Riley',
    'Ozzie Albies',
    'Manny Machado',
    'Fernando Tatis',
    'Xander Bogaerts',
    'Bo Bichette',
    'Vladimir Guerrero',
    'George Springer',
    'Bobby Witt',
    'Salvador Perez',
    'Julio Rodriguez',
    'Cal Raleigh',
    'Adley Rutschman',
    'Gunnar Henderson',
    'Cedric Mullins',
    'Paul Goldschmidt',
    'Nolan Arenado',
    'Christian Yelich',
    'William Contreras',
    'Ian Happ',
    'Dansby Swanson',
    'Seiya Suzuki',
    'Elly De La Cruz',
    'Spencer Steer'
  ].map((name): Row => {
    const [first, ...last] = name.split(' ')
    return [first, last.join(' '), 'right', 'right']
  })
]

function day(offset: number): string {
  return new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10)
}

/**
 * The people, teams and game of adding an existing player (the scoring
 * world of `scripts/e2e/existingPlayer/fixture.ts`, under this run's nonce,
 * with fresh ids and the mailbox's addresses):
 *
 * - A league with a current season. Ridgeview Falcons (home) and Lakeside
 *   Herons (away) play in it two hours on; Valley Bears are in it too.
 * - Hillcrest Hawks are in the same league's other season, and Coastal Gulls
 *   in another league altogether.
 * - The coach administers, coaches and scores the Falcons and is a member of
 *   Ridgeview Owls, who have 42 players. The guardian guards Mookie Betts, an
 *   Owl. The scorer is only a scorekeeper of the Falcons, and the heron only a
 *   member of the Herons.
 *
 * Organization setup is marked done, as it is on a production node. `ids`
 * holds the game, each team (`falcons`, `herons`, …) and each named player
 * (`Mookie Betts` …).
 */
export async function runExistingPlayer(
  context: WorldContext
): Promise<FixtureManifest> {
  return await existingPlayerWorld(context, 'existing-player')
}

/**
 * `existing-player`, with Mike Trout added to the Falcons' side of their
 * game as a game-only player (`guest`), as the roster layout opens it.
 */
export async function runExistingPlayerGuest(
  context: WorldContext
): Promise<FixtureManifest> {
  const made = await existingPlayerWorld(context, 'existing-player-guest')
  const guest = await createGuestPlayer(
    context.db,
    {
      userId: made.accounts.coach.userId,
      isAdmin: false,
      scopes: []
    },
    made.ids.game,
    'home',
    {
      firstName: 'Mike',
      lastName: 'Trout',
      jersey: '27',
      positions: [],
      bats: 'right',
      throws: 'right'
    },
    made.ids.falcons
  )
  return { ...made, ids: { ...made.ids, guest: String(guest.userId) } }
}

async function existingPlayerWorld(
  context: WorldContext,
  world: string
): Promise<FixtureManifest> {
  const { db, nonce } = context
  const ids = {
    league: makeId('league'),
    otherLeague: makeId('league'),
    season: makeId('season'),
    pastSeason: makeId('season'),
    otherSeason: makeId('season'),
    game: makeId('game')
  }
  const teams = {
    falcons: { id: makeId('team'), name: `Ridgeview Falcons ${nonce}` },
    herons: { id: makeId('team'), name: `Lakeside Herons ${nonce}` },
    owls: { id: makeId('team'), name: `Ridgeview Owls ${nonce}` },
    bears: { id: makeId('team'), name: `Valley Bears ${nonce}` },
    hawks: { id: makeId('team'), name: `Hillcrest Hawks ${nonce}` },
    gulls: { id: makeId('team'), name: `Coastal Gulls ${nonce}` }
  }
  // A node whose organization setup is done, as production is: the
  // guardian's Reject is a relationship decision, which waits on it.
  await db
    .insertInto('system_settings')
    .values({ key: 'creation.hierarchyReady', value: true })
    .onConflict(oc => oc.column('key').doUpdateSet({ value: true }))
    .execute()
  await db
    .insertInto('leagues')
    .values([
      { id: ids.league, name: `Ridgeview Youth Baseball ${nonce}` },
      { id: ids.otherLeague, name: `Coastal Little League ${nonce}` }
    ])
    .execute()
  const year = Number(day(0).slice(0, 4))
  await db
    .insertInto('seasons')
    .values([
      {
        id: ids.season,
        league_id: ids.league,
        name: 'Fall Ball',
        year,
        starts_on: day(-30),
        ends_on: day(120)
      },
      {
        id: ids.pastSeason,
        league_id: ids.league,
        name: 'Winter Clinic',
        year,
        starts_on: day(-30),
        ends_on: day(90)
      },
      {
        id: ids.otherSeason,
        league_id: ids.otherLeague,
        name: 'Coastal Fall',
        year,
        starts_on: day(-30),
        ends_on: day(60)
      }
    ])
    .execute()
  await db
    .insertInto('teams')
    .values(
      Object.values(teams).map(team => ({
        id: team.id,
        name: team.name,
        league_id: team.id === teams.gulls.id ? ids.otherLeague : ids.league
      }))
    )
    .execute()
  const seasonOf: Array<[string, string]> = [
    [teams.falcons.id, ids.season],
    [teams.herons.id, ids.season],
    [teams.owls.id, ids.season],
    [teams.bears.id, ids.season],
    [teams.hawks.id, ids.pastSeason],
    [teams.gulls.id, ids.otherSeason]
  ]
  await db
    .insertInto('season_teams')
    .values(
      seasonOf.map(([teamId, seasonId]) => ({
        season_id: seasonId,
        team_id: teamId
      }))
    )
    .execute()

  const coach = await createAccount(context, world, 'coach', PEOPLE.coach)
  const guardian = await createAccount(
    context,
    world,
    'guardian',
    PEOPLE.guardian
  )
  const scorer = await createAccount(context, world, 'scorer', PEOPLE.scorer)
  const heron = await createAccount(context, world, 'heron', PEOPLE.heron)
  const member = async (userId: string, teamId: string): Promise<void> => {
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userId,
        team_id: teamId,
        role: 'member'
      })
      .execute()
  }
  const role = async (
    userId: string,
    teamId: string,
    held: 'admin' | 'coach' | 'scorekeeper'
  ): Promise<void> => {
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userId,
        scope_type: 'team',
        scope_id: teamId,
        role: held
      })
      .execute()
  }
  await member(coach.userId, teams.falcons.id)
  await role(coach.userId, teams.falcons.id, 'coach')
  await role(coach.userId, teams.falcons.id, 'scorekeeper')
  await role(coach.userId, teams.falcons.id, 'admin')
  await member(coach.userId, teams.owls.id)
  await member(scorer.userId, teams.falcons.id)
  await role(scorer.userId, teams.falcons.id, 'scorekeeper')
  await member(heron.userId, teams.herons.id)

  const player = async (
    teamId: string,
    [first, last, bats, throws]: Row,
    jersey: string,
    positions: string[] = []
  ): Promise<string> => {
    const userId = await insertUser(db, {
      display_name: `${first} ${last}`,
      first_name: first,
      last_name: last,
      bats,
      throws
    })
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userId,
        team_id: teamId,
        role: 'member',
        is_player: true,
        jersey,
        positions
      })
      .execute()
    await ensureGumboId(db, userId)
    return userId
  }
  const players: Record<string, string> = {}
  for (const [index, row] of OWLS.entries())
    players[`${row[0]} ${row[1]}`] = await player(
      teams.owls.id,
      row,
      String(index + 1)
    )
  players['Clayton Kershaw'] = await player(
    teams.falcons.id,
    ['Clayton', 'Kershaw', 'left', 'left'],
    '22',
    ['P']
  )
  players['Corbin Burnes'] = await player(
    teams.bears.id,
    ['Corbin', 'Burnes', 'right', 'right'],
    '39',
    ['P']
  )
  players['Max Fried'] = await player(
    teams.hawks.id,
    ['Max', 'Fried', 'left', 'left'],
    '54',
    ['P']
  )
  players['Jose Ramirez'] = await player(
    teams.gulls.id,
    ['Jose', 'Ramirez', 'switch', 'right'],
    '11',
    ['3B']
  )
  for (const [index, name] of ['Ryan Helsley', 'Jordan Walker'].entries()) {
    const [first, last] = name.split(' ')
    players[name] = await player(
      teams.herons.id,
      [first, last, 'right', 'right'],
      String(index + 30)
    )
  }
  await db
    .insertInto('user_links')
    .values({
      id: makeId('userLink'),
      user_id: guardian.userId,
      related_user_id: players['Mookie Betts'],
      kind: 'guardian',
      can_manage: true
    })
    .execute()
  await db
    .insertInto('games')
    .values({
      id: ids.game,
      home_team_id: teams.falcons.id,
      away_team_id: teams.herons.id,
      season_id: ids.season,
      start_at: new Date(Date.now() + 2 * 3_600_000),
      venue: 'Ridgeview Park',
      status: 'scheduled'
    })
    .execute()
  return {
    world,
    nonce,
    accounts: { coach, guardian, scorer, heron },
    ids: {
      ...ids,
      ...Object.fromEntries(
        Object.entries(teams).map(([key, team]) => [key, team.id])
      ),
      ...Object.fromEntries(
        Object.entries(teams).map(([key, team]) => [`${key}Name`, team.name])
      ),
      ...players
    }
  }
}
