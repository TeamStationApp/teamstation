import type { Server } from 'node:http'

import { expect } from 'chai'
import express from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'
import { Pool } from 'pg'

import {
  asBoxScore,
  asGameDetail,
  asGameSummary,
  asHighlightsResponse,
  asRosterEntry,
  asTeamSummary,
  type RosterEntry
} from '../../common/api'
import { makeId } from '../../common/ids'
import type { Role } from '../../common/roles'
import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import {
  type GuardianFixture,
  guardianFixture
} from '../../test/guardianFixture'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { guardiansOf } from '../access'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { errorHandler } from '../middleware/withErrors'
import { teamRoutes } from '../routes/teams'

const adminUrl =
  process.env.TS_TEST_DATABASE_URL ?? 'postgres://localhost:5433/postgres'
const name = `AppDb_scoringUiUpdates_roster_${Date.now()}`
const url = new URL(adminUrl)
url.pathname = `/${name}`
describe('scoring roster HTTP contract', function () {
  this.timeout(60000)
  let admin: Pool
  let db: Kysely<Database> | undefined
  let server: Server | undefined
  let address: string
  let created = false
  const team = makeId('team')
  const season = makeId('season')
  const opponent = makeId('team')
  const game = makeId('game')
  const video = makeId('video')
  const child = 1
  const coach = 2
  const seasonMember = 3
  const outsider = 4
  before(async function () {
    attachInt8Parser()
    admin = new Pool({ connectionString: adminUrl })
    await admin.query(`create database "${name}"`)
    created = true
    const pool = new Pool({ connectionString: url.href })
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })
    await migrateUp(pool, migrations)
    await db
      .insertInto('teams')
      .values([
        { id: team, name: 'Owls' },
        { id: opponent, name: 'Hawks' }
      ])
      .execute()
    await db
      .insertInto('seasons')
      .values({ id: season, name: 'Fall', year: 2026 })
      .execute()
    await db
      .insertInto('season_teams')
      .values({ team_id: team, season_id: season })
      .execute()
    // This fixture explicitly models management in addition to competition.

    await db
      .insertInto('season_team_parents')
      .values({ team_id: team, season_id: season })
      .execute()
    await insertFixtureUsers(db, [
      {
        id: userIdOfGumbo(child),
        legacyId: 'usr_child',
        display_name: 'Jordan King',
        first_name: 'Jordan',
        last_name: 'King',
        bats: 'switch',
        throws: 'left'
      },
      {
        id: userIdOfGumbo(coach),
        legacyId: 'usr_coach',
        display_name: 'Alex Coach',
        bats: null,
        throws: null
      },
      {
        id: userIdOfGumbo(seasonMember),
        legacyId: 'usr_season_member',
        display_name: 'Frank Fan',
        bats: 'left',
        throws: 'right'
      },
      {
        id: userIdOfGumbo(outsider),
        legacyId: 'usr_outsider',
        display_name: 'Outsider'
      }
    ])
    await db
      .insertInto('memberships')
      .values([
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(child),
          team_id: team,
          is_player: true,
          jersey: '00',
          positions: ['P', 'SS']
        },
        {
          id: makeId('membership'),
          user_id: userIdOfGumbo(coach),
          team_id: team,
          role: 'manager'
        }
      ])
      .execute()
    await db
      .insertInto('season_members')
      .values([
        {
          id: 'membership-season-member',
          season_id: season,
          user_id: userIdOfGumbo(seasonMember)
        },
        {
          id: 'membership-child',
          season_id: season,
          user_id: userIdOfGumbo(child)
        }
      ])
      .execute()
    await db
      .insertInto('games')
      .values({
        id: game,
        home_team_id: opponent,
        away_team_id: team,
        season_id: season,
        start_at: new Date('2026-09-22T10:00:00Z'),
        ingest_status: 'ok'
      })
      .execute()
    await db
      .insertInto('videos')
      .values({
        id: video,
        game_id: game,
        kind: 'program',
        title: 'Game',
        storage: 'peertube',
        status: 'unavailable',
        duration_sec: 120,
        start_at: new Date('2026-09-22T10:00:00Z')
      })
      .execute()
    await db
      .insertInto('game_player_stats')
      .values({
        id: 'stat-child',
        game_id: game,
        gumbo_id: child,
        team_id: team,
        pa: 2,
        ab: 2,
        h: 1,
        singles: 1,
        pitch_bf: 4,
        pitch_outs: 3,
        pitch_h: 1
      })
      .execute()
    await db
      .insertInto('events')
      .values({
        id: 'event-single',
        gameId: game,
        startTime: new Date('2026-09-22T10:00:30Z'),
        battingTeamId: team,
        titleOverride: 'Single: Jordan K',
        gumbo: JSON.stringify({
          about: { atBatIndex: 0, inning: 1, halfInning: 'top' },
          result: { eventType: 'single', description: 'Jordan singles.' }
        })
      })
      .execute()
    const app = express()
    app.use((req, _res, next) => {
      const id = req.header('x-test-user')
      if (id != null)
        req.actor = {
          userId: userIdOfGumbo(Number(id)),
          isAdmin: false,
          scopes: []
        }
      next()
    })
    app.use(
      teamRoutes(db, {
        mediaRoot: '',
        ffmpegPath: '',
        mediaSecret: 'test',
        publicUrl: 'http://localhost',
        space: {
          endpoint: '',
          region: '',
          bucket: '',
          accessKeyId: '',
          secretAccessKey: ''
        }
      })
    )
    app.use(errorHandler)
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => {
        resolve(listening)
      })
    })
    const bound = server.address()
    if (bound == null || typeof bound === 'string')
      throw new Error('Missing test port')
    address = `http://127.0.0.1:${bound.port}/teams/${team}/roster`
  })
  after(async function () {
    await new Promise<void>((resolve, reject) => {
      if (server == null) {
        resolve()
        return
      }
      server.close(error => {
        if (error != null) reject(error)
        else resolve()
      })
    })
    await db?.destroy()
    if (created) await admin.query(`drop database "${name}"`)
    await admin?.end()
  })
  it('returns handedness and exact ids for the team\u2019s members and its season\u2019s, the manager first', async function () {
    const response = await fetch(address, {
      headers: { 'x-test-user': String(coach) }
    })
    expect(response.status).equals(200)
    const raw: unknown = await response.json()
    if (!Array.isArray(raw)) throw new Error('Expected roster array')
    const roster = raw.map(asRosterEntry)
    expect(roster.map(row => row.section)).deep.equals([
      'admin',
      'player',
      'spectator'
    ])
    // A player who is a member of the season too is a player.
    expect(roster[1].inheritedFrom).equals(null)
    expect(roster[1]).includes({
      userId: userIdOfGumbo(child),
      shortName: 'Jordan K',
      jersey: '00',
      bats: 'switch',
      throws: 'left',
      isPlayer: true
    })
    expect(roster[1].positions).deep.equals(['P', 'SS'])
    // A member of the season is a member of its teams, with no place on them.
    expect(roster[2]).includes({
      userId: userIdOfGumbo(seasonMember),
      gumboId: seasonMember,
      shortName: 'Frank F',
      bats: 'left',
      throws: 'right',
      isPlayer: false,
      role: 'member',
      jersey: null
    })
    expect(roster[2].inheritedFrom).deep.equals({
      level: 'season',
      role: 'member'
    })
    expect(roster[0]).includes({ bats: null, throws: null })
    // They read the roster as a member does; somebody in neither the team
    // nor its season reads the same people in the non-member view, every
    // name and no face.
    const asMember = await fetch(address, {
      headers: { 'x-test-user': String(seasonMember) }
    })
    expect(asMember.status).equals(200)
    expect(
      ((await asMember.json()) as unknown[]).map(asRosterEntry)
    ).deep.equals(roster)
    const outsideResponse = await fetch(address, {
      headers: { 'x-test-user': String(outsider) }
    })
    expect(outsideResponse.status).equals(200)
    const outside = ((await outsideResponse.json()) as unknown[]).map(
      asRosterEntry
    )
    expect(outside.map(row => row.userId)).deep.equals(
      roster.map(row => row.userId)
    )
    expect(outside.every(row => row.avatarUrl === null)).equals(true)
  })
  it('includes private names only for players in an authorized management read', async function () {
    const response = await fetch(address + '?includeFullNames=true', {
      headers: { 'x-test-user': String(coach) }
    })
    expect(response.status).equals(200)
    const rows = ((await response.json()) as unknown[]).map(asRosterEntry)
    expect(
      rows.find(row => row.userId === userIdOfGumbo(child))?.nameDetails
    ).not.equals(undefined)
    expect(
      rows
        .filter(row => !row.isPlayer)
        .every(row => row.nameDetails === undefined)
    ).equals(true)
  })
  it('keeps existing team/game/video/box-score reads working after roster extraction', async function () {
    const origin = new URL(address).origin
    const get = async (path: string): Promise<unknown> => {
      const response = await fetch(origin + path, {
        headers: { 'x-test-user': String(coach) }
      })
      expect(response.status, path).equals(200)
      return await response.json()
    }
    const teams = await get('/teams')
    if (!Array.isArray(teams)) throw new Error('Expected team list')
    expect(teams.map(asTeamSummary).map(row => row.id)).deep.equals([team])
    const games = await get(`/teams/${team}/games`)
    if (!Array.isArray(games)) throw new Error('Expected game list')
    const listed = games.map(asGameSummary)
    expect(listed[0]).includes({
      id: game,
      homeTeamName: 'Hawks',
      awayTeamName: 'Owls',
      videoCount: 1
    })
    const raw = await get(`/games/${game}`)
    expect(raw).to.have.property('scoringOwner', null)
    const detail = asGameDetail(raw)
    expect(detail.scoringOwner).equals(null)
    expect(detail.videos[0]).includes({ id: video, status: 'unavailable' })
    const box = asBoxScore(await get(`/games/${game}/box-score`))
    expect(box.batting[0]).includes({
      userId: userIdOfGumbo(child),
      shortName: 'Jordan K',
      h: 1,
      ab: 2,
      seasonAvg: 0.5
    })
    expect(box.pitching[0]).includes({
      userId: userIdOfGumbo(child),
      ip: '1.0'
    })
    const stats = await get(`/teams/${team}/stats?seasonId=${season}`)
    expect(stats).is.an('array')
    const highlights = asHighlightsResponse(
      await get(`/videos/${video}/highlights`)
    )
    expect(highlights.highlights).is.an('array')
    // Somebody signed in who is not a member reads the non-member view: the
    // game, the schedule and the highlights, and 403 for what is kept for
    // members.
    for (const [path, status] of [
      [`/games/${game}`, 200],
      [`/games/${game}/box-score`, 403],
      [`/teams/${team}/games`, 200],
      [`/teams/${team}/stats`, 403],
      [`/videos/${video}/highlights`, 200]
    ] as const) {
      expect(
        (
          await fetch(origin + path, {
            headers: { 'x-test-user': String(outsider) }
          })
        ).status,
        path
      ).equals(status)
    }
  })
  it('carries each player\u2019s walk-up song on this team, and no other team\u2019s', async function () {
    const song = {
      provider: 'appleMusic' as const,
      provider_id: '1440857781',
      isrc: null,
      title: 'Centerfield',
      artist: 'John Fogerty',
      album: null,
      artwork_url: null,
      duration_ms: 230000,
      start_ms: 10000,
      end_ms: 25000,
      set_by: userIdOfGumbo(coach)
    }
    await db!
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userIdOfGumbo(child),
        team_id: opponent,
        is_player: true
      })
      .execute()
    await db!
      .insertInto('walk_up_songs')
      .values([
        { ...song, team_id: team, user_id: userIdOfGumbo(child) },
        {
          ...song,
          team_id: opponent,
          user_id: userIdOfGumbo(child),
          provider: 'localFile',
          provider_id: 'lf:0123456789abcdef',
          title: 'Walkup Fixture',
          artist: 'TeamStation'
        }
      ])
      .execute()
    const read = async (path: string): Promise<unknown> => {
      const response = await fetch(new URL(address).origin + path, {
        headers: { 'x-test-user': String(child) }
      })
      expect(response.status, path).equals(200)
      return await response.json()
    }
    const here = await read(`/teams/${team}/roster`)
    // Still a bare array.
    if (!Array.isArray(here)) throw new Error('Expected roster array')
    const roster = here.map(asRosterEntry)
    const byUser = new Map(roster.map(row => [row.userId, row.walkUpSong]))
    expect(byUser.get(userIdOfGumbo(child))).deep.equals({
      provider: 'appleMusic',
      providerId: '1440857781',
      isrc: null,
      title: 'Centerfield',
      artist: 'John Fogerty',
      album: null,
      artworkUrl: null,
      durationMs: 230000,
      startMs: 10000,
      endMs: 25000
    })
    expect(byUser.get(userIdOfGumbo(coach))).equals(null)
    expect(byUser.get(userIdOfGumbo(seasonMember))).equals(null)
    const there = await read(`/teams/${opponent}/roster`)
    if (!Array.isArray(there)) throw new Error('Expected roster array')
    const theirs = there.map(asRosterEntry)
    expect(
      theirs.find(row => row.userId === userIdOfGumbo(child))?.walkUpSong
    ).to.include({
      provider: 'localFile',
      providerId: 'lf:0123456789abcdef',
      title: 'Walkup Fixture'
    })
  })
  it('refuses nobody signed in, and shows an outsider names without faces, or 404 for a team that is not there', async function () {
    expect((await fetch(address)).status).equals(401)
    const outside = await fetch(address, {
      headers: { 'x-test-user': String(outsider) }
    })
    expect(outside.status).equals(200)
    expect(
      ((await outside.json()) as unknown[])
        .map(asRosterEntry)
        .every(row => row.avatarUrl === null)
    ).equals(true)
    expect(
      (
        await fetch(address.replace(`/teams/${team}/`, '/teams/tem_missing/'), {
          headers: { 'x-test-user': String(outsider) }
        })
      ).status
    ).equals(404)
  })
})

describe('roster sections', function () {
  this.timeout(60000)
  let f: GuardianFixture
  beforeEach(async () => {
    f = await guardianFixture()
  })
  afterEach(async () => {
    await f?.h.close()
  })

  const read = async (): Promise<{
    raw: Array<Record<string, unknown>>
    roster: RosterEntry[]
  }> => {
    const response = await f.h.request(
      'GET',
      `/teams/${f.teamA}/roster`,
      undefined,
      f.people.admin
    )
    expect(response.status).equals(200)
    const raw = (await response.json()) as Array<Record<string, unknown>>
    return { raw, roster: raw.map(asRosterEntry) }
  }
  /** Each entry as `[userId, section, inheritedFrom]`, in roster order. */
  const placed = (
    roster: RosterEntry[]
  ): Array<[string, string, RosterEntry['inheritedFrom']]> =>
    roster.map(row => [row.userId, row.section, row.inheritedFrom])
  const user = async (
    id: number,
    name: string,
    mergedInto: number | null = null
  ): Promise<void> => {
    const [first, last] = name.split(' ')
    await insertFixtureUsers(f.h.db, {
      id,
      legacyId: `usr_roster_${id}`,
      display_name: name,
      first_name: first,
      last_name: last,
      merged_into: mergedInto == null ? null : userIdOfGumbo(mergedInto)
    })
  }
  const link = async (guardian: number, player: number): Promise<void> => {
    await f.h.db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: userIdOfGumbo(guardian),
        related_user_id: userIdOfGumbo(player),
        kind: 'guardian',
        can_manage: true,
        created_at: new Date()
      })
      .execute()
  }
  const give = async (
    userId: number,
    scopeType: 'league' | 'season' | 'team',
    scopeId: string,
    role: Role
  ): Promise<void> => {
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: userIdOfGumbo(userId),
        scope_type: scopeType,
        scope_id: scopeId,
        role,
        granted_by: userIdOfGumbo(f.people.admin),
        granted_at: new Date()
      })
      .execute()
  }

  it('orders identical roster labels by canonical id while retaining section priority', async function () {
    const ids = [35, 34, 33]
    for (const id of ids) {
      await user(id, 'Mookie Betts')
      await f.h.db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userIdOfGumbo(id),
          team_id: f.teamA,
          is_player: true
        })
        .execute()
    }
    const { roster } = await read()
    const added = roster.filter(row =>
      ids.map(userIdOfGumbo).includes(row.userId)
    )
    expect(added.map(row => row.userId)).deep.equals(
      [33, 34, 35].map(userIdOfGumbo)
    )
    expect(new Set(added.map(row => row.shortName)).size).equals(1)
    expect(added.every(row => row.section === 'player')).equals(true)
    expect(roster.findIndex(row => row.section === 'admin')).lessThan(
      roster.findIndex(row => row.userId === userIdOfGumbo(33))
    )
  })

  it('lists admins, staff, players, family, spectators and followers, each once', async function () {
    // A member who neither plays nor holds a role.
    await user(230, 'Pat Lane')
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userIdOfGumbo(230),
        team_id: f.teamA,
        role: 'member',
        is_player: false
      })
      .execute()
    await f.h.db
      .updateTable('users')
      .set({ bats: 'left', throws: 'right' })
      .where('id', '=', userIdOfGumbo(f.people.guardian))
      .execute()

    const { raw, roster } = await read()
    const { admin, seasonCoach, teamCoach, assistant, scorekeeper } = f.people
    expect(placed(roster)).deep.equals(
      [
        [admin, 'admin', { level: 'league', role: 'admin' }],
        // The team's own staff by name, then the season's.
        [teamCoach, 'staff', null],
        [scorekeeper, 'staff', null],
        [assistant, 'staff', null],
        [seasonCoach, 'staff', { level: 'season', role: 'coach' }],
        [201, 'player', null],
        [202, 'player', null],
        [203, 'player', null],
        [204, 'player', null],
        [205, 'player', null],
        [f.people.guardian, 'family', null],
        [230, 'spectator', null],
        [f.people.follower, 'follower', null]
      ].map(([id, ...rest]) => [userIdOfGumbo(id as number), ...rest])
    )
    const byUser = new Map(roster.map(row => [row.userId, row]))
    expect(byUser.get(userIdOfGumbo(teamCoach))?.staffRoles).deep.equals([
      'coach'
    ])
    expect(byUser.get(userIdOfGumbo(assistant))?.staffRoles).deep.equals([
      'assistant'
    ])
    expect(byUser.get(userIdOfGumbo(scorekeeper))?.staffRoles).deep.equals([
      'scorekeeper'
    ])
    expect(byUser.get(userIdOfGumbo(seasonCoach))?.staffRoles).deep.equals([
      'coach'
    ])
    expect(byUser.get(userIdOfGumbo(admin))?.staffRoles).deep.equals([])
    expect(byUser.get(userIdOfGumbo(201))).to.include({
      shortName: 'Avery S',
      jersey: '7',
      isPlayer: true
    })
    // A guardian, a season coach and a follower have no place on the team.
    for (const id of [f.people.guardian, seasonCoach, f.people.follower])
      expect(byUser.get(userIdOfGumbo(id))).to.include({
        role: 'member',
        isPlayer: false,
        jersey: null,
        walkUpSong: null
      })
    expect(byUser.get(userIdOfGumbo(f.people.guardian))).to.include({
      shortName: 'Tim R',
      bats: 'left',
      throws: 'right'
    })
    expect(byUser.get(userIdOfGumbo(f.people.guardian))?.positions).deep.equals(
      []
    )
    expect(byUser.get(userIdOfGumbo(230))?.staffRoles).deep.equals([])
    for (const entry of raw) expect(entry).not.to.have.property('group')
  })

  it('lists the members of the team\u2019s season and league as spectators after its own, pilled with the level', async function () {
    const member = async (
      userId: number,
      level: 'season' | 'league'
    ): Promise<void> => {
      if (level === 'season')
        await f.h.db
          .insertInto('season_members')
          .values({
            id: makeId('seasonMember'),
            user_id: userIdOfGumbo(userId),
            season_id: f.seasonA
          })
          .execute()
      else
        await f.h.db
          .insertInto('league_members')
          .values({
            id: makeId('leagueMember'),
            user_id: userIdOfGumbo(userId),
            league_id: f.leagueA
          })
          .execute()
    }
    // One of the team's own, and a member of each level above it.
    await user(230, 'Pat Lane')
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userIdOfGumbo(230),
        team_id: f.teamA,
        role: 'member'
      })
      .execute()
    await user(250, 'Sid Stone')
    await member(250, 'season')
    await user(251, 'Lou Lark')
    await member(251, 'league')
    // Both: the league is the higher.
    await user(252, 'Bea Bell')
    await member(252, 'season')
    await member(252, 'league')
    // Through a row since closed into the one they sign in as.
    await user(254, 'Cy Cole')
    await user(253, 'Cy Cole', 254)
    await member(253, 'season')
    // A disabled member is nobody's spectator.
    await user(255, 'Di Dorn')
    await member(255, 'season')
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', userIdOfGumbo(255))
      .execute()
    // A player, a guardian and a coach keep the place they had.
    for (const id of [201, f.people.guardian, f.people.teamCoach])
      await member(id, 'season')

    const { roster } = await read()
    expect(
      placed(roster.filter(row => row.section === 'spectator'))
    ).deep.equals(
      [
        [230, 'spectator', null],
        // Then by name: Bea B, Cy C, Lou L, Sid S.
        [252, 'spectator', { level: 'league', role: 'member' }],
        [254, 'spectator', { level: 'season', role: 'member' }],
        [251, 'spectator', { level: 'league', role: 'member' }],
        [250, 'spectator', { level: 'season', role: 'member' }]
      ].map(([id, ...rest]) => [userIdOfGumbo(id as number), ...rest])
    )
    const byUser = new Map(roster.map(row => [row.userId, row]))
    expect(byUser.get(userIdOfGumbo(201))).to.include({
      section: 'player',
      inheritedFrom: null
    })
    expect(byUser.get(userIdOfGumbo(f.people.guardian))).to.include({
      section: 'family',
      inheritedFrom: null
    })
    // Under a family member, the players here they guard, by short name;
    // nobody else carries the field.
    expect(
      byUser.get(userIdOfGumbo(f.people.guardian))?.guardianOf
    ).deep.equals(['Avery S'])
    expect(byUser.get(userIdOfGumbo(201))?.guardianOf).equals(undefined)
    expect(byUser.get(userIdOfGumbo(f.people.teamCoach))).to.include({
      section: 'staff',
      inheritedFrom: null
    })
    for (const id of [253, 255])
      expect(byUser.has(userIdOfGumbo(id)), String(id)).equals(false)
    expect(byUser.get(userIdOfGumbo(250))).to.include({
      role: 'member',
      isPlayer: false,
      jersey: null,
      walkUpSong: null
    })
  })

  it('lists followers last, through a team merged into this one, never twice and never a disabled one', async function () {
    const follow = async (
      userId: number,
      groupId: string,
      groupType: 'league' | 'season' | 'team' = 'team'
    ): Promise<void> => {
      await f.h.db
        .insertInto('follows')
        .values({
          user_id: userIdOfGumbo(userId),
          group_type: groupType,
          group_id: groupId
        })
        .execute()
    }
    await user(260, 'Fay Ford')
    await follow(260, f.teamA)
    // A follow of a team since merged into this one.
    await f.h.db
      .insertInto('teams')
      .values({ id: 'tem_roster_old', name: 'Old Hawks', merged_into: f.teamA })
      .execute()
    await user(261, 'Mo Marsh')
    await follow(261, 'tem_roster_old')
    // A member who follows too is a spectator, and a player a player.
    await user(230, 'Pat Lane')
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: userIdOfGumbo(230),
        team_id: f.teamA,
        role: 'member'
      })
      .execute()
    await follow(230, f.teamA)
    await follow(201, f.teamA)
    // Nobody disabled, no closed row, and no follower of the season alone.
    await user(262, 'Dee Dale')
    await follow(262, f.teamA)
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: new Date() })
      .where('id', '=', userIdOfGumbo(262))
      .execute()
    await user(264, 'Gus Gray')
    await user(263, 'Gus Gray', 264)
    await follow(263, f.teamA)
    await user(265, 'Sue Shaw')
    await follow(265, f.seasonA, 'season')

    const { roster } = await read()
    // By name: Fay F, Grace H, Mo M; and last.
    expect(placed(roster.slice(-3))).deep.equals(
      [
        [260, 'follower', null],
        [f.people.follower, 'follower', null],
        [261, 'follower', null]
      ].map(([id, ...rest]) => [userIdOfGumbo(id as number), ...rest])
    )
    expect(roster.filter(row => row.section === 'follower')).to.have.length(3)
    expect(
      roster.filter(row => row.userId === userIdOfGumbo(230))
    ).to.have.length(1)
    expect(
      roster.find(row => row.userId === userIdOfGumbo(230))?.section
    ).equals('spectator')
    expect(
      roster.filter(row => row.userId === userIdOfGumbo(201))
    ).to.have.length(1)
    expect(
      roster.find(row => row.userId === userIdOfGumbo(201))?.section
    ).equals('player')
    for (const id of [262, 263, 264, 265])
      expect(
        roster.some(row => row.userId === userIdOfGumbo(id)),
        String(id)
      ).equals(false)

    // Somebody who is not a member reads the followers too, with no faces.
    const response = await f.h.request(
      'GET',
      `/teams/${f.teamA}/roster`,
      undefined,
      f.people.oneTeam
    )
    expect(response.status).equals(200)
    const outside = ((await response.json()) as unknown[]).map(asRosterEntry)
    expect(outside.map(row => [row.userId, row.section])).deep.equals(
      roster.map(row => [row.userId, row.section])
    )
    expect(outside.every(row => row.avatarUrl === null)).equals(true)
  })

  it('lists a coach who is also a guardian once, under Staff', async function () {
    await link(f.people.teamCoach, 202)
    const { roster } = await read()
    const coach = roster.filter(
      row => row.userId === userIdOfGumbo(f.people.teamCoach)
    )
    expect(coach).to.have.length(1)
    expect(coach[0]).to.include({ section: 'staff', inheritedFrom: null })
    expect(
      roster.filter(row => row.section === 'family').map(row => row.userId)
    ).deep.equals([f.people.guardian].map(userIdOfGumbo))
  })

  it('pills the highest level holding the placing role, and only that role', async function () {
    const { teamCoach, assistant, scorekeeper, seasonCoach } = f.people
    // A team coach who coaches the whole league too.
    await give(teamCoach, 'league', f.leagueA, 'coach')
    // An assistant of the team who keeps score for the league: the
    // assistant flag places them, and that is the team's.
    await give(assistant, 'league', f.leagueA, 'scorekeeper')
    const { roster } = await read()
    expect(placed(roster.filter(row => row.section === 'staff'))).deep.equals(
      [
        [scorekeeper, 'staff', null],
        [assistant, 'staff', null],
        [teamCoach, 'staff', { level: 'league', role: 'coach' }],
        [seasonCoach, 'staff', { level: 'season', role: 'coach' }]
      ].map(([id, ...rest]) => [userIdOfGumbo(id as number), ...rest])
    )
    const byUser = new Map(roster.map(row => [row.userId, row]))
    expect(byUser.get(userIdOfGumbo(assistant))?.staffRoles).deep.equals([
      'assistant',
      'scorekeeper'
    ])
    expect(byUser.get(userIdOfGumbo(teamCoach))?.staffRoles).deep.equals([
      'coach'
    ])
  })

  it('lists a player\u2019s guardians across merged rows, by the row each signs in as', async function () {
    // A guardian whose link was made from a row since closed into another.
    await user(241, 'Rae Moon')
    await user(240, 'Rae Moon', 241)
    await link(240, 203)
    // A link to a row of Drew's that was closed into him.
    await user(243, 'Sam Vale')
    await user(242, 'Drew Ellis', 204)
    await link(243, 242)
    // A row of Eli's linked to Eli is Eli, not a parent of his.
    await user(244, 'Eli Fox', 205)
    await link(244, 205)

    const { roster } = await read()
    // By name: Rae M, Sam V, Tim R.
    expect(
      roster.filter(row => row.section === 'family').map(row => row.userId)
    ).deep.equals([241, 243, f.people.guardian].map(userIdOfGumbo))
    for (const id of [240, 242, 244])
      expect(roster.some(row => row.userId === userIdOfGumbo(id))).equals(false)
    expect(
      await guardiansOf(f.h.db, [
        userIdOfGumbo(205),
        userIdOfGumbo(204),
        userIdOfGumbo(203),
        userIdOfGumbo(204)
      ])
    ).deep.equals([241, 243].map(userIdOfGumbo))
  })

  it('leaves out a disabled guardian or inherited staff member, and keeps a disabled member', async function () {
    const { guardian, seasonCoach, scorekeeper } = f.people
    const disable = async (id: number): Promise<void> => {
      await f.h.db
        .updateTable('users')
        .set({ disabled_at: new Date() })
        .where('id', '=', userIdOfGumbo(id))
        .execute()
    }
    const before = (await read()).roster.map(row => row.userId)
    for (const id of [guardian, seasonCoach, scorekeeper])
      expect(before, String(id)).includes(userIdOfGumbo(id))
    await disable(guardian)
    await disable(seasonCoach)
    await disable(scorekeeper)

    const { roster } = await read()
    // Neither is on the team: their account was all that listed them.
    expect(roster.some(row => row.userId === userIdOfGumbo(guardian))).equals(
      false
    )
    expect(
      roster.some(row => row.userId === userIdOfGumbo(seasonCoach))
    ).equals(false)
    expect(roster.filter(row => row.section === 'family')).deep.equals([])
    // A member stays, as before, though the role no longer counts.
    expect(
      roster.some(row => row.userId === userIdOfGumbo(scorekeeper))
    ).equals(true)
    expect(await guardiansOf(f.h.db, [userIdOfGumbo(201)])).deep.equals([])
  })
})
