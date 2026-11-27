import type { Kysely } from 'kysely'

import { makeId } from '../../../common/ids'
import type { Locality } from '../../../common/locality'
import type { Database } from '../../db/database'
import { createGroup } from '../../groups/createGroup'
import type { MediaContext } from '../../media/mediaContext'
import {
  createAccount,
  type FixtureAccount,
  type FixtureManifest,
  type Person,
  type WorldContext
} from './accounts'

/**
 * The leagues, seasons and teams the event and game form tests open, as
 * the old in-process group fixture made them: two leagues, three seasons
 * and two teams under them, a standalone season and team, and the people
 * who run and play on them. Every world here starts from it:
 *
 * - `event-groups`: the groups alone;
 * - `event-info`: and the upcoming game the Info tab shows, with the
 *   owner's two children on the Hawks;
 * - `event-info-people`: and the people, staff, family and replies whose
 *   attendance the Info tab sorts;
 * - `event-schedule`: and six Hawks games, upcoming, past, final, canceled
 *   and live, for the schedule's RSVP controls;
 * - `game-form`: and the teams, games and events Create Game suggests and
 *   lists.
 *
 * Team names carry the world's `tag` (part of its nonce), and the
 * locality's city and region do too, so a search, a suggestion or a tap by
 * name finds this world's team on a stack other worlds share. The manifest
 * names each in `ids` (`teamAName` …).
 */

type Db = Kysely<Database>

/** The people of the old fixture, by role, with the legacy number each had. */
const PEOPLE: Record<string, Person & { admin?: boolean }> = {
  owner: { first: 'Babe', last: 'Ruth' }, // 101
  rival: { first: 'Lou', last: 'Gehrig' }, // 102
  trout: { first: 'Mike', last: 'Trout' }, // 103
  ichiro: { first: 'Ichiro', last: '' }, // 104
  alvarez: { first: 'José', last: 'Alvarez', admin: true }, // 105
  raines: { first: 'Tim', last: 'Raines' } // 106
}

/** The people `event-info-people` adds. */
const MORE_PEOPLE: Record<string, Person> = {
  gwynn: { first: 'Tony', last: 'Gwynn' }, // 107
  betts: { first: 'Mookie', last: 'Betts' }, // 108
  griffey: { first: 'Ken', last: 'Griffey' }, // 109
  jackson: { first: 'Reggie', last: 'Jackson' }, // 110
  ripken: { first: 'Cal', last: 'Ripken' }, // 112
  mays: { first: 'Willie', last: 'Mays' }, // 113
  clemente: { first: 'Roberto', last: 'Clemente' }, // 114
  rodriguez: { first: 'Alex', last: 'Rodriguez' }, // 115
  ryan: { first: 'Nolan', last: 'Ryan' } // 116, a visitor on no team
}

/** The upcoming game's time and place, as the old fixture stored them. */
export const EVENT_GAME = {
  startAt: '2027-04-10T19:00:00Z',
  endAt: '2027-04-10T21:00:00Z',
  venue: 'Demo Field',
  address: '1 Demo Way, Demo City',
  latitude: 34,
  longitude: 12
}

/** No picture is stored, so the media context is never read. */
const NO_MEDIA = { space: {} } as unknown as MediaContext

interface Groups {
  accounts: Record<string, FixtureAccount>
  ids: Record<string, string>
  tag: string
  locality: Locality
}

/** One person, named exactly (a single name has no trailing space). */
async function person(
  context: WorldContext,
  world: string,
  role: string,
  who: Person & { admin?: boolean }
): Promise<FixtureAccount> {
  const account = await createAccount(context, world, role, who, {
    isAdmin: who.admin === true
  })
  if (who.last !== '') return account
  await context.db
    .updateTable('users')
    .set({ display_name: who.first })
    .where('id', '=', account.userId)
    .execute()
  return { ...account, displayName: who.first }
}

async function makeGroups(
  context: WorldContext,
  world: string
): Promise<Groups> {
  const { db, nonce } = context
  const tag = nonce.slice(0, 4).toUpperCase()
  const locality: Locality = {
    city: `Demo City ${tag}`,
    region: `Demo Region ${tag}`,
    country: 'US',
    placeId: null,
    timezone: 'UTC'
  }
  const accounts: Record<string, FixtureAccount> = {}
  for (const [role, who] of Object.entries(PEOPLE))
    accounts[role] = await person(context, world, role, who)
  let key = 0
  const create = async (
    kind: 'league' | 'season' | 'team',
    name: string,
    role: string,
    parent?: { kind: 'league' | 'season'; id: string }
  ): Promise<string> => {
    const userId = accounts[role].userId
    const made = await createGroup(
      db,
      { userId, isAdmin: false, scopes: [] },
      {
        kind,
        name,
        idempotencyKey: `${world}-${nonce}-${++key}`,
        locality,
        ...(kind === 'team'
          ? {}
          : { startsOn: '2027-03-01', endsOn: '2027-05-31', timezone: 'UTC' }),
        ...(parent == null ? {} : { parent })
      },
      NO_MEDIA
    )
    // These stand for existing direct affiliations, as the old fixture's did.
    if (parent != null)
      await db
        .insertInto('scope_roles')
        .values({
          id: makeId('scopeRole'),
          user_id: userId,
          scope_type: kind,
          scope_id: made.id,
          role: 'admin',
          granted_by: userId
        })
        .onConflict(oc =>
          oc.columns(['user_id', 'scope_type', 'scope_id', 'role']).doNothing()
        )
        .execute()
    return made.id
  }
  const names = {
    leagueAName: `Demo League A ${tag}`,
    leagueBName: `Demo League B ${tag}`,
    seasonAName: 'Demo Regular',
    playoffsName: 'Demo Playoffs',
    seasonBName: 'Demo Tournament',
    teamAName: `Demo Hawks ${tag}`,
    teamBName: `Demo Eagles ${tag}`,
    standaloneSeasonName: 'Demo Standalone',
    standaloneTeamName: `Demo Visitors ${tag}`
  }
  const leagueA = await create('league', names.leagueAName, 'owner')
  const leagueB = await create('league', names.leagueBName, 'rival')
  const seasonA = await create('season', names.seasonAName, 'owner', {
    kind: 'league',
    id: leagueA
  })
  const playoffs = await create('season', names.playoffsName, 'owner', {
    kind: 'league',
    id: leagueA
  })
  const seasonB = await create('season', names.seasonBName, 'rival', {
    kind: 'league',
    id: leagueB
  })
  const teamA = await create('team', names.teamAName, 'owner', {
    kind: 'season',
    id: seasonA
  })
  const teamB = await create('team', names.teamBName, 'rival', {
    kind: 'season',
    id: seasonB
  })
  const standaloneSeason = await create(
    'season',
    names.standaloneSeasonName,
    'trout'
  )
  const standaloneTeam = await create('team', names.standaloneTeamName, 'trout')
  // The owner's own team from before, which the owner manages.
  const accountTeam = makeId('team')
  await db
    .insertInto('teams')
    .values({ id: accountTeam, name: names.teamAName })
    .execute()
  await db
    .insertInto('memberships')
    .values({
      id: makeId('membership'),
      user_id: accounts.owner.userId,
      team_id: accountTeam,
      role: 'manager',
      is_player: true
    })
    .execute()
  return {
    accounts,
    tag,
    locality,
    ids: {
      tag,
      city: locality.city,
      leagueA,
      leagueB,
      seasonA,
      playoffs,
      seasonB,
      teamA,
      teamB,
      standaloneSeason,
      standaloneTeam,
      accountTeam,
      ...names
    }
  }
}

async function addPlayer(
  db: Db,
  teamId: string,
  userId: string,
  extra: { is_player?: boolean; positions?: string[]; jersey?: string } = {}
): Promise<void> {
  await db
    .insertInto('memberships')
    .values({
      id: makeId('membership'),
      team_id: teamId,
      user_id: userId,
      is_player: extra.is_player ?? true,
      ...(extra.positions == null ? {} : { positions: extra.positions }),
      ...(extra.jersey == null ? {} : { jersey: extra.jersey })
    })
    .execute()
}

async function guardian(db: Db, parent: string, child: string): Promise<void> {
  await db
    .insertInto('user_links')
    .values({
      id: makeId('userLink'),
      user_id: parent,
      related_user_id: child,
      kind: 'guardian',
      can_manage: false
    })
    .execute()
}

/** The owner's children, Trout and Ichiro, playing for the Hawks. */
async function childrenOnHawks(db: Db, groups: Groups): Promise<void> {
  for (const role of ['trout', 'ichiro']) {
    await addPlayer(db, groups.ids.teamA, groups.accounts[role].userId)
    await guardian(
      db,
      groups.accounts.owner.userId,
      groups.accounts[role].userId
    )
  }
}

/** The Hawks' upcoming game against the Eagles. */
async function eventGame(db: Db, groups: Groups): Promise<string> {
  const id = makeId('game')
  await db
    .insertInto('games')
    .values({
      id,
      home_team_id: groups.ids.teamA,
      away_team_id: groups.ids.teamB,
      season_id: null,
      start_at: new Date(EVENT_GAME.startAt),
      end_at: new Date(EVENT_GAME.endAt),
      venue: EVENT_GAME.venue,
      address: EVENT_GAME.address,
      latitude: EVENT_GAME.latitude,
      longitude: EVENT_GAME.longitude
    })
    .execute()
  return id
}

function manifestOf(
  world: string,
  context: WorldContext,
  groups: Groups,
  ids: Record<string, string> = {}
): FixtureManifest {
  return {
    world,
    nonce: context.nonce,
    accounts: groups.accounts,
    ids: { ...groups.ids, ...ids }
  }
}

export async function runEventGroups(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'event-groups'
  return manifestOf(world, context, await makeGroups(context, world))
}

export async function runEventInfo(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'event-info'
  const groups = await makeGroups(context, world)
  await childrenOnHawks(context.db, groups)
  const game = await eventGame(context.db, groups)
  return manifestOf(world, context, groups, { game })
}

/**
 * The Info tab's people: coaches, players with positions, a guardian of a
 * Hawks child who is on neither team, a child of the owner's outside the
 * Hawks, a season member, a league member, and their replies.
 */
export async function runEventInfoPeople(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'event-info-people'
  const { db } = context
  const groups = await makeGroups(context, world)
  await childrenOnHawks(db, groups)
  const game = await eventGame(db, groups)
  for (const [role, who] of Object.entries(MORE_PEOPLE))
    groups.accounts[role] = await person(context, world, role, who)
  const id = (role: string): string => groups.accounts[role].userId
  await db
    .updateTable('users')
    .set({ bats: 'switch', throws: 'right' })
    .where('id', 'in', ['trout', 'ichiro', 'betts', 'mays', 'clemente'].map(id))
    .execute()
  await db
    .updateTable('memberships')
    .set({ positions: ['SS', 'CF'], jersey: '8' })
    .where('team_id', '=', groups.ids.teamA)
    .where('user_id', 'in', [id('trout'), id('ichiro')])
    .execute()
  for (const role of ['gwynn', 'betts', 'ripken', 'mays', 'clemente']) {
    const plays = ['betts', 'mays', 'clemente'].includes(role)
    await addPlayer(db, groups.ids.teamA, id(role), {
      is_player: plays,
      positions: plays ? ['SS', 'CF'] : [],
      ...(plays ? { jersey: '12' } : {})
    })
  }
  for (const role of ['raines', 'betts'])
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: id(role),
        scope_type: 'team',
        scope_id: groups.ids.teamA,
        role: 'coach'
      })
      .execute()
  await guardian(db, id('alvarez'), id('trout'))
  await guardian(db, id('owner'), id('rodriguez'))
  await db
    .insertInto('season_members')
    .values({
      id: makeId('seasonMember'),
      user_id: id('griffey'),
      season_id: groups.ids.seasonA
    })
    .execute()
  await db
    .insertInto('league_members')
    .values({
      id: makeId('leagueMember'),
      user_id: id('jackson'),
      league_id: groups.ids.leagueA
    })
    .execute()
  for (const [role, response] of [
    ['alvarez', 'maybe'],
    ['raines', 'yes'],
    ['gwynn', 'no'],
    ['betts', 'yes'],
    ['griffey', 'yes'],
    ['jackson', 'no'],
    ['clemente', 'maybe']
  ] as const)
    await db
      .insertInto('game_rsvps')
      .values({
        event_id: game,
        user_id: id(role),
        response,
        updated_by: id(role)
      })
      .execute()
  return manifestOf(world, context, groups, { game })
}

/**
 * Six Hawks games a day from the world's making (the past one a day
 * before), the owner a member of the Eagles too, and the owner's children
 * on the Hawks.
 */
export async function runEventSchedule(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'event-schedule'
  const { db } = context
  const groups = await makeGroups(context, world)
  await childrenOnHawks(db, groups)
  await db
    .insertInto('memberships')
    .values({
      id: makeId('membership'),
      team_id: groups.ids.teamB,
      user_id: groups.accounts.owner.userId
    })
    .execute()
  const games: Record<string, string> = {}
  const now = Date.now()
  for (const [name, status, offset] of [
    ['upcoming', 'scheduled', 86400000],
    ['noVenue', 'scheduled', 86400000],
    ['past', 'scheduled', -86400000],
    ['final', 'final', 86400000],
    ['cancelled', 'cancelled', 86400000],
    ['live', 'inProgress', 86400000]
  ] as const) {
    const id = makeId('game')
    games[name] = id
    await db
      .insertInto('games')
      .values({
        id,
        status,
        home_team_id: groups.ids.teamA,
        away_team_id: groups.ids.teamB,
        start_at: new Date(now + offset),
        venue: name === 'noVenue' ? null : 'Demo Park',
        address: '1 Demo Way',
        latitude: 34,
        longitude: 12
      })
      .execute()
  }
  return manifestOf(world, context, groups, games)
}

/** The calendar date this many months before `now`. */
function monthsBefore(now: Date, months: number): Date {
  const date = new Date(now)
  date.setUTCMonth(date.getUTCMonth() - months)
  return date
}

/**
 * What Create Game suggests and lists: a same-season team with a coach, an
 * opponent from five months ago and one from seven, a same-region team, a
 * game in no season to edit and a season's game, the owner keeping the
 * Eagles too, and a practice and an Other event on the Hawks schedule.
 */
export async function runGameForm(
  context: WorldContext
): Promise<FixtureManifest> {
  const world = 'game-form'
  const { db, nonce } = context
  const groups = await makeGroups(context, world)
  const far: Locality = {
    city: `Far City ${groups.tag}`,
    region: `Far Region ${groups.tag}`,
    country: 'US',
    placeId: null,
    timezone: 'UTC'
  }
  let key = 0
  const team = async (
    name: string,
    role: string,
    locality: Locality,
    parent?: { kind: 'season'; id: string }
  ): Promise<string> =>
    (
      await createGroup(
        db,
        { userId: groups.accounts[role].userId, isAdmin: false, scopes: [] },
        {
          kind: 'team',
          name,
          idempotencyKey: `${world}-teams-${nonce}-${++key}`,
          locality,
          ...(parent == null ? {} : { parent })
        },
        NO_MEDIA
      )
    ).id
  const names = {
    sameSeasonName: `Demo Owls ${groups.tag}`,
    recentOpponentName: `Demo Falcons ${groups.tag}`,
    staleOpponentName: `Demo Ravens ${groups.tag}`,
    sameRegionName: `Demo Herons ${groups.tag}`
  }
  const sameSeason = await team(
    names.sameSeasonName,
    'owner',
    groups.locality,
    {
      kind: 'season',
      id: groups.ids.seasonA
    }
  )
  await db
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      scope_type: 'team',
      scope_id: sameSeason,
      user_id: groups.accounts.ichiro.userId,
      role: 'coach',
      granted_by: groups.accounts.owner.userId,
      granted_at: new Date()
    })
    .execute()
  const recentOpponent = await team(names.recentOpponentName, 'trout', far)
  const staleOpponent = await team(names.staleOpponentName, 'trout', far)
  const sameRegion = await team(names.sameRegionName, 'raines', groups.locality)
  const now = new Date()
  for (const [opponent, months] of [
    [recentOpponent, 5],
    [staleOpponent, 7]
  ] as const) {
    const startAt = monthsBefore(now, months)
    await db
      .insertInto('games')
      .values({
        id: makeId('game'),
        home_team_id: groups.ids.teamA,
        away_team_id: opponent,
        season_id: null,
        start_at: startAt,
        end_at: new Date(startAt.getTime() + 2 * 3600_000),
        venue: 'Demo Field',
        status: 'final',
        home_score: 3,
        away_score: 2
      })
      .execute()
  }
  const settingsGame = makeId('game')
  await db
    .insertInto('games')
    .values({
      id: settingsGame,
      home_team_id: groups.ids.teamA,
      away_team_id: groups.ids.teamB,
      season_id: null,
      start_at: new Date('2026-11-14T19:00:00Z'),
      end_at: new Date('2026-11-14T21:00:00Z'),
      venue: 'Riverside Park',
      exhibition: true
    })
    .execute()
  const seasonGame = makeId('game')
  await db
    .insertInto('games')
    .values({
      id: seasonGame,
      home_team_id: sameSeason,
      away_team_id: groups.ids.teamB,
      season_id: groups.ids.seasonA,
      start_at: new Date('2026-11-21T19:00:00Z'),
      end_at: new Date('2026-11-21T21:00:00Z'),
      venue: 'Riverside Park',
      exhibition: true
    })
    .execute()
  await db
    .insertInto('scope_roles')
    .values({
      id: makeId('scopeRole'),
      scope_type: 'team',
      scope_id: groups.ids.teamB,
      user_id: groups.accounts.owner.userId,
      role: 'admin',
      granted_by: groups.accounts.rival.userId,
      granted_at: new Date()
    })
    .execute()
  for (const [type, title, startAt] of [
    ['practice', 'Morning drills', '2027-01-09T17:00:00Z'],
    ['other', 'Team dinner', '2027-01-12T02:00:00Z']
  ] as const)
    await db
      .insertInto('team_events')
      .values({
        id: makeId('teamEvent'),
        team_id: groups.ids.teamA,
        event_type: type,
        title,
        start_at: new Date(startAt),
        timezone: 'America/Los_Angeles'
      })
      .execute()
  return manifestOf(world, context, groups, {
    sameSeason,
    recentOpponent,
    staleOpponent,
    sameRegion,
    settingsGame,
    seasonGame,
    farCity: far.city,
    ...names
  })
}
