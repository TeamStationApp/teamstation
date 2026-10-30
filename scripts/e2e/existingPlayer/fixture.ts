/**
 * The people, teams and game the existing-player scenarios use, written into
 * this machine's database.
 *
 *   node -r sucrase/register scripts/e2e/existingPlayer/fixture.ts \
 *     [--out <fixture.json>]
 *
 * Run it once on a freshly migrated database (`npm run migrate`): every row
 * has a fixed id, and a second run refuses rather than mix two fixtures.
 *
 * - A league with a current season. Ridgeview Falcons (home) and Lakeside
 *   Herons (away) play in it today; Valley Bears are in it too.
 * - Hillcrest Hawks are in the same league's other season, and Coastal Gulls
 *   in another league altogether.
 * - The coach administers, coaches and scores the Falcons and is a member of
 *   Ridgeview Owls, who have 42 players. The guardian guards Mookie Betts, an
 *   Owl. The scorer is only a scorekeeper of the Falcons, and the heron only a
 *   member of the Herons.
 *
 * Organization setup is marked done, as it is on a production node.
 *
 * Every name is a Major League player's. The password is drawn here and kept
 * only in the fixture file, which is written readable by its owner alone.
 */
import { randomBytes } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'
import { parseArgs } from 'node:util'

import type { Kysely } from 'kysely'

import { makeId } from '../../../src/common/ids'
import { addEmail } from '../../../src/server/auth/emails'
import { hashPassword } from '../../../src/server/auth/passwords'
import { type Database, makeDatabase } from '../../../src/server/db/database'
import { serverConfig } from '../../../src/server/serverConfig'
import { ensureGumboId, insertUser } from '../../../src/server/users/insertUser'

type Db = Kysely<Database>
type Hand = 'left' | 'right'

const { values } = parseArgs({
  options: {
    out: {
      type: 'string',
      default: '/private/tmp/teamstation-existingPlayer/fixture.json'
    }
  }
})

export const FIXTURE = {
  leagueId: 'lea_existingPlayerLeague',
  otherLeagueId: 'lea_existingPlayerOther',
  seasonId: 'sea_existingPlayerSeason',
  pastSeasonId: 'sea_existingPlayerHawks',
  otherSeasonId: 'sea_existingPlayerGulls',
  gameId: 'gam_existingPlayerGame',
  teams: {
    falcons: { id: 'tem_existingFalcons', name: 'Ridgeview Falcons' },
    herons: { id: 'tem_existingHerons', name: 'Lakeside Herons' },
    owls: { id: 'tem_existingOwls', name: 'Ridgeview Owls' },
    bears: { id: 'tem_existingBears', name: 'Valley Bears' },
    hawks: { id: 'tem_existingHawks', name: 'Hillcrest Hawks' },
    gulls: { id: 'tem_existingGulls', name: 'Coastal Gulls' }
  },
  emails: {
    coach: 'existing-coach@example.test',
    guardian: 'existing-guardian@example.test',
    scorer: 'existing-scorer@example.test',
    heron: 'existing-heron@example.test'
  }
} as const

/** The Owls: Betts and Freeman first, then forty more. */
const OWLS: Array<[string, string, Hand, Hand]> = [
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
  ].map(name => {
    const [first, ...last] = name.split(' ')
    return [first, last.join(' '), 'right', 'right'] as [
      string,
      string,
      Hand,
      Hand
    ]
  })
]

function day(offset: number): string {
  const at = new Date(Date.now() + offset * 86_400_000)
  return at.toISOString().slice(0, 10)
}

async function account(
  db: Db,
  email: string,
  passwordHash: string
): Promise<string> {
  const userId = await insertUser(db, {
    display_name: email.split('@')[0],
    password_hash: passwordHash,
    login_enabled: true,
    is_admin: false
  })
  await addEmail(db, userId, email, { isPrimary: true, source: 'manual' })
  return userId
}

async function player(
  db: Db,
  teamId: string,
  [first, last, bats, throws]: [string, string, Hand | 'switch', Hand],
  jersey: string,
  positions: string[] = []
): Promise<string> {
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

async function member(db: Db, userId: string, teamId: string): Promise<void> {
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

async function role(
  db: Db,
  userId: string,
  teamId: string,
  held: 'admin' | 'coach' | 'scorekeeper'
): Promise<void> {
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

export async function writeFixture(db: Db): Promise<Record<string, unknown>> {
  const taken = await db
    .selectFrom('leagues')
    .select('id')
    .where('id', '=', FIXTURE.leagueId)
    .executeTakeFirst()
  if (taken != null)
    throw new Error('The fixture is already here: migrate a fresh database')

  // A node whose organization setup is done, as production is: the
  // guardian's Reject is a relationship decision, which waits on it.
  await db
    .insertInto('system_settings')
    .values({ key: 'creation.hierarchyReady', value: true })
    .onConflict(oc => oc.column('key').doUpdateSet({ value: true }))
    .execute()
  const { teams } = FIXTURE
  await db
    .insertInto('leagues')
    .values([
      { id: FIXTURE.leagueId, name: 'Ridgeview Youth Baseball' },
      { id: FIXTURE.otherLeagueId, name: 'Coastal Little League' }
    ])
    .execute()
  await db
    .insertInto('seasons')
    .values([
      {
        id: FIXTURE.seasonId,
        league_id: FIXTURE.leagueId,
        name: 'Fall Ball',
        year: Number(day(0).slice(0, 4)),
        starts_on: day(-30),
        ends_on: day(120)
      },
      {
        id: FIXTURE.pastSeasonId,
        league_id: FIXTURE.leagueId,
        name: 'Winter Clinic',
        year: Number(day(0).slice(0, 4)),
        starts_on: day(-30),
        ends_on: day(90)
      },
      {
        id: FIXTURE.otherSeasonId,
        league_id: FIXTURE.otherLeagueId,
        name: 'Coastal Fall',
        year: Number(day(0).slice(0, 4)),
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
        league_id:
          team.id === teams.gulls.id ? FIXTURE.otherLeagueId : FIXTURE.leagueId
      }))
    )
    .execute()
  const seasonOf: Record<string, string> = {
    [teams.falcons.id]: FIXTURE.seasonId,
    [teams.herons.id]: FIXTURE.seasonId,
    [teams.owls.id]: FIXTURE.seasonId,
    [teams.bears.id]: FIXTURE.seasonId,
    [teams.hawks.id]: FIXTURE.pastSeasonId,
    [teams.gulls.id]: FIXTURE.otherSeasonId
  }
  await db
    .insertInto('season_teams')
    .values(
      Object.entries(seasonOf).map(([teamId, seasonId]) => ({
        season_id: seasonId,
        team_id: teamId
      }))
    )
    .execute()

  const password = randomBytes(12).toString('base64url')
  const passwordHash = await hashPassword(password)
  const coach = await account(db, FIXTURE.emails.coach, passwordHash)
  const guardian = await account(db, FIXTURE.emails.guardian, passwordHash)
  const scorer = await account(db, FIXTURE.emails.scorer, passwordHash)
  const heron = await account(db, FIXTURE.emails.heron, passwordHash)
  await member(db, coach, teams.falcons.id)
  await role(db, coach, teams.falcons.id, 'coach')
  await role(db, coach, teams.falcons.id, 'scorekeeper')
  await role(db, coach, teams.falcons.id, 'admin')
  await member(db, coach, teams.owls.id)
  await member(db, scorer, teams.falcons.id)
  await role(db, scorer, teams.falcons.id, 'scorekeeper')
  await member(db, heron, teams.herons.id)

  const players: Record<string, string> = {}
  for (const [index, row] of OWLS.entries())
    players[`${row[0]} ${row[1]}`] = await player(
      db,
      teams.owls.id,
      row,
      String(index + 1)
    )
  players['Clayton Kershaw'] = await player(
    db,
    teams.falcons.id,
    ['Clayton', 'Kershaw', 'left', 'left'],
    '22',
    ['P']
  )
  players['Corbin Burnes'] = await player(
    db,
    teams.bears.id,
    ['Corbin', 'Burnes', 'right', 'right'],
    '39',
    ['P']
  )
  players['Max Fried'] = await player(
    db,
    teams.hawks.id,
    ['Max', 'Fried', 'left', 'left'],
    '54',
    ['P']
  )
  players['Jose Ramirez'] = await player(
    db,
    teams.gulls.id,
    ['Jose', 'Ramirez', 'switch', 'right'],
    '11',
    ['3B']
  )
  for (const [index, name] of ['Ryan Helsley', 'Jordan Walker'].entries()) {
    const [first, last] = name.split(' ')
    players[name] = await player(
      db,
      teams.herons.id,
      [first, last, 'right', 'right'],
      String(index + 30)
    )
  }
  await db
    .insertInto('user_links')
    .values({
      id: makeId('userLink'),
      user_id: guardian,
      related_user_id: players['Mookie Betts'],
      kind: 'guardian',
      can_manage: true
    })
    .execute()

  await db
    .insertInto('games')
    .values({
      id: FIXTURE.gameId,
      home_team_id: teams.falcons.id,
      away_team_id: teams.herons.id,
      season_id: FIXTURE.seasonId,
      start_at: new Date(Date.now() + 2 * 3_600_000),
      venue: 'Ridgeview Park',
      status: 'scheduled'
    })
    .execute()

  return {
    ...FIXTURE,
    password,
    accounts: { coach, guardian, scorer, heron },
    players
  }
}

async function main(): Promise<void> {
  const db = makeDatabase(serverConfig.databaseUrl)
  try {
    const fixture = await writeFixture(db)
    mkdirSync(dirname(values.out), { recursive: true })
    writeFileSync(values.out, JSON.stringify(fixture, null, 2), { mode: 0o600 })
    console.log(`fixture written to ${values.out}`)
  } finally {
    await db.destroy()
  }
}

if (require.main === module) {
  main().catch((error: unknown) => {
    console.error(error)
    process.exitCode = 1
  })
}
