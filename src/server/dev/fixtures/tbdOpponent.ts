import { makeId } from '../../../common/ids'
import { joinTeam } from '../lineupFixture'
import {
  createAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

/** Invented people, with MLB players' names. */
const PEOPLE = {
  ravensCoach: { first: 'Brandon', last: 'Hyde' },
  ravensScorekeeper: { first: 'Cal', last: 'Ripken' },
  heronsCoach: { first: 'Bob', last: 'Melvin' },
  seasonAdmin: { first: 'Theo', last: 'Epstein' },
  seasonScorekeeper: { first: 'Vin', last: 'Scully' }
}

/**
 * What the TBD-opponent scenarios need, made only of tables a server without
 * open sides already has, so the same world seeds a stack of the base and one
 * of the branch: a league; the teams `Ravens` (a coach and a scorekeeper) and
 * `Herons` (a coach); the season `Valley Spring`, in which both teams are
 * active and which is the parent of both; the season's administrator and its
 * scorekeeper, who hold no team role; and one field at a venue the league
 * claims. Every name ends in the nonce, so two runs on one stack never share
 * a team a search could find. It writes no game: the scenarios schedule
 * their own.
 */
export async function runTbdOpponent(
  context: WorldContext
): Promise<FixtureManifest> {
  const { db, nonce } = context
  const world = 'tbd-opponent'
  const ravensCoach = await createAccount(
    context,
    world,
    'ravensCoach',
    PEOPLE.ravensCoach
  )
  const ravensScorekeeper = await createAccount(
    context,
    world,
    'ravensScorekeeper',
    PEOPLE.ravensScorekeeper
  )
  const heronsCoach = await createAccount(
    context,
    world,
    'heronsCoach',
    PEOPLE.heronsCoach
  )
  const seasonAdmin = await createAccount(
    context,
    world,
    'seasonAdmin',
    PEOPLE.seasonAdmin
  )
  const seasonScorekeeper = await createAccount(
    context,
    world,
    'seasonScorekeeper',
    PEOPLE.seasonScorekeeper
  )
  const now = new Date()
  const year = now.getUTCFullYear()

  const ids = await db.transaction().execute(async trx => {
    const league = makeId('league')
    await trx
      .insertInto('leagues')
      .values({ id: league, name: `Valley League ${nonce}` })
      .execute()
    const ravens = makeId('team')
    const herons = makeId('team')
    await trx
      .insertInto('teams')
      .values(
        [
          { id: ravens, name: `Ravens ${nonce}` },
          { id: herons, name: `Herons ${nonce}` }
        ].map(team => ({
          ...team,
          league_id: league,
          kind: 'full' as const,
          created_from: 'manual'
        }))
      )
      .execute()
    await joinTeam(trx, ravensCoach.userId, ravens, 'coach')
    await joinTeam(trx, ravensScorekeeper.userId, ravens, 'scorekeeper')
    await joinTeam(trx, heronsCoach.userId, herons, 'coach')

    const season = makeId('season')
    await trx
      .insertInto('seasons')
      .values({
        id: season,
        league_id: league,
        name: `Valley Spring ${nonce}`,
        timezone: 'America/Los_Angeles',
        year,
        term: 'Spring',
        starts_on: `${year}-01-01`,
        ends_on: `${year + 1}-12-31`
      })
      .execute()
    await trx
      .insertInto('season_teams')
      .values(
        [ravens, herons].map(team => ({
          season_id: season,
          team_id: team,
          active: true
        }))
      )
      .execute()
    await trx
      .insertInto('season_team_parents')
      .values(
        [ravens, herons].map(team => ({ season_id: season, team_id: team }))
      )
      .execute()
    for (const [account, role] of [
      [seasonAdmin, 'admin'],
      [seasonScorekeeper, 'scorekeeper']
    ] as const)
      await trx
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: account.userId,
          scope_type: 'season',
          scope_id: season,
          role,
          granted_by: null,
          granted_at: now
        })
        .execute()

    // One field, at a park the league claims, so the field picker lists it.
    const venue = makeId('venue')
    await trx
      .insertInto('venues')
      .values({
        id: venue,
        google_place_id: `fixture:${world}:${nonce}`,
        name: `Valley Park ${nonce}`,
        address: '1 Valley Park Way',
        latitude: 37.3,
        longitude: -121.9,
        timezone: 'America/Los_Angeles',
        default_hours: JSON.stringify([]),
        default_windows: JSON.stringify([]),
        default_blackouts: []
      })
      .execute()
    await trx
      .insertInto('venue_claims')
      .values({
        id: makeId('venueClaim'),
        venue_id: venue,
        league_id: league,
        kind: 'claim',
        requested_by: seasonAdmin.userId,
        status: 'approved',
        requested_at: new Date(now.getTime() - 7 * 86_400_000),
        approves_at: now,
        decided_by: seasonAdmin.userId,
        decided_at: now
      })
      .execute()
    const field = makeId('venueField')
    await trx
      .insertInto('venue_fields')
      .values({
        id: field,
        venue_id: venue,
        name: 'Field 1',
        sizes: ['60/90'],
        pin_latitude: null,
        pin_longitude: null,
        starts_on: null,
        ends_on: null,
        hours: null,
        windows: null,
        blackouts: []
      })
      .execute()
    return { league, ravens, herons, season, venue, field }
  })

  return {
    world,
    nonce,
    accounts: {
      ravensCoach,
      ravensScorekeeper,
      heronsCoach,
      seasonAdmin,
      seasonScorekeeper
    },
    ids: {
      ...ids,
      ravensName: `Ravens ${nonce}`,
      heronsName: `Herons ${nonce}`,
      seasonName: `Valley Spring ${nonce}`,
      venueName: `Valley Park ${nonce}`
    }
  }
}
