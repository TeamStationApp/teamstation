import { makeId } from '../../../common/ids'
import { insertUser } from '../../users/insertUser'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

/** Invented people, with MLB players' names. */
const PEOPLE = {
  alAdmin: { first: 'Aaron', last: 'Boone' },
  yankeesPlayer: { first: 'Aaron', last: 'Judge' },
  dodgersPlayer: { first: 'Mookie', last: 'Betts' },
  nlAdmin: { first: 'Dave', last: 'Roberts' },
  neutral: { first: 'Clayton', last: 'Kershaw' }
}

/** The rest of each roster, beside the two players who sign in. */
const SURNAMES = [
  'Soto',
  'Volpe',
  'Rizzo',
  'Torres',
  'Devers',
  'Story',
  'Casas',
  'Yoshida',
  'Freeman',
  'Ohtani',
  'Smith',
  'Muncy',
  'Hernandez',
  'Swanson',
  'Happ',
  'Suzuki',
  'Hoerner',
  'Bellinger',
  'Stanton',
  'Cole',
  'Bregman',
  'Duran',
  'Rafaela',
  'Lux',
  'Outman',
  'Rojas',
  'Taylor',
  'Busch',
  'Morel',
  'Amaya',
  'Wells',
  'Wesneski',
  'Kim',
  'Abreu',
  'Rodon',
  'Glasnow'
]

/** Players on each team, the account that signs in counted among them. */
export const SPONSOR_ROSTERS = {
  yankees: 10,
  redSox: 9,
  dodgers: 12,
  cubs: 8
} as const

/**
 * What the sponsor scenarios need, made only of tables a server without
 * sponsor features already has, so the same world seeds a stack of the base
 * and one of the branch: the "American League" and the "National League";
 * the Yankees (AL, 10 players), Red Sox (AL, 9), Dodgers (NL, 12) and Cubs
 * (NL, 8); an AL season holding Yankees @ Red Sox and the interleague
 * Dodgers @ Yankees; and five accounts — an administrator of each league, a
 * Yankees player, a Dodgers player and a user on neither team. It writes no
 * videos, cameras or sponsor rows: those come from the scenario, through the
 * API or the recording rig.
 */
export async function runSponsors(
  context: WorldContext
): Promise<FixtureManifest> {
  const { db, nonce } = context
  const world = 'sponsors'
  const alAdmin = await createAccount(context, world, 'alAdmin', PEOPLE.alAdmin)
  const yankeesPlayer = await createAccount(
    context,
    world,
    'yankeesPlayer',
    PEOPLE.yankeesPlayer
  )
  const dodgersPlayer = await createAccount(
    context,
    world,
    'dodgersPlayer',
    PEOPLE.dodgersPlayer
  )
  const nlAdmin = await createAccount(context, world, 'nlAdmin', PEOPLE.nlAdmin)
  const neutral = await createAccount(context, world, 'neutral', PEOPLE.neutral)
  const now = new Date()

  const americanLeague = makeId('league')
  const nationalLeague = makeId('league')
  await db
    .insertInto('leagues')
    .values([
      { id: americanLeague, name: 'American League' },
      { id: nationalLeague, name: 'National League' }
    ])
    .execute()
  for (const [admin, league] of [
    [alAdmin, americanLeague],
    [nlAdmin, nationalLeague]
  ] as const)
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: admin.userId,
        scope_type: 'league',
        scope_id: league,
        role: 'admin',
        granted_by: null,
        granted_at: now
      })
      .execute()

  const teams = {
    yankees: { name: 'Yankees', league: americanLeague, id: makeId('team') },
    redSox: { name: 'Red Sox', league: americanLeague, id: makeId('team') },
    dodgers: { name: 'Dodgers', league: nationalLeague, id: makeId('team') },
    cubs: { name: 'Cubs', league: nationalLeague, id: makeId('team') }
  }
  await db
    .insertInto('teams')
    .values(
      Object.values(teams).map(team => ({
        id: team.id,
        name: team.name,
        league_id: team.league,
        kind: 'full' as const,
        created_from: 'manual'
      }))
    )
    .execute()

  // Each roster: the account that signs in, then invented players.
  let surname = 0
  const signsIn: Partial<Record<keyof typeof teams, string>> = {
    yankees: yankeesPlayer.userId,
    dodgers: dodgersPlayer.userId
  }
  for (const key of Object.keys(teams) as Array<keyof typeof teams>) {
    const players: string[] = []
    const account = signsIn[key]
    if (account != null) players.push(account)
    while (players.length < SPONSOR_ROSTERS[key]) {
      const last = SURNAMES[surname++ % SURNAMES.length]
      players.push(
        await insertUser(db, {
          display_name: `${teams[key].name} ${last}`,
          first_name: teams[key].name,
          last_name: last,
          login_enabled: false
        })
      )
    }
    await db
      .insertInto('memberships')
      .values(
        players.map(userId => ({
          id: makeId('membership'),
          user_id: userId,
          team_id: teams[key].id,
          role: 'member' as const,
          is_player: true
        }))
      )
      .execute()
  }

  const season = makeId('season')
  await db
    .insertInto('seasons')
    .values({
      id: season,
      league_id: americanLeague,
      name: 'AL Regular Season',
      timezone: 'UTC',
      year: now.getUTCFullYear(),
      term: 'Spring',
      starts_on: `${now.getUTCFullYear()}-01-01`,
      ends_on: `${now.getUTCFullYear() + 1}-12-31`
    })
    .execute()
  await db
    .insertInto('season_teams')
    .values(
      [teams.yankees, teams.redSox, teams.dodgers].map(team => ({
        season_id: season,
        team_id: team.id,
        active: true
      }))
    )
    .execute()

  // Upcoming, so the Schedules list them; a recording or the schedule API
  // moves them when a scenario needs it.
  const hour = 3_600_000
  const startOf = (hours: number): Date =>
    new Date(Math.ceil(now.getTime() / hour) * hour + hours * hour)
  const yankeesAtRedSox = makeId('game')
  const dodgersAtYankees = makeId('game')
  await db
    .insertInto('games')
    .values([
      {
        id: yankeesAtRedSox,
        season_id: season,
        home_team_id: teams.redSox.id,
        away_team_id: teams.yankees.id,
        start_at: startOf(2),
        venue: 'Sponsor Field',
        status: 'scheduled'
      },
      {
        id: dodgersAtYankees,
        season_id: season,
        home_team_id: teams.yankees.id,
        away_team_id: teams.dodgers.id,
        start_at: startOf(26),
        venue: 'Sponsor Field',
        status: 'scheduled'
      }
    ])
    .execute()

  return {
    world,
    nonce,
    accounts: { alAdmin, yankeesPlayer, dodgersPlayer, nlAdmin, neutral },
    ids: {
      americanLeague,
      nationalLeague,
      season,
      yankees: teams.yankees.id,
      redSox: teams.redSox.id,
      dodgers: teams.dodgers.id,
      cubs: teams.cubs.id,
      yankeesAtRedSox,
      dodgersAtYankees
    }
  }
}
