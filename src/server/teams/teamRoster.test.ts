import type { Server } from 'node:http'

import { expect } from 'chai'
import express from 'express'
import { Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import {
  asBoxScore,
  asGameDetail,
  asGameSummary,
  asHighlightsResponse,
  asRosterEntry,
  asTeamSummary
} from '../../common/api'
import { makeId } from '../../common/ids'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import type { Database } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import { errorHandler } from '../middleware/withErrors'
import { teamRoutes } from '../routes/teams'

const adminUrl =
  process.env.GS_TEST_DATABASE_URL ?? 'postgres://localhost:5433/postgres'
const name = `GameStation_scoringUiUpdates_roster_${Date.now()}`
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
  const follower = 3
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
    await db
      .insertInto('users')
      .values([
        {
          id: child,
          legacyId: 'usr_child',
          display_name: 'Jordan King',
          first_name: 'Jordan',
          last_name: 'King',
          bats: 'switch',
          throws: 'left'
        },
        {
          id: coach,
          legacyId: 'usr_coach',
          display_name: 'Alex Coach',
          bats: null,
          throws: null
        },
        {
          id: follower,
          legacyId: 'usr_follower',
          display_name: 'Frank Fan',
          bats: 'left',
          throws: 'right'
        },
        { id: outsider, legacyId: 'usr_outsider', display_name: 'Outsider' }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values([
        {
          id: makeId('membership'),
          user_id: child,
          team_id: team,
          is_player: true,
          jersey: '00',
          positions: ['P', 'SS']
        },
        {
          id: makeId('membership'),
          user_id: coach,
          team_id: team,
          role: 'manager'
        }
      ])
      .execute()
    await db
      .insertInto('season_members')
      .values([
        {
          id: 'membership-follower',
          season_id: season,
          user_id: follower,
          role: 'spectator'
        },
        {
          id: 'membership-child',
          season_id: season,
          user_id: child,
          role: 'spectator'
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
        user_id: child,
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
        req.actor = { userId: Number(id), isAdmin: false, scopes: [] }
      next()
    })
    app.use(
      teamRoutes(db, {
        mediaRoot: '',
        workDir: '',
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
  it('returns handedness and exact ids for members and followers in the existing group order', async function () {
    const response = await fetch(address, {
      headers: { 'x-test-user': String(coach) }
    })
    expect(response.status).equals(200)
    const raw: unknown = await response.json()
    if (!Array.isArray(raw)) throw new Error('Expected roster array')
    const roster = raw.map(asRosterEntry)
    expect(roster.map(row => row.group)).deep.equals([
      'coach',
      'player',
      'follower'
    ])
    expect(roster[1]).includes({
      userId: child,
      shortName: 'Jordan K',
      jersey: '00',
      bats: 'switch',
      throws: 'left',
      isPlayer: true
    })
    expect(roster[1].positions).deep.equals(['P', 'SS'])
    expect(roster[2]).includes({
      userId: follower,
      bats: 'left',
      throws: 'right',
      isPlayer: false
    })
    expect(roster[0]).includes({ bats: null, throws: null })
    const followerResponse = await fetch(address, {
      headers: { 'x-test-user': String(follower) }
    })
    expect(followerResponse.status).equals(200)
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
      userId: child,
      shortName: 'Jordan K',
      h: 1,
      ab: 2,
      seasonAvg: 0.5
    })
    expect(box.pitching[0]).includes({ userId: child, ip: '1.0' })
    const stats = await get(`/teams/${team}/stats?seasonId=${season}`)
    expect(stats).is.an('array')
    const highlights = asHighlightsResponse(
      await get(`/videos/${video}/highlights`)
    )
    expect(highlights.highlights).is.an('array')
    for (const path of [
      `/games/${game}`,
      `/games/${game}/box-score`,
      `/teams/${team}/games`,
      `/teams/${team}/stats`,
      `/videos/${video}/highlights`
    ]) {
      expect(
        (
          await fetch(origin + path, {
            headers: { 'x-test-user': String(outsider) }
          })
        ).status
      ).equals(404)
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
      set_by: coach
    }
    await db!
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: child,
        team_id: opponent,
        is_player: true
      })
      .execute()
    await db!
      .insertInto('walk_up_songs')
      .values([
        { ...song, team_id: team, user_id: child },
        {
          ...song,
          team_id: opponent,
          user_id: child,
          provider: 'localFile',
          provider_id: 'lf:0123456789abcdef',
          title: 'Walkup Fixture',
          artist: 'GameStation'
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
    expect(byUser.get(child)).deep.equals({
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
    expect(byUser.get(coach)).equals(null)
    expect(byUser.get(follower)).equals(null)
    const there = await read(`/teams/${opponent}/roster`)
    if (!Array.isArray(there)) throw new Error('Expected roster array')
    const theirs = there.map(asRosterEntry)
    expect(theirs.find(row => row.userId === child)?.walkUpSong).to.include({
      provider: 'localFile',
      providerId: 'lf:0123456789abcdef',
      title: 'Walkup Fixture'
    })
  })
  it('preserves authorization and does not reveal a hidden team roster', async function () {
    expect((await fetch(address)).status).equals(401)
    expect(
      (await fetch(address, { headers: { 'x-test-user': String(outsider) } }))
        .status
    ).equals(404)
  })
})
