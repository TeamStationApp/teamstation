import { makeId } from '../../../common/ids'
import { createGroup } from '../../groups/createGroup'
import type { MediaContext } from '../../media/mediaContext'
import {
  createAccount,
  type FixtureAccount,
  type FixtureManifest,
  type WorldContext
} from './accounts'

const PEOPLE = {
  admin: { first: 'Babe', last: 'Ruth' },
  eagles: { first: 'Lou', last: 'Gehrig' },
  visitors: { first: 'Cal', last: 'Ripken' }
}

/** How many times each sign-in limit the tess world allows. */
export const RATE_LIMIT_SCALE = 10

/** The six finals: Demo Hawks' runs, then Demo Eagles'. */
export const FINALS: Array<[number, number]> = [
  [5, 3],
  [2, 6],
  [7, 4],
  [4, 4],
  [9, 1],
  [3, 5]
]

/** Saturdays from 6 March 2027, one a week. */
const saturday = (week: number): Date =>
  new Date(Date.UTC(2027, 2, 6 + 7 * week, 18))

const LOCALITY = {
  city: 'Demo City',
  region: 'Demo Region',
  country: 'US',
  placeId: null,
  timezone: 'UTC'
}

/** No group here has a picture, so nothing reads the media settings. */
const NO_MEDIA = {
  mediaRoot: '',
  ffmpegPath: '',
  mediaSecret: '',
  publicUrl: '',
  space: {}
} as unknown as MediaContext

/**
 * What Tess answers about on a phone: the admin's Demo Hawks, in Demo League
 * A's Demo Regular season, with six finals against Demo Eagles, the May 3
 * game and one still to play; Tony Gwynn plays short for Demo Hawks, and
 * Ozzie Smith for Demo Visitors, a team the admin cannot see. The admin
 * umpires in the league, so the header has its button. The names are the
 * ones the scripted model answers with; the ids are this world's own.
 */
export async function runTess(context: WorldContext): Promise<FixtureManifest> {
  const { db, nonce } = context
  const world = 'tess'
  // Each of Tess's scenarios signs in with a new code, and every bench device
  // asks from the same address, which the limit of 20 codes an hour would
  // refuse within a pass. Only a server with test settings reads this.
  await db
    .insertInto('system_settings')
    .values({ key: 'test.rateLimitScale', value: RATE_LIMIT_SCALE })
    .onConflict(oc => oc.column('key').doUpdateSet({ value: RATE_LIMIT_SCALE }))
    .execute()
  const admin = await createAccount(context, world, 'admin', PEOPLE.admin)
  const eagles = await createAccount(context, world, 'eagles', PEOPLE.eagles)
  const visitors = await createAccount(
    context,
    world,
    'visitors',
    PEOPLE.visitors
  )
  let key = 0
  const group = async (
    by: FixtureAccount,
    kind: 'league' | 'season' | 'team',
    name: string,
    parent?: { kind: 'league' | 'season'; id: string }
  ): Promise<string> =>
    (
      await createGroup(
        db,
        { userId: by.userId, isAdmin: false, scopes: [] },
        {
          kind,
          name,
          idempotencyKey: `tess-${nonce}-${++key}`,
          locality: LOCALITY,
          startsOn: '2027-03-01',
          endsOn: '2027-05-31',
          timezone: 'UTC',
          ...(parent == null ? {} : { parent })
        },
        NO_MEDIA
      )
    ).id
  const league = await group(admin, 'league', 'Demo League A')
  const season = await group(admin, 'season', 'Demo Regular', {
    kind: 'league',
    id: league
  })
  await group(admin, 'season', 'Demo Playoffs', { kind: 'league', id: league })
  const eaglesLeague = await group(eagles, 'league', 'Demo League B')
  const eaglesSeason = await group(eagles, 'season', 'Demo Tournament', {
    kind: 'league',
    id: eaglesLeague
  })
  const hawks = await group(admin, 'team', 'Demo Hawks', {
    kind: 'season',
    id: season
  })
  const eaglesTeam = await group(eagles, 'team', 'Demo Eagles', {
    kind: 'season',
    id: eaglesSeason
  })
  const visitorsTeam = await group(visitors, 'team', 'Demo Visitors')

  // The admin umpires in the league, so the header has its button.
  await db
    .insertInto('umpire_types')
    .values([
      {
        id: makeId('umpireType'),
        league_id: league,
        name: 'Plate',
        position: 0
      },
      {
        id: makeId('umpireType'),
        league_id: league,
        name: 'Field',
        position: 1
      }
    ] as never)
    .execute()
  await db
    .updateTable('leagues')
    .set({ umpire_management: true, umpire_credits: true })
    .where('id', '=', league)
    .execute()
  await db
    .insertInto('league_members')
    .values({
      id: makeId('leagueMember'),
      league_id: league,
      user_id: admin.userId as never,
      role: 'member'
    })
    .execute()
  await db
    .insertInto('league_umpires')
    .values({
      league_id: league,
      user_id: admin.userId as never,
      granted_by: admin.userId as never
    })
    .execute()

  // Tony Gwynn on Demo Hawks; Ozzie Smith on a team the admin cannot see.
  const visible = await createAccount(context, world, 'gwynn', {
    first: 'Tony',
    last: 'Gwynn'
  })
  const hidden = await createAccount(context, world, 'smith', {
    first: 'Ozzie',
    last: 'Smith'
  })
  for (const [player, team, jersey] of [
    [visible, hawks, '19'],
    [hidden, visitorsTeam, '1']
  ] as const) {
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: player.userId as never,
        team_id: team,
        role: 'member',
        is_player: true,
        jersey,
        positions: ['SS']
      })
      .execute()
  }
  await db
    .insertInto('season_teams')
    .values(
      [hawks, eaglesTeam].map(team => ({
        season_id: season,
        team_id: team,
        active: true
      }))
    )
    .onConflict(oc => oc.doNothing())
    .execute()

  const finals = FINALS.map(() => makeId('game'))
  for (const [index, [ours, theirs]] of FINALS.entries()) {
    const home = index % 2 === 0
    await db
      .insertInto('games')
      .values({
        id: finals[index],
        home_team_id: home ? hawks : eaglesTeam,
        away_team_id: home ? eaglesTeam : hawks,
        season_id: season,
        start_at: saturday(index),
        end_at: new Date(saturday(index).getTime() + 2 * 3600_000),
        timezone: 'UTC',
        venue: 'Demo Field',
        status: 'final',
        home_score: home ? ours : theirs,
        away_score: home ? theirs : ours
      })
      .execute()
  }
  const may3 = makeId('game')
  const scheduled = makeId('game')
  await db
    .insertInto('games')
    .values([
      {
        id: may3,
        home_team_id: hawks,
        away_team_id: eaglesTeam,
        season_id: season,
        start_at: new Date('2027-05-03T18:00:00Z'),
        end_at: new Date('2027-05-03T20:00:00Z'),
        timezone: 'UTC',
        venue: 'Demo Field',
        status: 'final',
        home_score: 6,
        away_score: 2
      },
      {
        id: scheduled,
        home_team_id: hawks,
        away_team_id: eaglesTeam,
        season_id: season,
        start_at: new Date('2027-05-22T18:00:00Z'),
        end_at: new Date('2027-05-22T20:00:00Z'),
        timezone: 'UTC',
        venue: 'Demo Field',
        status: 'scheduled'
      }
    ])
    .execute()
  return {
    world,
    nonce,
    accounts: { admin, eagles, visitors, gwynn: visible, smith: hidden },
    ids: {
      league,
      season,
      teamA: hawks,
      teamB: eaglesTeam,
      standaloneTeam: visitorsTeam,
      may3,
      scheduled,
      finals: finals.join(','),
      visiblePlayer: visible.userId,
      hiddenPlayer: hidden.userId
    }
  }
}
