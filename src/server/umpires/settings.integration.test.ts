import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { ROLE_FLAGS } from '../../common/roles'
import { userIdOfGumbo } from '../../common/userId'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'
import { mergeTeams } from '../admin/mergeTeams'
import { umpireRoutes } from '../routes/umpires'

describe('umpire settings and independent role', function () {
  this.timeout(60000)
  let f: GroupFixture
  const user = userIdOfGumbo(101)
  before(async () => {
    f = await groupFixture(undefined, undefined, (app, { db }) => {
      app.use('/api/v1', umpireRoutes(db))
    })
  })
  after(async () => {
    await f?.h.close()
  })
  it('requires administration and keeps the role separate from administrator flags', async () => {
    const path = `/leagues/${f.leagueA}/umpire-settings`
    expect((await f.h.request('GET', path, undefined, null)).status).equals(401)
    expect((await f.h.request('GET', path, undefined, 102)).status).equals(403)
    expect(
      (await f.h.request('PUT', path, { management: true }, 102)).status
    ).equals(403)
    expect(
      (
        await f.h.request(
          'GET',
          '/leagues/missing/umpire-settings',
          undefined,
          101
        )
      ).status
    ).equals(404)
    expect(
      await (await f.h.request('GET', path, undefined, 101)).json()
    ).deep.equals({ management: false, credits: false })
    expect(ROLE_FLAGS).not.includes('umpire')
    expect(
      await f.h.db.selectFrom('league_umpires').selectAll().execute()
    ).length(0)
    for (const body of [
      { management: 'true' },
      { credits: null },
      { unknown: true },
      []
    ])
      expect((await f.h.request('PUT', path, body, 101)).status).equals(400)
    await f.h.db
      .insertInto('league_umpires')
      .values({ league_id: f.leagueA, user_id: user, granted_by: user })
      .execute()
    for (const management of [true, false, true]) {
      const response = await f.h.request(
        'PUT',
        path,
        { management, credits: true },
        101
      )
      expect(response.status).equals(200)
      expect(await response.json()).deep.equals({ management, credits: true })
      expect(
        await f.h.db.selectFrom('league_umpires').selectAll().execute()
      ).length(1)
    }
    expect(await (await f.h.request('PUT', path, {}, 101)).json()).deep.equals({
      management: true,
      credits: true
    })
  })
  it('clears cancelled and withdrawn assignments through the game trigger and does not restore them', async () => {
    for (const action of ['cancelled', 'withdrawn'] as const) {
      const id = `gam_umpire_${action}`
      await f.h.db
        .insertInto('games')
        .values({
          id,
          home_team_id: f.teamA,
          away_team_id: f.teamB,
          start_at: new Date(),
          season_id: f.seasonA
        })
        .execute()
      await f.h.db
        .insertInto('umpire_assignments')
        .values({
          game_id: id,
          slot: 'uty_plate:1',
          user_id: user,
          assigned_by: user,
          credit_team_id: f.teamA
        })
        .execute()
      await f.h.db
        .updateTable('games')
        .set(
          action === 'cancelled'
            ? { status: 'cancelled' }
            : { withdrawn_at: new Date() }
        )
        .where('id', '=', id)
        .execute()
      expect(
        await f.h.db
          .selectFrom('umpire_assignments')
          .selectAll()
          .where('game_id', '=', id)
          .execute()
      ).length(0)
      await f.h.db
        .updateTable('games')
        .set({ status: 'scheduled', withdrawn_at: null })
        .where('id', '=', id)
        .execute()
      expect(
        await f.h.db
          .selectFrom('umpire_assignments')
          .selectAll()
          .where('game_id', '=', id)
          .execute()
      ).length(0)
    }
  })
  it('preserves kept slots, moves free slots and credits, and drops slots for inactive survivors', async () => {
    await f.h.db
      .insertInto('umpire_note_types')
      .values(
        ['color', 'contact'].map((id, position) => ({
          id,
          name: id,
          position,
          league_id: f.leagueA
        }))
      )
      .execute()
    for (const state of ['scheduled', 'cancelled', 'withdrawn'] as const) {
      const duplicate = `tem_umpire_${state}`
      await f.h.db
        .insertInto('teams')
        .values({
          id: duplicate,
          name: 'Demo Duplicate',
          kind: 'external',
          custodian_type: 'team',
          custodian_id: f.teamA
        })
        .execute()
      const kept = `gam_a_${state}`
      const retired = `gam_z_${state}`
      const start = new Date(
        `2030-04-${state === 'scheduled' ? '01' : state === 'cancelled' ? '02' : '03'}T12:00:00Z`
      )
      for (const [id, home] of [
        [kept, f.teamA],
        [retired, duplicate]
      ])
        await f.h.db
          .insertInto('games')
          .values({
            id,
            home_team_id: home,
            away_team_id: f.teamB,
            start_at: start,
            season_id: f.seasonA,
            status: 'scheduled'
          })
          .execute()
      await f.h.db
        .insertInto('umpire_assignments')
        .values([
          {
            game_id: kept,
            slot: 'uty_plate:1',
            user_id: user,
            assigned_by: user,
            credit_team_id: f.teamA
          },
          {
            game_id: retired,
            slot: 'uty_plate:1',
            user_id: userIdOfGumbo(102),
            assigned_by: user,
            credit_team_id: duplicate
          },
          {
            game_id: retired,
            slot: 'uty_field:1',
            user_id: userIdOfGumbo(103),
            assigned_by: user,
            credit_team_id: duplicate
          },
          {
            game_id: retired,
            slot: 'uty_field:2',
            user_id: user,
            assigned_by: user,
            credit_team_id: duplicate
          }
        ])
        .execute()
      if (state !== 'scheduled')
        await f.h.db
          .updateTable('games')
          .set(
            state === 'cancelled'
              ? { status: 'cancelled' }
              : { withdrawn_at: new Date() }
          )
          .where('id', '=', kept)
          .execute()
      await f.h.db
        .insertInto('game_umpire_notes')
        .values([
          { game_id: kept, note_type_id: 'color', value: 'Blue' },
          { game_id: retired, note_type_id: 'color', value: 'Gold' },
          { game_id: retired, note_type_id: 'contact', value: 'Demo contact' }
        ])
        .execute()
      await mergeTeams(f.h.db, {
        fromTeamId: duplicate,
        intoTeamId: f.teamA,
        apply: true
      })
      expect(
        await f.h.db
          .selectFrom('game_umpire_notes')
          .select(['note_type_id', 'value'])
          .where('game_id', '=', kept)
          .orderBy('note_type_id')
          .execute()
      ).deep.equals([
        { note_type_id: 'color', value: 'Blue' },
        { note_type_id: 'contact', value: 'Demo contact' }
      ])
      expect(
        await f.h.db
          .selectFrom('game_umpire_notes')
          .selectAll()
          .where('game_id', '=', retired)
          .execute()
      ).length(0)
      const rows = await f.h.db
        .selectFrom('umpire_assignments')
        .selectAll()
        .where('game_id', '=', kept)
        .execute()
      expect(rows).length(state === 'scheduled' ? 2 : 0)
      if (state === 'scheduled') {
        expect(rows.map(r => r.slot).sort()).deep.equals([
          'uty_field:1',
          'uty_plate:1'
        ])
        expect(rows.every(r => r.credit_team_id === f.teamA)).equals(true)
      }
      expect(
        await f.h.db
          .selectFrom('games')
          .select('id')
          .where('id', '=', retired)
          .execute()
      ).length(0)
    }
  })
})
