import { randomBytes } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { makeId } from '../../common/ids'
import type { SponsoredRow } from '../../common/sponsors/types'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { createSession } from '../auth/sessions'
import { sponsorRoutes } from '../routes/sponsors'

const NOW = new Date('2027-04-10T18:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

/** U31: the sponsored rows each Schedule reads, and who may read them. */
describe('U31 sponsored rows in Schedules', function () {
  this.timeout(120000)
  let f: GroupFixture
  const uploads = mkdtempSync(join(tmpdir(), 'sponsor-rows-'))
  let keys = 0
  const key = (): string => `${++keys}`
  let gumbos = 781000

  const league = async (): Promise<string> => {
    const id = `lea_rows_${key()}`
    await f.h.db.insertInto('leagues').values({ id, name: id }).execute()
    return id
  }
  const media = async (
    leagueId: string,
    purpose: 'rowLogo' | 'rowBackground'
  ): Promise<string> => {
    const id = makeId('sponsorMedia')
    await f.h.db
      .insertInto('sponsor_media')
      .values({
        id,
        league_id: leagueId,
        purpose,
        object_key: `sponsors/${leagueId}/${id}.png`,
        content_type: 'image/png',
        bytes: 100,
        sha256: randomBytes(32).toString('hex'),
        width: 300,
        height: 200,
        duration_ms: null,
        created_by: null
      })
      .execute()
    return id
  }
  /** A live row of `leagueId`'s, `days` from now. */
  const row = async (
    leagueId: string,
    days: number,
    deleted = false
  ): Promise<string> => {
    const id = makeId('sponsorRow')
    await f.h.db
      .insertInto('sponsor_rows')
      .values({
        id,
        league_id: leagueId,
        logo_media_id: await media(leagueId, 'rowLogo'),
        background_media_id: await media(leagueId, 'rowBackground'),
        title: `Row ${id}`,
        message: 'Fresh bread after games.',
        url: 'https://example.test/bread',
        text_color: 'white',
        starts_at: new Date(NOW.getTime() + days * DAY),
        placed_at: NOW,
        deleted_at: deleted ? NOW : null
      })
      .execute()
    return id
  }
  const team = async (
    leagueId: string | null,
    mergedInto: string | null = null
  ): Promise<string> => {
    const id = `tem_rows_${key()}`
    await f.h.db
      .insertInto('teams')
      .values({
        id,
        name: id,
        league_id: leagueId,
        kind: 'full',
        created_from: 'manual',
        merged_into: mergedInto
      })
      .execute()
    return id
  }
  const season = async (
    leagueId: string,
    teamIds: string[]
  ): Promise<string> => {
    const id = `sea_rows_${key()}`
    await f.h.db
      .insertInto('seasons')
      .values({
        id,
        name: id,
        league_id: leagueId,
        year: 2027,
        starts_on: '2027-03-01',
        ends_on: '2027-05-31'
      })
      .execute()
    if (teamIds.length > 0)
      await f.h.db
        .insertInto('season_teams')
        .values(
          teamIds.map(teamId => ({
            season_id: id,
            team_id: teamId,
            active: true
          }))
        )
        .execute()
    return id
  }

  interface Viewer {
    userId: string
    token: string
  }
  const viewer = async (isAdmin = false): Promise<Viewer> => {
    const gumbo = ++gumbos
    await insertFixtureUsers(f.h.db, {
      id: gumbo,
      display_name: `Viewer ${gumbo}`,
      login_enabled: true
    })
    const userId = userIdOfGumbo(gumbo)
    if (isAdmin)
      await f.h.db
        .updateTable('users')
        .set({ is_admin: true })
        .where('id', '=', userId)
        .execute()
    return {
      userId,
      token: (await createSession(f.h.db, userId, 'sponsor-rows')).token
    }
  }
  const member = async (who: Viewer, teamId: string): Promise<void> => {
    await f.h.db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: who.userId,
        team_id: teamId,
        is_player: true
      })
      .execute()
  }
  const seasonMember = async (who: Viewer, seasonId: string): Promise<void> => {
    await f.h.db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: who.userId,
        season_id: seasonId
      })
      .execute()
  }

  const read = async (
    query: string,
    who: Viewer | null
  ): Promise<{ status: number; rows: SponsoredRow[] }> => {
    const response = await f.h.request(
      'GET',
      `/sponsor-rows?${query}`,
      undefined,
      who?.token ?? null
    )
    return {
      status: response.status,
      rows:
        response.status === 200
          ? ((await response.json()) as SponsoredRow[])
          : []
    }
  }
  const ids = (rows: SponsoredRow[]): string[] => rows.map(each => each.id)

  before(async function () {
    f = await groupFixture(undefined, undefined, (app, { db, media }) => {
      app.use(
        '/api/v1',
        sponsorRoutes(db, media, { uploadsDir: uploads, clock: () => NOW })
      )
    })
  })

  after(async function () {
    await f?.h.close()
    rmSync(uploads, { recursive: true, force: true })
  })

  describe('which rows', function () {
    it('gives a team its own league’s live rows by start, in the shape a Schedule draws', async function () {
      const american = await league()
      const national = await league()
      const yankees = await team(american)
      const later = await row(american, 3)
      const sooner = await row(american, 1)
      await row(american, 2, true)
      await row(national, 1)
      const player = await viewer()
      await member(player, yankees)
      const { status, rows } = await read(`team=${yankees}`, player)
      expect(status).equals(200)
      expect(ids(rows)).deep.equals([sooner, later])
      expect(rows[0]).to.include({
        leagueId: american,
        title: `Row ${sooner}`,
        message: 'Fresh bread after games.',
        url: 'https://example.test/bread',
        textColor: 'white',
        startsAt: new Date(NOW.getTime() + DAY).toISOString()
      })
      expect(rows[0].logoUrl).contains(`/sponsors/${american}/`)
      expect(rows[0].backgroundUrl).contains(`/sponsors/${american}/`)
      expect(rows[0].logoUrl).not.equals(rows[0].backgroundUrl)
    })

    it('gives a team in no league none', async function () {
      const loose = await team(null)
      const player = await viewer()
      await member(player, loose)
      expect(await read(`team=${loose}`, player)).deep.equals({
        status: 200,
        rows: []
      })
    })

    it('gives a season holding teams of two leagues both leagues’ rows', async function () {
      const american = await league()
      const national = await league()
      const yankees = await team(american)
      const dodgers = await team(national)
      const seasonId = await season(american, [yankees, dodgers])
      const al = await row(american, 2)
      const nl = await row(national, 1)
      await row(await league(), 1)
      const fan = await viewer()
      await seasonMember(fan, seasonId)
      const { status, rows } = await read(`season=${seasonId}`, fan)
      expect(status).equals(200)
      expect(ids(rows)).deep.equals([nl, al])
      const empty = await season(american, [])
      const admin = await viewer(true)
      expect(await read(`season=${empty}`, admin)).deep.equals({
        status: 200,
        rows: []
      })
    })

    it('gives scope=me the leagues of the viewer’s teams and of every team in their seasons, and a site admin every league’s', async function () {
      const american = await league()
      const national = await league()
      const central = await league()
      const outside = await league()
      const yankees = await team(american)
      const dodgers = await team(national)
      const twins = await team(central)
      await team(outside)
      const seasonId = await season(central, [twins])
      const al = await row(american, 1)
      const nl = await row(national, 2)
      const cl = await row(central, 3)
      const ol = await row(outside, 4)
      const player = await viewer()
      await member(player, yankees)
      await member(player, dodgers)
      await seasonMember(player, seasonId)
      expect(ids((await read('scope=me', player)).rows)).deep.equals([
        al,
        nl,
        cl
      ])
      const nobody = await viewer()
      expect(await read('scope=me', nobody)).deep.equals({
        status: 200,
        rows: []
      })
      const admin = await viewer(true)
      expect(ids((await read('scope=me', admin)).rows)).includes.members([
        al,
        nl,
        cl,
        ol
      ])
    })
  })

  describe('visibility', function () {
    it('answers a public team to a signed-out viewer, following a merge, and a stranger the team’s own read', async function () {
      const american = await league()
      const yankees = await team(american)
      const old = await team(american, yankees)
      const placed = await row(american, 1)
      expect(
        ids((await read(`team=${yankees}&public=1`, null)).rows)
      ).deep.equals([placed])
      expect(ids((await read(`team=${old}&public=1`, null)).rows)).deep.equals([
        placed
      ])
      const stranger = await viewer()
      expect(ids((await read(`team=${yankees}`, stranger)).rows)).deep.equals([
        placed
      ])
    })

    it('refuses a team a stranger cannot open with 404, and a signed-out read without public with 401', async function () {
      const american = await league()
      const yankees = await team(american)
      const merged = await team(american, yankees)
      await row(american, 1)
      const stranger = await viewer()
      expect((await read(`team=${merged}`, stranger)).status).equals(404)
      expect((await read('team=tem_rows_none', stranger)).status).equals(404)
      expect((await read('team=tem_rows_none&public=1', null)).status).equals(
        404
      )
      expect((await read(`team=${yankees}`, null)).status).equals(401)
      expect((await read('scope=me', null)).status).equals(401)
    })

    it('reads a season for its members, publicly for anybody, and 404 for a stranger', async function () {
      const american = await league()
      const yankees = await team(american)
      const seasonId = await season(american, [yankees])
      const placed = await row(american, 1)
      const stranger = await viewer()
      expect((await read(`season=${seasonId}`, stranger)).status).equals(404)
      expect((await read(`season=${seasonId}`, null)).status).equals(401)
      expect((await read('season=sea_rows_none', stranger)).status).equals(404)
      expect(
        ids((await read(`season=${seasonId}&public=1`, null)).rows)
      ).deep.equals([placed])
    })

    it('refuses a read that asks for no Schedule, or for two', async function () {
      const who = await viewer()
      for (const query of ['', 'team=a&season=b', 'scope=all', 'team='])
        expect((await read(query, who)).status, query).equals(400)
    })
  })
})
