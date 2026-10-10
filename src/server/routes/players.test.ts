import type { Server } from 'node:http'

import { expect } from 'chai'
import express from 'express'
import { type Insertable, Kysely, PostgresDialect } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { asPlayerDetail, asRosterEntry } from '../../common/api'
import { makeId } from '../../common/ids'
import { mintUserId } from '../../common/mintUserId'
import type { Role } from '../../common/roles'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { mayEditName } from '../access'
import type { Database, ScopeRolesTable } from '../db/database'
import { attachInt8Parser } from '../db/int8'
import type { MediaContext } from '../media/mediaContext'
import { withAudit } from '../middleware/withAudit'
import { errorHandler } from '../middleware/withErrors'
import { meRoutes } from './me'
import { playerRoutes, teamsOf } from './players'
import { teamRoutes } from './teams'

/**
 * Who may read a child's whole name, who may **change** it, and which teams a
 * player has played for.
 *
 * The app draws `Jordan P` for everybody. The whole name, to read and to
 * change, goes to the staff of the child's team — anybody holding a role on
 * it, set there or on its season or league — a parent, the child and a site
 * administrator. It fails silently in the wrong direction — nobody
 * complains that a name was shortened, so a gate that had quietly opened
 * would stay open.
 */
const adminUrl = testDatabaseUrl
const scratchName = `teamstation_players_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

const legacyOf = new Map<number, string>()
function mintUser(): number {
  const made = mintUserId(id => legacyOf.has(id))
  legacyOf.set(made.userId, made.legacyId)
  return made.userId
}
function legacyId(userId: number): string {
  const id = legacyOf.get(userId)
  if (id == null) throw new Error(`no legacy id for ${userId}`)
  return id
}

describe('a player, and who may change their name', function () {
  this.timeout(60000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let db: Kysely<Database>

  const teamId = makeId('team')
  const otherTeamId = makeId('team')
  const seasonId = makeId('season')
  const childId = mintUser()
  const parentId = mintUser()
  const coachId = mintUser()
  const strangerId = mintUser()
  const seasonAdminId = mintUser()
  const leagueId = makeId('league')
  // One person per flag on the Badgers, a coach of the league above them, a
  // coach of the Legends only, and a site administrator with no role at all.
  const teamCoachId = mintUser()
  const assistantId = mintUser()
  const scorekeeperId = mintUser()
  const songkeeperId = mintUser()
  const videographerId = mintUser()
  const leagueCoachId = mintUser()
  const otherCoachId = mintUser()
  const siteAdminId = mintUser()
  // A player on both teams, and one on the Legends alone, for the settings a
  // coach may change.
  const bothTeamsId = mintUser()
  const legendId = mintUser()
  let server: Server | undefined
  let base = ''

  before(async function () {
    attachInt8Parser()
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${scratchName}`)

    pool = new Pool({ connectionString: scratchUrl })
    await migrateUp(pool, migrations)
    db = new Kysely<Database>({ dialect: new PostgresDialect({ pool }) })

    await db
      .insertInto('leagues')
      .values({ id: leagueId, name: 'Spring league' })
      .execute()
    await db
      .insertInto('seasons')
      .values({
        id: seasonId,
        name: 'Spring 2026',
        year: 2026,
        league_id: leagueId
      })
      .execute()
    await db
      .insertInto('teams')
      .values([
        { id: teamId, name: 'Badgers' },
        { id: otherTeamId, name: 'Legends' }
      ])
      .execute()
    await db
      .insertInto('season_teams')
      .values({ season_id: seasonId, team_id: teamId })
      .execute()
    // This fixture explicitly models management in addition to competition.
    await db
      .updateTable('teams')
      .set({ league_id: leagueId })
      .where('id', '=', teamId)
      .execute()
    await db
      .insertInto('season_team_parents')
      .values({ season_id: seasonId, team_id: teamId })
      .execute()
    await db
      .insertInto('users')
      .values([
        {
          id: childId,
          legacyId: legacyId(childId),
          display_name: 'Jordan Pujols',
          first_name: 'Jordan',
          last_name: 'Pujols',
          bats: 'left'
        },
        ...[
          teamCoachId,
          assistantId,
          scorekeeperId,
          songkeeperId,
          videographerId,
          leagueCoachId,
          otherCoachId,
          siteAdminId
        ].map(id => ({
          id,
          legacyId: legacyId(id),
          display_name: 'A Helper',
          is_admin: id === siteAdminId
        })),
        {
          id: parentId,
          legacyId: legacyId(parentId),
          display_name: 'A Parent'
        },
        {
          id: bothTeamsId,
          legacyId: legacyId(bothTeamsId),
          display_name: 'Avery Both',
          first_name: 'Avery',
          last_name: 'Both'
        },
        {
          id: legendId,
          legacyId: legacyId(legendId),
          display_name: 'Lee Legend',
          first_name: 'Lee',
          last_name: 'Legend'
        },
        { id: coachId, legacyId: legacyId(coachId), display_name: 'A Coach' },
        {
          id: strangerId,
          legacyId: legacyId(strangerId),
          display_name: 'Somebody Else'
        },
        {
          id: seasonAdminId,
          legacyId: legacyId(seasonAdminId),
          display_name: 'A Season Admin'
        }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values([
        {
          id: makeId('membership'),
          user_id: childId,
          team_id: teamId,
          is_player: true,
          jersey: '12'
        },
        {
          id: makeId('membership'),
          user_id: coachId,
          team_id: teamId,
          role: 'manager'
        },
        {
          id: makeId('membership'),
          user_id: strangerId,
          team_id: teamId
        },
        {
          id: makeId('membership'),
          user_id: parentId,
          team_id: otherTeamId
        },
        {
          id: makeId('membership'),
          user_id: bothTeamsId,
          team_id: teamId,
          is_player: true,
          jersey: '4',
          positions: ['CF']
        },
        {
          id: makeId('membership'),
          user_id: bothTeamsId,
          team_id: otherTeamId,
          is_player: true,
          jersey: '9',
          positions: ['P']
        },
        {
          id: makeId('membership'),
          user_id: legendId,
          team_id: otherTeamId,
          is_player: true,
          jersey: '1'
        },
        // Everybody with a flag can see the Badgers, as the manage page
        // leaves them: a member of the team they hold it on.
        ...[
          teamCoachId,
          assistantId,
          scorekeeperId,
          songkeeperId,
          videographerId,
          otherCoachId
        ].map(id => ({
          id: makeId('membership'),
          user_id: id,
          team_id: teamId
        }))
      ])
      .execute()
    await db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        user_id: leagueCoachId,
        league_id: leagueId,
        role: 'spectator',
        source: 'manual'
      })
      .execute()
    const flag = (
      userId: number,
      scopeType: 'league' | 'season' | 'team',
      scopeId: string,
      role: Role
    ): Insertable<ScopeRolesTable> => ({
      id: makeId('scopeRole'),
      user_id: userId,
      scope_type: scopeType,
      scope_id: scopeId,
      role,
      granted_by: null,
      granted_at: new Date()
    })
    await db
      .insertInto('scope_roles')
      .values([
        flag(teamCoachId, 'team', teamId, 'coach'),
        flag(assistantId, 'team', teamId, 'assistant'),
        flag(scorekeeperId, 'team', teamId, 'scorekeeper'),
        flag(songkeeperId, 'team', teamId, 'songkeeper'),
        flag(videographerId, 'team', teamId, 'videographer'),
        flag(leagueCoachId, 'league', leagueId, 'coach'),
        flag(otherCoachId, 'team', otherTeamId, 'coach')
      ])
      .execute()

    const media: MediaContext = {
      ffmpegPath: '',
      mediaRoot: '',
      mediaSecret: 'test',
      publicUrl: 'http://localhost',
      space: {
        endpoint: '',
        region: '',
        bucket: '',
        accessKeyId: '',
        secretAccessKey: ''
      }
    }
    const app = express()
    app.use((req, _res, next) => {
      const id = req.header('x-test-user')
      if (id != null) {
        req.actor = {
          userId: Number(id),
          isAdmin: Number(id) === siteAdminId,
          scopes: []
        }
      }
      next()
    })
    app.use(express.json())
    app.use(withAudit(db))
    app.use(playerRoutes(db, media))
    app.use(teamRoutes(db, media))
    app.use(meRoutes(db))
    app.use(errorHandler)
    server = await new Promise<Server>(resolve => {
      const listening = app.listen(0, '127.0.0.1', () => {
        resolve(listening)
      })
    })
    const bound = server.address()
    if (bound == null || typeof bound === 'string') throw new Error('no port')
    base = `http://127.0.0.1:${bound.port}`
    await db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: parentId,
        related_user_id: childId,
        kind: 'guardian'
      })
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: seasonAdminId,
        scope_type: 'season',
        scope_id: seasonId
      })
      .execute()
  })

  after(async function () {
    await new Promise<void>(resolve => {
      if (server == null) resolve()
      else
        server.close(() => {
          resolve()
        })
    })
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${scratchName}`)
      await admin.end()
    }
  })

  const about = { isAdmin: false }

  it('lets a parent change it', async function () {
    expect(await mayEditName(db, parentId, childId, about)).equals(true)
  })

  it('lets a site administrator change it', async function () {
    expect(
      await mayEditName(db, strangerId, childId, { isAdmin: true })
    ).equals(true)
  })

  it('lets a player change their own', async function () {
    expect(await mayEditName(db, childId, childId, about)).equals(true)
  })

  // Team admins, coaches, assistants and scorekeepers can see and edit a
  // child's full name: a scorekeeper may be the only person keeping the
  // roster. A songkeeper or videographer, a team-mate, a parent of somebody
  // else and the staff of another team cannot.
  it('lets the roster managers of the child’s team change it, and nobody else', async function () {
    for (const staff of [
      coachId,
      seasonAdminId,
      teamCoachId,
      assistantId,
      scorekeeperId,
      leagueCoachId
    ]) {
      expect(
        await mayEditName(db, staff, childId, about),
        String(staff)
      ).equals(true)
    }
    for (const outsider of [
      songkeeperId,
      videographerId,
      strangerId,
      otherCoachId
    ]) {
      expect(
        await mayEditName(db, outsider, childId, about),
        String(outsider)
      ).equals(false)
    }
    // The Legends' coach has the Legends' player, and the Badgers' staff
    // do not.
    expect(await mayEditName(db, otherCoachId, legendId, about)).equals(true)
    expect(await mayEditName(db, teamCoachId, legendId, about)).equals(false)
    expect(await mayEditName(db, parentId, legendId, about)).equals(false)
  })

  const get = async (
    path: string,
    viewer: number
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${base}${path}`, {
      headers: { 'x-test-user': String(viewer) }
    })
    return { status: response.status, body: await response.json() }
  }

  // Everybody who can see the team in this fixture, from a site admin down.
  const everyViewer = (): number[] => [
    teamCoachId,
    assistantId,
    leagueCoachId,
    coachId,
    childId,
    siteAdminId,
    scorekeeperId,
    songkeeperId,
    videographerId,
    strangerId,
    otherCoachId
  ]

  it('never puts the whole name on the player page, for anybody', async function () {
    for (const viewer of everyViewer()) {
      const answer = await get(`/players/${childId}`, viewer)
      expect(answer.status, String(viewer)).equals(200)
      expect(asPlayerDetail(answer.body).name).equals('Jordan P')
      expect(JSON.stringify(answer.body), String(viewer)).not.includes('Pujols')
      expect(answer.body, String(viewer)).not.have.property('fullName')
    }
  })

  it('never puts the whole name on the roster, for anybody', async function () {
    for (const viewer of everyViewer()) {
      const answer = await get(`/teams/${teamId}/roster`, viewer)
      expect(answer.status, String(viewer)).equals(200)
      if (!Array.isArray(answer.body)) throw new Error('Expected roster array')
      const child = answer.body
        .map(asRosterEntry)
        .find(entry => entry.userId === childId)
      expect(child?.shortName).equals('Jordan P')
      expect(JSON.stringify(answer.body), String(viewer)).not.includes('Pujols')
    }
  })

  it('gives the name field to the roster managers of the team, and to nobody else on it', async function () {
    for (const viewer of [
      teamCoachId,
      assistantId,
      scorekeeperId,
      coachId,
      leagueCoachId
    ]) {
      const answer = await get(`/players/${childId}/name`, viewer)
      expect(answer.status, String(viewer)).equals(200)
      expect(answer.body).deep.include({
        firstName: 'Jordan',
        lastName: 'Pujols'
      })
      const detail = asPlayerDetail(
        (await get(`/players/${childId}`, viewer)).body
      )
      expect(detail.canEditName, String(viewer)).equals(true)
    }
    // A parent on another team asks for the name alone.
    expect((await get(`/players/${childId}/name`, parentId)).status).equals(200)
    for (const viewer of [
      songkeeperId,
      videographerId,
      strangerId,
      otherCoachId
    ]) {
      const answer = await get(`/players/${childId}/name`, viewer)
      expect(answer.status, String(viewer)).equals(404)
      const detail = asPlayerDetail(
        (await get(`/players/${childId}`, viewer)).body
      )
      expect(detail.canEditName, String(viewer)).equals(false)
    }
  })

  /**
   * Two rows closed into the child, one into the other, and a parent who can
   * see the team and is linked to the oldest of them alone: what an import
   * leaves when a child's placeholder rows are merged into the real one. Every
   * row it adds is gone again once `check` returns.
   */
  const withClosedRows = async (
    check: (rows: {
      oldest: number
      closer: number
      parent: number
    }) => Promise<void>
  ): Promise<void> => {
    const [oldest, closer, parent] = [mintUser(), mintUser(), mintUser()]
    await db
      .insertInto('users')
      .values([
        {
          id: closer,
          legacyId: legacyId(closer),
          display_name: 'Jordan P',
          merged_into: childId
        },
        {
          id: oldest,
          legacyId: legacyId(oldest),
          display_name: 'Jordan',
          merged_into: closer
        },
        {
          id: parent,
          legacyId: legacyId(parent),
          display_name: 'Albert Pujols'
        }
      ])
      .execute()
    await db
      .insertInto('memberships')
      .values({ id: makeId('membership'), team_id: teamId, user_id: parent })
      .execute()
    await db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: parent,
        related_user_id: oldest,
        kind: 'guardian'
      })
      .execute()
    try {
      await check({ oldest, closer, parent })
    } finally {
      await db
        .deleteFrom('users')
        .where('id', 'in', [parent, oldest, closer])
        .execute()
    }
  }

  it('offers the name field to a parent linked to a row merged into the child', async function () {
    await withClosedRows(async ({ parent }) => {
      const page = await get(`/players/${childId}`, parent)
      expect(page.status).equals(200)
      expect(asPlayerDetail(page.body).canEditName).equals(true)
      const name = await get(`/players/${childId}/name`, parent)
      expect(name.status).equals(200)
      expect(name.body).deep.include({ lastName: 'Pujols' })

      const stranger = await get(`/players/${childId}`, strangerId)
      expect(asPlayerDetail(stranger.body).canEditName).equals(false)
    })
  })

  it('sends the name of a merged-away row on to the open row, and answers anybody refused with 404', async function () {
    await withClosedRows(async ({ oldest, closer, parent }) => {
      const ask = async (id: number, viewer: number): Promise<Response> =>
        await fetch(`${base}/players/${id}/name`, {
          headers: { 'x-test-user': String(viewer) },
          redirect: 'manual'
        })

      // Straight to the open row, however long the chain: one hop, not one
      // per merge.
      for (const id of [oldest, closer]) {
        for (const viewer of [parent, parentId, teamCoachId]) {
          const answer = await ask(id, viewer)
          expect(answer.status, `${id} ${viewer}`).equals(303)
          expect(answer.headers.get('location')).equals(
            `/api/v1/players/${childId}/name`
          )
        }
        for (const viewer of [strangerId, otherCoachId]) {
          expect((await ask(id, viewer)).status, String(viewer)).equals(404)
        }
      }
    })
  })

  it('answers a closed row itself when its chain never reaches an open one', async function () {
    // Two rows closed into each other: bad data, but no reason to send the
    // editor round in circles.
    const [one, two] = [mintUser(), mintUser()]
    await db
      .insertInto('users')
      .values([
        { id: one, legacyId: legacyId(one), display_name: 'Jordan' },
        { id: two, legacyId: legacyId(two), display_name: 'Jordan P' }
      ])
      .execute()
    await db
      .updateTable('users')
      .set({ merged_into: two })
      .where('id', '=', one)
      .execute()
    await db
      .updateTable('users')
      .set({ merged_into: one })
      .where('id', '=', two)
      .execute()
    await db
      .insertInto('user_links')
      .values({
        id: makeId('userLink'),
        user_id: parentId,
        related_user_id: one,
        kind: 'guardian'
      })
      .execute()
    try {
      const answer = await fetch(`${base}/players/${one}/name`, {
        headers: { 'x-test-user': String(parentId) },
        redirect: 'manual'
      })
      expect(answer.status).equals(200)
      expect(await answer.json()).deep.include({
        userId: one,
        displayName: 'Jordan'
      })
    } finally {
      await db.deleteFrom('users').where('id', 'in', [one, two]).execute()
    }
  })

  const put = async (
    path: string,
    viewer: number,
    body: unknown
  ): Promise<{ status: number; body: unknown }> => {
    const response = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: {
        'x-test-user': String(viewer),
        'content-type': 'application/json'
      },
      body: JSON.stringify(body)
    })
    return { status: response.status, body: await response.json() }
  }
  const settingsOf = (team: string, player: number): string =>
    `/teams/${team}/players/${player}/settings`

  it('lets existing roster managers correct a placeholder name atomically, without broadening permissions', async function () {
    const original = await db
      .selectFrom('users')
      .select([
        'first_name',
        'last_name',
        'display_name',
        'login_enabled',
        'bats_source',
        'bats'
      ])
      .where('id', '=', childId)
      .executeTakeFirstOrThrow()
    const place = await db
      .selectFrom('memberships')
      .select(['jersey'])
      .where('team_id', '=', teamId)
      .where('user_id', '=', childId)
      .executeTakeFirstOrThrow()
    const proof = (body: unknown, answer: unknown): void => {
      if (process.env.TS_NAME_API_PROOF === '1')
        console.log('Name Settings PUT', JSON.stringify({ body, answer }))
    }
    try {
      await db
        .updateTable('users')
        .set({ login_enabled: false })
        .where('id', '=', childId)
        .execute()
      for (const viewer of [
        teamCoachId,
        assistantId,
        scorekeeperId,
        leagueCoachId,
        coachId,
        seasonAdminId,
        siteAdminId
      ]) {
        const body = {
          name: { firstName: ' Mookie ', lastName: ' Betts ' },
          jersey: '14'
        }
        const answer = await put(settingsOf(teamId, childId), viewer, body)
        proof(body, answer)
        expect(answer.status).equals(200)
        const entry = asRosterEntry(answer.body)
        expect(entry.nameDetails).deep.equals({
          firstName: 'Mookie',
          lastName: 'Betts',
          displayName: 'Mookie Betts'
        })
        expect(entry.jersey).equals('14')
        expect(entry.userId).equals(childId)
      }
      for (const viewer of [
        songkeeperId,
        videographerId,
        strangerId,
        otherCoachId,
        parentId,
        childId
      ]) {
        const body = {
          name: { firstName: 'Mike', lastName: 'Trout' },
          jersey: '99'
        }
        const answer = await put(settingsOf(teamId, childId), viewer, body)
        proof(body, answer)
        expect(answer.status).equals(404)
      }
      const body = { name: { firstName: '', lastName: '' }, jersey: '99' }
      const invalid = await put(
        settingsOf(teamId, childId),
        scorekeeperId,
        body
      )
      proof(body, invalid)
      expect(invalid.status).equals(400)
      const roster = (
        await get(
          `/teams/${teamId}/roster?includeFullNames=true`,
          scorekeeperId
        )
      ).body as unknown[]
      expect(
        roster.map(asRosterEntry).find(row => row.userId === childId)?.jersey
      ).equals('14')
      const saved = await db
        .selectFrom('users')
        .select(['display_name', 'login_enabled', 'bats_source'])
        .where('id', '=', childId)
        .executeTakeFirstOrThrow()
      expect(saved).deep.equals({
        display_name: 'Mookie Betts',
        login_enabled: false,
        bats_source: original.bats_source
      })
      expect(
        JSON.stringify(
          (await get(`/teams/${teamId}/roster`, scorekeeperId)).body
        )
      ).not.includes('Betts')
      const surnameOnly = await put(
        settingsOf(teamId, childId),
        scorekeeperId,
        { name: { firstName: '', lastName: 'Betts' } }
      )
      expect(asRosterEntry(surnameOnly.body).nameDetails?.firstName).equals(
        null
      )
      const firstOnly = await put(settingsOf(teamId, childId), scorekeeperId, {
        name: { firstName: 'Mookie', lastName: '' },
        bats: 'switch'
      })
      expect(asRosterEntry(firstOnly.body).nameDetails?.lastName).equals(null)
      expect(asRosterEntry(firstOnly.body).bats).equals('switch')
    } finally {
      await db
        .updateTable('users')
        .set(original)
        .where('id', '=', childId)
        .execute()
      await db
        .updateTable('memberships')
        .set({ jersey: place.jersey })
        .where('team_id', '=', teamId)
        .where('user_id', '=', childId)
        .execute()
    }
  })

  it('lets a coach, an assistant, a scorekeeper or an admin of the team set a player’s settings', async function () {
    for (const [viewer, jersey] of [
      [teamCoachId, '3'],
      [scorekeeperId, '4'],
      [assistantId, '7'],
      [leagueCoachId, '5'],
      [coachId, '6'],
      [seasonAdminId, '8'],
      [siteAdminId, '12']
    ] as const) {
      const answer = await put(settingsOf(teamId, childId), viewer, { jersey })
      expect(answer.status, String(viewer)).equals(200)
      const entry = asRosterEntry(answer.body)
      expect(entry.userId).equals(childId)
      expect(entry.jersey).equals(jersey)
      expect(entry.shortName).equals('Jordan P')
    }
  })

  it('answers 404 to anybody else, and for anybody who is not a player on the team', async function () {
    for (const viewer of [
      songkeeperId,
      videographerId,
      strangerId,
      otherCoachId,
      parentId,
      childId
    ]) {
      const answer = await put(settingsOf(teamId, childId), viewer, {
        jersey: '99'
      })
      expect(answer.status, String(viewer)).equals(404)
    }
    // Rights come first: a bad body from somebody with none is still 404.
    expect(
      (await put(settingsOf(teamId, childId), songkeeperId, {})).status
    ).equals(404)
    // A member who does not play, a player on another team, a stranger to
    // both, and a team that does not exist.
    for (const target of [strangerId, coachId, legendId, parentId]) {
      const answer = await put(settingsOf(teamId, target), teamCoachId, {
        jersey: '1'
      })
      expect(answer.status, String(target)).equals(404)
    }
    expect(
      (await put(settingsOf('tem_none', childId), siteAdminId, { jersey: '1' }))
        .status
    ).equals(404)
    expect(
      (await put(`/teams/${teamId}/players/nobody/settings`, siteAdminId, {}))
        .status
    ).equals(404)
    const [row] = await db
      .selectFrom('memberships')
      .select(['jersey'])
      .where('user_id', '=', childId)
      .where('team_id', '=', teamId)
      .execute()
    expect(row.jersey).equals('12')
  })

  it('keeps the jersey and positions to this team, and the hands to the player', async function () {
    const answer = await put(settingsOf(teamId, bothTeamsId), teamCoachId, {
      jersey: ' 22 ',
      positions: ['SS', '2B', 'SS', 'DH'],
      bats: 'left',
      throws: 'left'
    })
    expect(answer.status).equals(200)
    const entry = asRosterEntry(answer.body)
    expect(entry.jersey).equals('22')
    expect(entry.positions).deep.equals(['2B', 'SS', 'DH'])
    expect(entry.bats).equals('left')
    expect(entry.throws).equals('left')

    const legends = (await get(`/teams/${otherTeamId}/roster`, siteAdminId))
      .body as unknown[]
    const there = legends
      .map(asRosterEntry)
      .find(row => row.userId === bothTeamsId)
    expect(there?.jersey).equals('9')
    expect(there?.positions).deep.equals(['P'])
    expect(there?.bats).equals('left')
    expect(there?.throws).equals('left')

    // A field left out is left alone, and an emptied jersey is no number.
    const cleared = asRosterEntry(
      (await put(settingsOf(teamId, bothTeamsId), teamCoachId, { jersey: '' }))
        .body
    )
    expect(cleared.jersey).equals(null)
    expect(cleared.positions).deep.equals(['2B', 'SS', 'DH'])
    expect(cleared.bats).equals('left')
    const nulled = asRosterEntry(
      (
        await put(settingsOf(teamId, bothTeamsId), teamCoachId, {
          jersey: null,
          positions: []
        })
      ).body
    )
    expect(nulled.jersey).equals(null)
    expect(nulled.positions).deep.equals([])
    const user = await db
      .selectFrom('users')
      .select(['bats_source'])
      .where('id', '=', bothTeamsId)
      .executeTakeFirstOrThrow()
    expect(user.bats_source).equals('manual')
  })

  it('refuses a bad body with 400', async function () {
    for (const body of [
      {},
      [],
      'nothing',
      { jersey: '1234' },
      { jersey: 5 },
      { positions: ['XX'] },
      { positions: 'SS' },
      { bats: 'both' },
      { throws: 'switch' }
    ]) {
      const answer = await put(settingsOf(teamId, childId), teamCoachId, body)
      expect(answer.status, JSON.stringify(body)).equals(400)
    }
  })

  it('audits the change', async function () {
    await put(settingsOf(teamId, legendId), siteAdminId, { jersey: 'x' })
    await put(settingsOf(otherTeamId, legendId), otherCoachId, {
      positions: ['C']
    })
    let audited: Array<{ before: unknown; after: unknown }> = []
    for (let tries = 0; tries < 50 && audited.length < 1; tries++) {
      await new Promise(resolve => setTimeout(resolve, 10))
      audited = await db
        .selectFrom('audit_log')
        .select(['before', 'after'])
        .where('entity_type', '=', 'playerSettings')
        .where('entity_id', '=', String(legendId))
        .execute()
    }
    expect(audited).deep.equals([
      {
        before: {
          teamId: otherTeamId,
          jersey: '1',
          positions: [],
          bats: null,
          throws: null
        },
        after: {
          teamId: otherTeamId,
          jersey: '1',
          positions: ['C'],
          bats: null,
          throws: null
        }
      }
    ])
  })

  it('lists coach on the team in GET /me/roles, and keeps the roster a bare array', async function () {
    const roles = await get('/me/roles', teamCoachId)
    expect(roles.status).equals(200)
    expect(
      (roles.body as { teams: Record<string, string[]> }).teams[teamId]
    ).deep.equals(['coach'])
    const assistant = await get('/me/roles', assistantId)
    expect(
      (assistant.body as { teams: Record<string, string[]> }).teams[teamId]
    ).deep.equals(['assistant'])
    const roster = await get(`/teams/${teamId}/roster`, teamCoachId)
    expect(Array.isArray(roster.body)).equals(true)
  })

  it('lists the teams a player has been on, with the season', async function () {
    const teams = await teamsOf(db, [childId])
    expect(teams).deep.equals([
      {
        teamId,
        teamName: 'Badgers',
        seasonId,
        seasonName: 'Spring 2026',
        seasonYear: 2026
      }
    ])
  })

  // A membership that is not a playing one is not a team they played for. The
  // filter on their stats is built from this list, and a season nobody batted
  // in is an option that can only ever answer "nothing".
  it('leaves out a team they are only a spectator on', async function () {
    expect(await teamsOf(db, [strangerId])).deep.equals([])
  })
})
