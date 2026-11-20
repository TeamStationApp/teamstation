import { type Kysely, sql } from 'kysely'

import { makeId } from '../../../common/ids'
import type { Locality } from '../../../common/locality'
import type { Database } from '../../db/database'
import { placeCoordinates } from '../../location/places'
import { JEV_KEY_SETTING } from '../../nodeSettings'
import { createTeam } from '../../teams/createTeam'
import {
  createAccount,
  type FixtureAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

/** The Jev key the world sets, so the stack's Jev stand-in is called. */
export const SEARCH_JEV_PLACEHOLDER = 'e2e-jev-placeholder-key'

/**
 * Real GeoNames places, so the search engine's coordinates and location
 * pills resolve: San Diego and the suburbs around it, a California city far
 * from it, and a city in another state. No real team or person is named.
 */
export const SEARCH_PLACES: Record<string, Locality> = {
  sanDiego: place('5391811', 'San Diego', 'California'),
  nationalCity: place('5376200', 'National City', 'California'),
  chulaVista: place('5336899', 'Chula Vista', 'California'),
  laMesa: place('5363990', 'La Mesa', 'California'),
  elCajon: place('5345529', 'El Cajon', 'California'),
  escondido: place('5346827', 'Escondido', 'California'),
  sacramento: place('5389489', 'Sacramento', 'California'),
  phoenix: place('5308655', 'Phoenix', 'Arizona', 'America/Phoenix')
}

function place(
  id: string,
  city: string,
  region: string,
  timezone = 'America/Los_Angeles'
): Locality {
  return { city, region, country: 'US', placeId: `geonames:${id}`, timezone }
}

/** Invented people with MLB players' names. */
const PEOPLE = {
  coach: { first: 'Dave', last: 'Roberts' },
  guardian: { first: 'Clayton', last: 'Kershaw' },
  child: { first: 'Jason', last: 'Heyward' },
  teammate: { first: 'Freddie', last: 'Freeman' },
  hawk: { first: 'LaTroy', last: 'Hawkins' },
  seasonPlayer: { first: 'Corbin', last: 'Burnes' },
  reliever: { first: 'Max', last: 'Fried' },
  stranger: { first: 'Yoshinobu', last: 'Yamamoto' },
  nodeAdmin: { first: 'Tony', last: 'Gwynn' }
}

/**
 * Whether the database has the organization coordinates columns. A
 * database without them, such as one an older server migrated, gets the
 * world without coordinates.
 */
export async function hasGroupCoordinates(
  db: Kysely<Database>
): Promise<boolean> {
  const { rows } = await sql<{ found: number }>`
    select 1 as found from information_schema.columns
    where table_schema = current_schema()
      and table_name = 'leagues' and column_name = 'latitude'`.execute(db)
  return rows.length > 0
}

/**
 * What the search scenarios search: every organization's name ends in the
 * world's nonce, so a scenario types it to find its own world's and nobody
 * else's on a shared stack.
 *
 * - The Hawks League of San Diego, with its 2026 season and its past 2024
 *   season. Demo Hawks is its one team in San Diego, so that a stack
 *   holding many search worlds still shows the cities around it after San
 *   Diego's: Ridge Hawks and Bay Hawks in National City, Hawks Gold in Chula
 *   Vista, Hawks Blue in La Mesa, East Hawks in El Cajon and North Hawks in
 *   Escondido. Hawks Gold plays in 2026, and Hawks Blue played in 2024
 *   in the past season.
 * - The Capital Hawks League and its team in Sacramento, in California but
 *   far away, and the Desert Hawks League in Phoenix, in another state.
 * - The coach owns Demo Hawks, which writes its players' names as first
 *   name, last initial. Its players are the guardian's child and a
 *   teammate. LaTroy Hawkins, Corbin Burnes and Max Fried play for Ridge
 *   Hawks, in the same 2026 season, which shows their names in full.
 *   Yoshinobu Yamamoto plays only in the Desert league.
 * - A game of Demo Hawks against Hawks Gold today, for the scorer.
 * - The node administrator, and the Jev key set to a placeholder.
 *
 * It writes only columns an older server has too, and gives the leagues
 * and teams coordinates only where the database has them.
 */
export async function runSearch(
  context: WorldContext
): Promise<FixtureManifest> {
  const { db, nonce } = context
  const world = 'search'
  const accounts: Record<string, FixtureAccount> = {}
  for (const [role, person] of Object.entries(PEOPLE)) {
    accounts[role] = await createAccount(context, world, role, person, {
      isAdmin: role === 'nodeAdmin'
    })
  }
  const named = (name: string): string => `${name} ${nonce}`
  const ids: Record<string, string> = {}

  const league = async (
    key: string,
    name: string,
    at: Locality
  ): Promise<string> => {
    ids[key] = makeId('league')
    await db
      .insertInto('leagues')
      .values({
        id: ids[key],
        name: named(name),
        locality: JSON.stringify(at)
      })
      .execute()
    return ids[key]
  }
  const season = async (
    key: string,
    name: string,
    leagueId: string,
    year: number
  ): Promise<string> => {
    ids[key] = makeId('season')
    await db
      .insertInto('seasons')
      .values({
        id: ids[key],
        name: named(name),
        league_id: leagueId,
        year,
        starts_on: `${year}-01-01`,
        ends_on: `${year}-12-31`
      })
      .execute()
    return ids[key]
  }
  const team = async (
    key: string,
    name: string,
    at: Locality,
    leagueId: string,
    seasonId?: string
  ): Promise<string> => {
    ids[key] = makeId('team')
    await db
      .insertInto('teams')
      .values({
        id: ids[key],
        name: named(name),
        league_id: leagueId,
        locality: JSON.stringify(at)
      })
      .execute()
    if (seasonId != null) await inSeason(ids[key], seasonId)
    return ids[key]
  }
  const inSeason = async (teamId: string, seasonId: string): Promise<void> => {
    await db
      .insertInto('season_teams')
      .values({ season_id: seasonId, team_id: teamId })
      .execute()
    await db
      .insertInto('season_team_parents')
      .values({ season_id: seasonId, team_id: teamId })
      .execute()
  }
  const player = async (
    teamId: string,
    account: FixtureAccount
  ): Promise<void> => {
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: account.userId as never,
        team_id: teamId,
        role: 'member',
        is_player: true
      })
      .execute()
  }

  const hawks = await league('league', 'Hawks League', SEARCH_PLACES.sanDiego)
  const current = await season('season', 'Hawks Spring 2026', hawks, 2026)
  const past = await season('pastSeason', 'Hawks Spring 2024', hawks, 2024)

  // The coach's own team, made the way the app makes one.
  const own = await createTeam(
    db,
    { name: named('Demo Hawks'), externalIds: [] },
    { userId: accounts.coach.userId, isAdmin: false }
  )
  ids.team = own.id
  await db
    .updateTable('teams')
    .set({
      league_id: hawks,
      locality: JSON.stringify(SEARCH_PLACES.sanDiego),
      player_name_privacy: 'firstLastInitial'
    })
    .where('id', '=', own.id)
    .execute()
  await inSeason(own.id, current)
  await player(own.id, accounts.child)
  await player(own.id, accounts.teammate)
  await db
    .insertInto('user_links')
    .values({
      id: makeId('userLink'),
      user_id: accounts.guardian.userId,
      related_user_id: accounts.child.userId,
      kind: 'guardian'
    })
    .execute()

  const ridge = await team(
    'followableTeam',
    'Ridge Hawks',
    SEARCH_PLACES.nationalCity,
    hawks,
    current
  )
  // Its players' names are public in full, so "hawk" finds LaTroy Hawkins.
  await db
    .updateTable('teams')
    .set({ player_name_privacy: 'full' })
    .where('id', '=', ridge)
    .execute()
  await player(ridge, accounts.hawk)
  await player(ridge, accounts.seasonPlayer)
  await player(ridge, accounts.reliever)
  const gold = await team(
    'currentTeam',
    'Hawks Gold',
    SEARCH_PLACES.chulaVista,
    hawks,
    current
  )
  const blue = await team(
    'pastTeam',
    'Hawks Blue',
    SEARCH_PLACES.laMesa,
    hawks,
    past
  )
  const bay = await team(
    'nationalCityTeam',
    'Bay Hawks',
    SEARCH_PLACES.nationalCity,
    hawks,
    past
  )
  await team('elCajonTeam', 'East Hawks', SEARCH_PLACES.elCajon, hawks)
  await team('escondidoTeam', 'North Hawks', SEARCH_PLACES.escondido, hawks)

  const capital = await league(
    'stateLeague',
    'Capital Hawks League',
    SEARCH_PLACES.sacramento
  )
  await team('stateTeam', 'Capital Hawks', SEARCH_PLACES.sacramento, capital)

  const desert = await league(
    'otherLeague',
    'Desert Hawks League',
    SEARCH_PLACES.phoenix
  )
  const desertSeason = await season(
    'otherSeason',
    'Desert Spring 2026',
    desert,
    2026
  )
  const far = await team(
    'otherTeam',
    'Desert Hawks',
    SEARCH_PLACES.phoenix,
    desert,
    desertSeason
  )
  await player(far, accounts.stranger)

  ids.game = makeId('game')
  ids.pastGame = makeId('game')
  await db
    .insertInto('games')
    .values([
      {
        id: ids.game,
        home_team_id: own.id,
        away_team_id: gold,
        season_id: current,
        start_at: new Date(),
        venue: 'Hawks Field',
        status: 'scheduled'
      },
      {
        id: ids.pastGame,
        home_team_id: blue,
        away_team_id: bay,
        season_id: past,
        start_at: new Date('2024-05-04T18:00:00Z'),
        venue: 'Hawks Field',
        status: 'final',
        home_score: 4,
        away_score: 2
      }
    ])
    .execute()

  if (await hasGroupCoordinates(db)) {
    for (const table of ['leagues', 'teams'] as const) {
      const rows = await db
        .selectFrom(table)
        .select(['id', 'locality'])
        .where('id', 'in', Object.values(ids))
        .execute()
      for (const row of rows) {
        const at = placeCoordinates(row.locality as Locality | null)
        if (at == null) continue
        await db
          .updateTable(table)
          .set({ latitude: at.latitude, longitude: at.longitude })
          .where('id', '=', row.id)
          .execute()
      }
    }
  }

  const key = JSON.stringify(SEARCH_JEV_PLACEHOLDER)
  await db
    .insertInto('system_settings')
    .values({ key: JEV_KEY_SETTING, value: key })
    .onConflict(oc => oc.column('key').doUpdateSet({ value: key }))
    .execute()

  return { world, nonce, accounts, ids }
}
