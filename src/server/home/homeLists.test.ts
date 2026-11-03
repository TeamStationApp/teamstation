import type { AddressInfo } from 'node:net'

import { expect } from 'chai'
import express from 'express'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { makeId } from '../../common/ids'
import type { Role } from '../../common/roles'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mintUserId } from '../../test/historicalUserIds'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { hashToken } from '../auth/tokens'
import type { Database } from '../db/database'
import { makeDatabase } from '../db/database'
import { jsonBody } from '../jsonBody'
import type { MediaContext } from '../media/mediaContext'
import { withAudit } from '../middleware/withAudit'
import { withActor } from '../middleware/withAuth'
import { errorHandler } from '../middleware/withErrors'
import { groupRoutes } from '../routes/groups'
import { meRoutes } from '../routes/me'
import { seasonRoutes } from '../routes/seasons'
import { teamRoutes } from '../routes/teams'
import { homeLists } from './homeLists'

/**
 * `GET /me/home`: direct ties first, then inherited or admin-only rows,
 * each group by latest game start. A site administrator's home is the
 * same set they would have without that flag.
 */

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_home_lists_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)
const taken = new Set<number>()
const media: MediaContext = {
  mediaRoot: '/tmp',
  ffmpegPath: 'ffmpeg',
  mediaSecret: 'secret',
  publicUrl: 'http://127.0.0.1',
  space: {
    endpoint: '',
    region: '',
    bucket: '',
    accessKeyId: '',
    secretAccessKey: '',
    pathStyle: true
  }
}

interface Row {
  id: string
  name: string
  direct: boolean
  source: string
  kind?: string
  games?: number
  teams?: number
  videos?: number
  externalIds?: string[]
  record?: { w: number; l: number; t: number; seasonName: string | null } | null
}

interface Lists {
  teams: Row[]
  seasons: Row[]
  leagues: Row[]
}

describe('GET /me/home', function () {
  this.timeout(120000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  let server: ReturnType<express.Express['listen']> | undefined
  let base = ''
  const fx: Record<string, string> = {}

  const database = (): Kysely<Database> => {
    if (db == null) throw new Error('no database')
    return db
  }

  before(async function () {
    adminPool = new Pool({ connectionString: adminUrl })
    try {
      await adminPool.query('select 1')
    } catch {
      await adminPool.end()
      adminPool = undefined
      this.skip()
      return
    }
    await adminPool.query(`create database ${scratchName}`)
    const pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    await pool.end()
    db = makeDatabase(scratchUrl)

    const foes = await team('Foes')
    const ball = await team('Ball')
    fx.foes = foes

    const order = await user('Alex Lee')
    fx.order = order.token
    fx.future = await team('Future')
    fx.later = await team('Later')
    fx.alpha = await team('Alpha')
    fx.sameA = await team('Same')
    fx.sameB = await team('Same')
    fx.zebra = await team('Zebra')
    fx.early = await team('Early')
    fx.aaa = await team('Aaa')
    fx.late = await team('Late')
    for (const id of [
      fx.future,
      fx.later,
      fx.alpha,
      fx.sameA,
      fx.sameB,
      fx.zebra,
      fx.early,
      fx.aaa
    ])
      await member(order.id, id)
    await flag(order.id, 'team', fx.late, 'admin')
    await play(fx.future, '2027-06-01T15:00:00Z')
    await play(fx.later, '2026-08-01T15:00:00Z')
    await play(fx.alpha, '2026-06-01T15:00:00Z')
    await play(fx.sameA, '2026-06-01T15:00:00Z')
    await play(fx.sameB, '2026-06-01T15:00:00Z')
    await play(fx.zebra, '2026-06-01T15:00:00Z')
    await play(fx.early, '2020-01-01T15:00:00Z')
    await play(fx.late, '2030-01-01T15:00:00Z')

    const clocks = await user('Jordan Blake')
    fx.clocks = clocks.token
    fx.zuluLeague = await league('Zulu League')
    fx.alphaLeague = await league('Alpha League')
    fx.zuluSeason = await season('Zulu Season', { leagueId: fx.zuluLeague })
    fx.alphaSeason = await season('Alpha Season', { leagueId: fx.alphaLeague })
    await leagueMember(clocks.id, fx.zuluLeague)
    await leagueMember(clocks.id, fx.alphaLeague)
    await play(ball, '2028-04-01T15:00:00Z', fx.zuluSeason)
    await play(ball, '2020-04-01T15:00:00Z', fx.alphaSeason)

    const flags = await user('Sam Rivera')
    fx.flags = flags.token
    fx.coachT = await team('Coach')
    fx.asstT = await team('Assistant')
    fx.scoreT = await team('Score')
    fx.songT = await team('Song')
    fx.videoT = await team('Video')
    await flag(flags.id, 'team', fx.coachT, 'coach')
    await flag(flags.id, 'team', fx.asstT, 'assistant')
    await flag(flags.id, 'team', fx.scoreT, 'scorekeeper')
    await flag(flags.id, 'team', fx.songT, 'songkeeper')
    await flag(flags.id, 'team', fx.videoT, 'videographer')
    fx.seasonCoach = await season('Coached Season')
    fx.teamInSeason = await team('Inherited Team')
    await flag(flags.id, 'season', fx.seasonCoach, 'coach')
    await inSeason(fx.seasonCoach, fx.teamInSeason)
    fx.leagueCoach = await league('Coached League')
    fx.seasonUnderLeague = await season('Under League', {
      leagueId: fx.leagueCoach
    })
    fx.teamUnderLeague = await team('Under League Team')
    await flag(flags.id, 'league', fx.leagueCoach, 'coach')
    await inSeason(fx.seasonUnderLeague, fx.teamUnderLeague)
    fx.seasonAdmin = await season('Admin Season')
    await flag(flags.id, 'season', fx.seasonAdmin, 'admin')
    fx.leagueAdmin = await league('Admin League')
    await flag(flags.id, 'league', fx.leagueAdmin, 'admin')
    fx.seasonMember = await season('Member Season')
    await seasonMember(flags.id, fx.seasonMember)
    await play(ball, '2026-05-01T15:00:00Z', fx.seasonMember)
    fx.leagueMember = await league('Member League')
    await leagueMember(flags.id, fx.leagueMember)
    fx.seasonFollow = await season('Followed Season')
    await follow(flags.id, 'season', fx.seasonFollow)
    fx.leagueFollow = await league('Followed League')
    await follow(flags.id, 'league', fx.leagueFollow)

    const ties = await user('Riley Chen')
    fx.ties = ties.token
    fx.memberT = await team('Member')
    fx.playerT = await team('Player')
    fx.ownerT = await team('Owner')
    fx.managerT = await team('Manager')
    fx.adminT = await team('Admin Only')
    fx.followT = await team('Followed')
    fx.bothT = await team('Both')
    fx.survivor = await team('Survivor')
    const oldA = await team('Old A', { mergedInto: fx.survivor })
    const oldB = await team('Old B', { mergedInto: fx.survivor })
    fx.survivorMem = await team('Survivor Mem')
    const oldMem = await team('Old Mem', { mergedInto: fx.survivorMem })
    fx.externalT = await team('External', { kind: 'external' })
    fx.externalFollow = await team('External Follow', { kind: 'external' })
    await member(ties.id, fx.memberT)
    await member(ties.id, fx.playerT, 'member', true)
    await member(ties.id, fx.ownerT, 'owner')
    await member(ties.id, fx.managerT, 'manager')
    await flag(ties.id, 'team', fx.adminT, 'admin')
    await follow(ties.id, 'team', fx.followT)
    await member(ties.id, fx.bothT)
    await follow(ties.id, 'team', fx.bothT)
    await follow(ties.id, 'team', oldA)
    await follow(ties.id, 'team', oldB)
    await member(ties.id, oldMem)
    await member(ties.id, fx.externalT)
    await follow(ties.id, 'team', fx.externalFollow)
    await follow(ties.id, 'team', makeId('team'))
    await follow(ties.id, 'season', makeId('season'))
    await follow(ties.id, 'league', makeId('league'))
    const spring2024 = await season('Spring 2024', { year: 2024 })
    const spring2025 = await season('Spring 2025', { year: 2025 })
    await play(fx.memberT, '2024-06-01T15:00:00Z', spring2024, {
      home: 1,
      away: 3
    })
    await play(fx.memberT, '2025-06-01T15:00:00Z', spring2025, {
      home: 4,
      away: 2
    })
    await database()
      .insertInto('external_ids')
      .values({
        id: makeId('externalId'),
        entity_type: 'team',
        entity_id: fx.memberT,
        system: 'otherLeague',
        kind: 'team',
        external_id: 'ext-member',
        created_at: new Date()
      })
      .execute()

    const parent = await user('Casey Morgan')
    const child1 = await user('Avery Quinn')
    const child2 = await user('Drew Parker')
    fx.parent = parent.token
    fx.guardTeam = await team('Guard')
    fx.familyTeam = await team('Family')
    await member(child1.id, fx.guardTeam, 'member', true)
    await member(child2.id, fx.familyTeam, 'member', true)
    await link(parent.id, child1.id, 'guardian')
    await link(parent.id, child2.id, 'family')

    const keeper = await user('Eden Brooks')
    const closed = await user('Finn Cole', { mergedInto: keeper.id })
    fx.keeper = keeper.token
    fx.closedSeason = await season('Closed Season')
    fx.closedTeam = await team('Closed Team')
    await seasonMember(closed.id, fx.closedSeason)
    await flag(closed.id, 'team', fx.closedTeam, 'coach')

    const empty = await user('Gray Diaz')
    fx.empty = empty.token

    const disabled = await user('Harper Ellis', { disabled: true })
    fx.disabled = disabled.id
    const disabledTeam = await team('Disabled Team')
    await member(disabled.id, disabledTeam)
    await follow(disabled.id, 'team', await team('Disabled Follow'))

    const mergedKeeper = await user('Indigo Frost')
    const merged = await user('Jules Hart', { mergedInto: mergedKeeper.id })
    fx.merged = merged.id
    await member(merged.id, await team('Merged Team'))

    const site = await user('Kai Nguyen', { admin: true })
    fx.site = site.token
    fx.adminTeam = await team('Direct Team')
    fx.unrelatedTeam = await team('Unrelated Team')
    fx.adminSeason = await season('Direct Season')
    fx.unrelatedSeason = await season('Unrelated Season')
    fx.adminLeague = await league('Direct League')
    fx.unrelatedLeague = await league('Unrelated League')
    await member(site.id, fx.adminTeam)
    await seasonMember(site.id, fx.adminSeason)
    await leagueMember(site.id, fx.adminLeague)

    const app = express()
    app.use(withActor(db))
    app.use(jsonBody)
    app.use(withAudit(db))
    app.use('/api/v1', meRoutes(db, undefined, media))
    app.use('/api/v1', teamRoutes(db, media))
    app.use('/api/v1', seasonRoutes(db, media))
    app.use('/api/v1', groupRoutes(db, media))
    app.use(errorHandler)
    server = app.listen(0, '127.0.0.1')
    await new Promise<void>(resolve => server?.once('listening', resolve))
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`
  })

  after(async function () {
    server?.close()
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(`drop database if exists ${scratchName} with (force)`)
      await adminPool.end()
    }
  })

  async function user(
    name: string,
    opts: { admin?: boolean; disabled?: boolean; mergedInto?: string } = {}
  ): Promise<{ id: string; token: string }> {
    const made = mintUserId(id => taken.has(id))
    taken.add(made.userId)
    const id = userIdOfGumbo(made.userId)
    const now = new Date()
    await insertFixtureUsers(database(), {
      id: made.userId,
      legacyId: made.legacyId,
      display_name: name,
      login_enabled: true,
      is_admin: opts.admin === true,
      ...(opts.disabled === true ? { disabled_at: now } : {}),
      ...(opts.mergedInto != null ? { merged_into: opts.mergedInto } : {}),
      created_at: now,
      updated_at: now
    })
    const token = `tok_home_${made.userId}`
    await database()
      .insertInto('auth_sessions')
      .values({
        id: makeId('authSession'),
        user_id: id,
        token_hash: hashToken(token),
        created_at: now,
        expires_at: new Date(now.getTime() + 3_600_000)
      })
      .execute()
    return { id, token }
  }

  async function team(
    name: string,
    opts: { kind?: 'external'; mergedInto?: string } = {}
  ): Promise<string> {
    const id = makeId('team')
    await database()
      .insertInto('teams')
      .values({
        id,
        name,
        ...(opts.kind != null ? { kind: opts.kind } : {}),
        ...(opts.mergedInto != null ? { merged_into: opts.mergedInto } : {})
      })
      .execute()
    return id
  }

  async function season(
    name: string,
    opts: { leagueId?: string; year?: number } = {}
  ): Promise<string> {
    const id = makeId('season')
    await database()
      .insertInto('seasons')
      .values({
        id,
        name,
        year: opts.year ?? 2026,
        starts_on: '2026-03-01',
        ends_on: '2026-06-30',
        league_id: opts.leagueId ?? null
      })
      .execute()
    return id
  }

  async function league(name: string): Promise<string> {
    const id = makeId('league')
    await database().insertInto('leagues').values({ id, name }).execute()
    return id
  }

  async function play(
    homeId: string,
    start: string,
    seasonId?: string,
    score?: { home: number; away: number }
  ): Promise<void> {
    await database()
      .insertInto('games')
      .values({
        id: makeId('game'),
        home_team_id: homeId,
        away_team_id: fx.foes,
        start_at: new Date(start),
        season_id: seasonId ?? null,
        ...(score == null
          ? {}
          : {
              status: 'final' as const,
              home_score: score.home,
              away_score: score.away
            })
      })
      .execute()
  }

  async function member(
    userId: string,
    teamId: string,
    role: 'owner' | 'manager' | 'member' = 'member',
    isPlayer = false
  ): Promise<void> {
    await database()
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userId,
        team_id: teamId,
        role,
        is_player: isPlayer,
        joined_at: new Date()
      })
      .execute()
  }

  async function flag(
    userId: string,
    scopeType: 'league' | 'season' | 'team',
    scopeId: string,
    role: Role
  ): Promise<void> {
    await database()
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userId,
        scope_type: scopeType,
        scope_id: scopeId,
        role,
        granted_at: new Date()
      })
      .execute()
  }

  async function seasonMember(userId: string, seasonId: string): Promise<void> {
    await database()
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: userId,
        season_id: seasonId,
        joined_at: new Date()
      })
      .execute()
  }

  async function leagueMember(userId: string, leagueId: string): Promise<void> {
    await database()
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        user_id: userId,
        league_id: leagueId,
        joined_at: new Date()
      })
      .execute()
  }

  async function follow(
    userId: string,
    kind: 'league' | 'season' | 'team',
    groupId: string
  ): Promise<void> {
    await database()
      .insertInto('follows')
      .values({ user_id: userId, group_type: kind, group_id: groupId })
      .execute()
  }

  async function link(
    parentId: string,
    childId: string,
    kind: 'guardian' | 'family'
  ): Promise<void> {
    await database()
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: parentId,
        related_user_id: childId,
        kind,
        created_at: new Date()
      })
      .execute()
  }

  async function inSeason(seasonId: string, teamId: string): Promise<void> {
    await database()
      .insertInto('season_teams')
      .values({
        season_id: seasonId,
        team_id: teamId,
        joined_at: new Date()
      })
      .execute()
  }

  async function lists(token: string): Promise<Lists> {
    const response = await fetch(`${base}/me/home`, {
      headers: { authorization: `Bearer ${token}` }
    })
    expect(response.status).equals(200)
    return (await response.json()) as Lists
  }

  function ids(rows: Row[]): string[] {
    return rows.map(row => row.id)
  }

  function partition(rows: Row[], direct: string[], indirect: string[]): void {
    let seenIndirect = false
    for (const row of rows) {
      if (row.direct) expect(seenIndirect, row.name).equals(false)
      else seenIndirect = true
    }
    expect(rows.filter(row => row.direct).map(row => row.id).sort()).deep.equals(
      [...direct].sort()
    )
    expect(
      rows.filter(row => !row.direct).map(row => row.id).sort()
    ).deep.equals([...indirect].sort())
  }

  it('puts a direct team ahead of a later indirect one, then sorts inside the group', async () => {
    const home = await lists(fx.order)
    console.log(
      home.teams
        .map(row => `${row.name} ${row.direct ? 'direct' : 'indirect'}`)
        .join(', ')
    )
    const same = [fx.sameA, fx.sameB].sort((a, b) => a.localeCompare(b))
    expect(ids(home.teams)).deep.equals([
      fx.future,
      fx.later,
      fx.alpha,
      same[0],
      same[1],
      fx.zebra,
      fx.early,
      fx.aaa,
      fx.late
    ])
    expect(home.teams.map(row => row.direct)).deep.equals([
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      true,
      false
    ])
    expect(home.seasons).deep.equals([])
    expect(home.leagues).deep.equals([])
  })

  it('orders a league by the latest game in any of its seasons', async () => {
    const home = await lists(fx.clocks)
    expect(ids(home.leagues)).deep.equals([fx.zuluLeague, fx.alphaLeague])
    expect(home.leagues.every(row => row.direct && row.source === 'member')).equals(
      true
    )
    expect(ids(home.seasons)).deep.equals([fx.zuluSeason, fx.alphaSeason])
    expect(home.seasons.every(row => !row.direct && row.source === 'member')).equals(
      true
    )
    expect(home.teams).deep.equals([])
  })

  it('treats staff flags, memberships and follows as direct, and inheritance or admin as indirect', async () => {
    const home = await lists(fx.flags)
    partition(
      home.teams,
      [fx.coachT, fx.asstT, fx.scoreT, fx.songT, fx.videoT],
      [fx.teamInSeason, fx.teamUnderLeague]
    )
    expect(home.teams.every(row => row.source === 'member')).equals(true)
    partition(
      home.seasons,
      [fx.seasonCoach, fx.seasonMember, fx.seasonFollow],
      [fx.seasonUnderLeague, fx.seasonAdmin]
    )
    const followedSeason = home.seasons.find(row => row.id === fx.seasonFollow)
    expect(followedSeason?.source).equals('follow')
    expect(followedSeason?.kind).equals('season')
    const memberSeason = home.seasons.find(row => row.id === fx.seasonMember)
    expect(memberSeason?.source).equals('member')
    expect(memberSeason?.games).equals(1)
    expect(memberSeason?.videos).equals(0)
    expect(memberSeason?.teams).equals(2)
    partition(
      home.leagues,
      [fx.leagueCoach, fx.leagueMember, fx.leagueFollow],
      [fx.leagueAdmin]
    )
    expect(home.leagues.find(row => row.id === fx.leagueFollow)?.source).equals(
      'follow'
    )
    expect(home.leagues.find(row => row.id === fx.leagueFollow)?.kind).equals(
      'league'
    )
    expect(home.leagues.find(row => row.id === fx.leagueAdmin)?.source).equals(
      'member'
    )
  })

  it('keeps one member row when a follow is also a tie, and drops gone, merged and external rows', async () => {
    const home = await lists(fx.ties)
    partition(
      home.teams,
      [fx.memberT, fx.playerT, fx.followT, fx.bothT, fx.survivor],
      [fx.ownerT, fx.managerT, fx.adminT]
    )
    expect(home.teams.filter(row => row.id === fx.bothT)).length(1)
    expect(home.teams.find(row => row.id === fx.bothT)?.source).equals('member')
    expect(home.teams.find(row => row.id === fx.followT)?.source).equals('follow')
    expect(home.teams.find(row => row.id === fx.followT)?.kind).equals('team')
    expect(home.teams.filter(row => row.id === fx.survivor)).length(1)
    expect(home.teams.find(row => row.id === fx.survivor)?.source).equals(
      'follow'
    )
    expect(home.teams.find(row => row.id === fx.memberT)?.record).deep.equals({
      w: 1,
      l: 0,
      t: 0,
      seasonName: 'Spring 2025'
    })
    expect(home.teams.find(row => row.id === fx.memberT)?.externalIds).deep.equals(
      ['ext-member']
    )
    expect(home.teams.find(row => row.id === fx.playerT)?.record).equals(null)
    expect(home.teams.find(row => row.id === fx.ownerT)?.direct).equals(false)
    expect(home.seasons).deep.equals([])
    expect(home.leagues).deep.equals([])
  })

  it('counts a guardian or family link to a current player as a direct team', async () => {
    const home = await lists(fx.parent)
    partition(home.teams, [fx.guardTeam, fx.familyTeam], [])
    expect(home.teams.every(row => row.source === 'member' && row.direct)).equals(
      true
    )
  })

  it('reads a season membership on a closed id onePerson still includes', async () => {
    const home = await lists(fx.keeper)
    expect(ids(home.seasons)).deep.equals([fx.closedSeason])
    expect(home.seasons[0].direct).equals(true)
    expect(home.seasons[0].source).equals('member')
    expect(ids(home.teams)).deep.equals([])
    expect(home.leagues).deep.equals([])
  })

  it('gives an empty account three empty arrays', async () => {
    expect(await lists(fx.empty)).deep.equals({
      teams: [],
      seasons: [],
      leagues: []
    })
  })

  it('gives a disabled, merged or missing account nothing', async () => {
    const none = { teams: [], seasons: [], leagues: [] }
    expect(await homeLists(database(), fx.disabled, media.space)).deep.equals(none)
    expect(await homeLists(database(), fx.merged, media.space)).deep.equals(none)
    const made = mintUserId(id => taken.has(id))
    expect(
      await homeLists(database(), userIdOfGumbo(made.userId), media.space)
    ).deep.equals(none)
  })

  it('omits rows a site administrator can open only because of that flag', async () => {
    const home = await lists(fx.site)
    console.log(`home teams ${home.teams.map(row => row.name).join(', ')}`)
    expect(ids(home.teams)).deep.equals([fx.adminTeam])
    expect(home.teams[0].direct).equals(true)
    expect(ids(home.seasons)).deep.equals([fx.adminSeason])
    expect(ids(home.leagues)).deep.equals([fx.adminLeague])
    const teams = await fetch(`${base}/teams`, {
      headers: { authorization: `Bearer ${fx.site}` }
    })
    expect(teams.status).equals(200)
    const teamBody = (await teams.json()) as Row[]
    expect(teamBody.some(row => row.id === fx.unrelatedTeam)).equals(true)
    expect(teamBody.some(row => row.id === fx.adminTeam)).equals(true)
    console.log(`GET /teams ${teamBody.map(row => row.name).join(', ')}`)
    const seasons = await fetch(`${base}/seasons`, {
      headers: { authorization: `Bearer ${fx.site}` }
    })
    expect(seasons.status).equals(200)
    const seasonBody = (await seasons.json()) as Row[]
    expect(seasonBody.some(row => row.id === fx.unrelatedSeason)).equals(true)
    const groups = await fetch(`${base}/me/groups`, {
      headers: { authorization: `Bearer ${fx.site}` }
    })
    expect(groups.status).equals(200)
    const groupBody = (await groups.json()) as Row[]
    expect(groupBody.some(row => row.id === fx.unrelatedLeague)).equals(true)
  })
})
