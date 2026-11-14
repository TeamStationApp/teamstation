import { expect } from 'chai'
import { sql } from 'kysely'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { buildOptions } from '../../common/autoScheduler'
import {
  asPreparedPreview,
  type Publication,
  type SchedulePreview
} from '../../common/schedulePreviews'
import { userIdOfGumbo } from '../../common/userId'
import {
  G1,
  SEASON_A_SETTINGS,
  seedHarborField
} from '../../test/autoSchedulerFixture'
import { demoLocality } from '../../test/groupFixtures'
import { type SchedulerWorld, schedulerWorld } from '../../test/schedulerWorld'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import { decideGameRequest } from '../schedule/gameApprovals'

describe('publishing a schedule preview', function () {
  this.timeout(240000)
  let w: SchedulerWorld
  const build = async (
    body: unknown,
    user = 101
  ): Promise<{ status: number; body: SchedulePreview }> =>
    await w.call<SchedulePreview>(
      user,
      'POST',
      `/leagues/${w.fx.f.leagueA}/schedule-previews/preparations`,
      body
    )
  const publish = async (
    previewId: string,
    option = 0,
    user = 101
  ): Promise<{ status: number; body: Publication }> =>
    await w.call<Publication>(
      user,
      'POST',
      `/schedule-previews/${previewId}/publications`,
      { option }
    )
  const participants = (): string[] =>
    ['Hawks', 'Owls', 'Foxes', 'Comets', 'Bears', 'Rockets', 'Visitors'].map(
      name => w.fx.teams[name]
    )
  beforeEach(async () => {
    w = await schedulerWorld()
  })
  afterEach(async () => {
    await w?.close()
  })

  it('places again, rather than keeps, a game on a field its season has since deselected', async () => {
    const { f } = w.fx
    const harbor = await seedHarborField(w.fx)
    const settingsPath = `/seasons/${f.seasonA}/schedule-settings`
    expect(
      (
        await w.call(101, 'PUT', `/leagues/${f.leagueA}/schedule-setup`, {
          seasonIds: [f.seasonA],
          fieldIds: [w.fieldId],
          addedFieldIds: [harbor]
        })
      ).status
    ).equals(200)
    const choose = async (fieldIds: string[]): Promise<void> => {
      const current = await w.call<{ settings: Record<string, unknown> }>(
        101,
        'GET',
        settingsPath
      )
      expect(
        (
          await w.call(101, 'PUT', settingsPath, {
            ...current.body.settings,
            fieldIds
          })
        ).status
      ).equals(200)
    }
    await choose([w.fieldId, harbor])
    const built = await build({ mode: 'full', existing: 'workAround' })
    expect(built.status).equals(201)
    const onHarbor = built.body.options[0].games.filter(
      game => game.fieldId === harbor
    )
    expect(onHarbor.length).greaterThan(0)
    await choose([w.fieldId])
    const recalculated = await build({
      mode: 'partial',
      fromPreviewId: built.body.id,
      option: 0
    })
    expect(recalculated.status).equals(201)
    for (const option of recalculated.body.options)
      expect(option.games.some(game => game.fieldId === harbor)).equals(false)
  })

  it('rejects a submitted key that collides with a booking created after preparation', async () => {
    const { f, teams } = w.fx
    const response = await f.h.request(
      'POST',
      `/leagues/${f.leagueA}/schedule-previews/preparations`,
      { mode: 'full', existing: 'workAround' },
      101
    )
    expect(response.status).equals(201)
    const prepared = asPreparedPreview(await response.json())
    const result = buildOptions(prepared.input)
    const game = result.options[0].games[0]
    game.key = 'live_after_prepare'
    await f.h.db
      .insertInto('games')
      .values({
        id: game.key,
        season_id: f.seasonB,
        home_team_id: teams.Owls,
        away_team_id: 'tem_account',
        field_id: game.fieldId,
        field_size: game.size,
        status: 'scheduled',
        start_at: new Date(game.startAt),
        end_at: new Date(game.endAt)
      })
      .execute()
    const completed = await f.h.request(
      'PUT',
      `/schedule-previews/${prepared.id}/result`,
      result,
      101
    )
    expect(completed.status, await completed.clone().text()).equals(200)
    const rejected = await publish(prepared.id)
    expect(rejected.status).equals(409)
    expect(JSON.stringify(rejected.body)).includes('identifier now matches')
    expect(
      (
        await f.h.db
          .selectFrom('games')
          .select('status')
          .where('id', '=', game.key)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('scheduled')
    expect(
      (
        await f.h.db
          .selectFrom('schedule_previews')
          .select('status')
          .where('id', '=', prepared.id)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('open')
    await f.h.db
      .updateTable('games')
      .set({ status: 'cancelled' })
      .where('id', '=', game.key)
      .execute()
    expect((await publish(prepared.id)).status).equals(200)
  })

  for (const moving of [false, true]) {
    it(`builds publishable options around external pending proposals (change=${moving})`, async () => {
      const { f, teams } = w.fx
      await f.h.db
        .updateTable('games')
        .set({ status: 'cancelled' })
        .where('season_id', '=', f.seasonA)
        .execute()
      await w.call(101, 'PUT', `/seasons/${f.seasonA}/schedule-settings`, {
        ...SEASON_A_SETTINGS,
        startsOn: '2027-03-13',
        endsOn: '2027-03-14',
        regularGames: moving ? 2 : 1,
        exhibitionGames: 0,
        maxGamesOnWeekdays: 1,
        maxGamesOnWeekend: moving ? 2 : 1
      })
      const id = 'external_pending_game'
      if (moving)
        await f.h.db
          .insertInto('games')
          .values({
            id,
            season_id: f.seasonA,
            home_team_id: teams.Hawks,
            away_team_id: teams.Owls,
            field_id: w.fieldId,
            field_size: '50/70',
            status: 'scheduled',
            start_at: new Date('2027-03-13T13:00:00Z'),
            end_at: new Date('2027-03-13T14:30:00Z')
          })
          .execute()
      await f.h.db
        .insertInto('group_requests')
        .values({
          id: 'external_pending_request',
          sender_scope_id: f.seasonA,
          sender_scope_type: 'season',
          sender_id: userIdOfGumbo(101),
          kind: 'game',
          sent_at: f.clock.now(),
          expires_at: new Date('2030-01-01'),
          ...(moving ? { game_id: id } : {}),
          terms: {
            ...(moving ? { gameId: id } : { proposedGameId: id }),
            game: {
              homeTeamId: teams.Hawks,
              awayTeamId: teams.Owls,
              seasonId: f.seasonA,
              fieldId: w.fieldId,
              fieldSize: '50/70',
              status: 'scheduled',
              startAt: '2027-03-14T14:00:00Z',
              endAt: '2027-03-14T15:30:00Z'
            }
          }
        })
        .execute()
      const result = await build({ mode: 'full', existing: 'workAround' })
      expect(result.status).equals(201)
      expect(result.body.options.length).greaterThan(0)
      const stored = await f.h.db
        .selectFrom('schedule_previews')
        .select('input')
        .where('id', '=', result.body.id)
        .executeTakeFirstOrThrow()
      const input = stored.input as {
        engine: { weeklyGames: Array<{ teamIds: string[]; start: number }> }
      }
      const holdings = input.engine.weeklyGames.filter(game =>
        game.teamIds.includes(teams.Hawks)
      )
      expect(holdings).length(1)
      expect(holdings[0].start).equals(Date.parse('2027-03-14T14:00:00Z'))
      if (!moving)
        expect(
          result.body.options[0].games.some(game =>
            [game.homeTeamId, game.awayTeamId].some(team =>
              [teams.Hawks, teams.Owls].includes(team)
            )
          )
        ).equals(false)
      expect((await publish(result.body.id)).status).equals(200)
    })
  }

  for (const editPublished of [false, true]) {
    it(`refuses a revoked administrator after acquiring the schedule lock (published edit=${editPublished})`, async () => {
      const { f } = w.fx
      const preview = (await build({ mode: 'full', existing: 'replace' })).body
      const path = `/schedule-previews/${preview.id}`
      const keys = preview.options[0].games.map(g => g.key)
      if (editPublished) expect((await publish(preview.id)).status).equals(200)
      else
        expect(
          (
            await w.call(101, 'PUT', path, {
              option: 0,
              rejectedGameKeys: keys
            })
          ).status
        ).equals(200)
      const games = f.h.db
        .selectFrom('games')
        .select(['id', 'status'])
        .orderBy('id')
      const before = await games.execute()
      await f.h.db
        .insertInto('scope_roles')
        .values({
          id: 'backup_league_admin',
          scope_type: 'league',
          scope_id: f.leagueA,
          role: 'admin',
          user_id: userIdOfGumbo(104)
        })
        .execute()
      let write: Promise<{ status: number }> | undefined
      await f.h.db.transaction().execute(async trx => {
        await lockKeys(trx, ['creation:parent-graph'])
        write = editPublished
          ? w.call(101, 'PUT', path, { option: 0, rejectedGameKeys: [keys[0]] })
          : publish(preview.id)
        const deadline = Date.now() + 5000
        while (true) {
          const waiting = await sql<{
            waiting: boolean
          }>`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event='advisory') as waiting`.execute(
            trx
          )
          if (waiting.rows[0].waiting) break
          if (Date.now() >= deadline)
            throw new Error('Scheduler did not wait for the authority change')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        await trx
          .deleteFrom('scope_roles')
          .where('scope_type', '=', 'league')
          .where('scope_id', '=', f.leagueA)
          .where('role', '=', 'admin')
          .where('user_id', '=', userIdOfGumbo(101))
          .execute()
      })
      expect((await write)?.status).equals(403)
      expect(await games.execute()).deep.equals(before)
    })
  }

  it('rechecks outside-league manager bookings and honors the saved switch', async () => {
    const { f } = w.fx
    const preview = (await build({ mode: 'full', existing: 'workAround' })).body
    const game = preview.options[0].games[0]
    const userId = userIdOfGumbo(104)
    await f.h.db
      .updateTable('users')
      .set({ merged_into: userId })
      .where('id', '=', userIdOfGumbo(106))
      .execute()
    await f.h.db
      .insertInto('scope_roles')
      .values(
        [game.homeTeamId, f.teamB].map(teamId => ({
          id: `role_${teamId}`,
          scope_type: 'team' as const,
          scope_id: teamId,
          role: 'coach' as const,
          user_id: teamId === f.teamB ? userIdOfGumbo(106) : userId,
          is_head_coach: true
        }))
      )
      .execute()
    await f.h.db
      .insertInto('games')
      .values({
        id: 'externalManagerGame',
        home_team_id: f.teamB,
        away_team_id: 'tem_account',
        season_id: f.seasonB,
        start_at: new Date(game.startAt),
        end_at: new Date(game.endAt),
        status: 'scheduled'
      })
      .execute()
    // The alias still carries the designation. Only the current account’s eligibility counts.
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: f.clock.now() })
      .where('id', '=', userId)
      .execute()
    const suspended = (await build({ mode: 'full', existing: 'workAround' }))
      .body
    expect(
      suspended.options[0].games.some(
        next =>
          next.startAt === game.startAt &&
          [next.homeTeamId, next.awayTeamId].includes(game.homeTeamId)
      )
    ).equals(true)
    await f.h.db
      .updateTable('users')
      .set({ disabled_at: null })
      .where('id', '=', userId)
      .execute()
    const edit = await w.call(101, 'PUT', `/schedule-previews/${preview.id}`, {
      option: 0,
      rejectedGameKeys: [game.key],
      addedGames: [game]
    })
    expect(edit.status).equals(400)
    expect(JSON.stringify(edit.body)).includes('Manager/Head Coach')
    const recalculated = await build({
      mode: 'partial',
      fromPreviewId: preview.id,
      option: 0
    })
    expect(recalculated.status).equals(409)
    expect(JSON.stringify(recalculated.body)).includes('Manager/Head Coach')
    const denied = await publish(preview.id)
    expect(denied.status).equals(409)
    expect(JSON.stringify(denied.body)).includes('Manager/Head Coach')
    const rebuilt = (await build({ mode: 'full', existing: 'workAround' })).body
    for (const option of rebuilt.options) {
      for (const next of option.games.filter(g =>
        [g.homeTeamId, g.awayTeamId].includes(game.homeTeamId)
      )) {
        expect(
          Date.parse(next.startAt) < Date.parse(game.endAt) &&
            Date.parse(game.startAt) < Date.parse(next.endAt)
        ).equals(false)
      }
    }
    // The original slot becomes available in the open preview when the
    // outside game is canceled. No league, season or field is shared.
    const addOriginal = async (): Promise<{ status: number; body: unknown }> =>
      await w.call(101, 'PUT', `/schedule-previews/${rebuilt.id}`, {
        option: 0,
        rejectedGameKeys: rebuilt.options[0].games.map(g => g.key),
        addedGames: [game]
      })
    expect((await addOriginal()).status).equals(400)
    await f.h.db
      .updateTable('games')
      .set({ status: 'cancelled' })
      .where('id', '=', 'externalManagerGame')
      .execute()
    expect((await addOriginal()).status).equals(200)
    await f.h.db
      .updateTable('games')
      .set({ status: 'scheduled' })
      .where('id', '=', 'externalManagerGame')
      .execute()
    const path = `/leagues/${f.leagueA}/schedule-setup`
    const old = await w.call<{
      seasonIds: string[]
      fieldIds: string[]
      avoidHeadCoachConflicts: boolean
    }>(101, 'GET', path)
    expect(old.body.avoidHeadCoachConflicts).equals(true)
    const choice = {
      seasonIds: old.body.seasonIds,
      fieldIds: old.body.fieldIds
    }
    const off = await w.call<typeof old.body>(101, 'PUT', path, {
      ...choice,
      avoidHeadCoachConflicts: false
    })
    expect(off.body.avoidHeadCoachConflicts).equals(false)
    expect(
      (await w.call<typeof old.body>(101, 'PUT', path, choice)).body
        .avoidHeadCoachConflicts
    ).equals(false)
    const unchecked = (await build({ mode: 'full', existing: 'workAround' }))
      .body
    expect(
      unchecked.options[0].games.some(
        next =>
          next.startAt === game.startAt &&
          [next.homeTeamId, next.awayTeamId].includes(game.homeTeamId)
      )
    ).equals(true)
    expect((await publish(unchecked.id)).status).equals(200)
  })

  it('avoids conflicts for a replacement team that left the selected season', async () => {
    const { f, teams } = w.fx
    await f.h.db
      .deleteFrom('season_team_parents')
      .where('team_id', '=', teams.Owls)
      .where('season_id', '=', f.seasonA)
      .execute()
    await f.h.db
      .updateTable('teams')
      .set({ league_id: f.leagueA })
      .where('id', '=', teams.Owls)
      .execute()
    await f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('team_id', '=', teams.Owls)
      .where('season_id', '=', f.seasonA)
      .execute()
    const request = {
      mode: 'partial',
      existing: 'replace',
      teamIds: [teams.Owls, teams.Hawks]
    }
    const original = (await build(request)).body.options[0].games[0]
    expect([original.homeTeamId, original.awayTeamId]).includes(teams.Owls)
    const setupPath = `/leagues/${f.leagueA}/schedule-setup`
    await w.call(101, 'PUT', setupPath, { avoidHeadCoachConflicts: false })
    await f.h.db
      .insertInto('games')
      .values({
        id: 'outside_team',
        season_id: f.seasonB,
        home_team_id: teams.Owls,
        away_team_id: 'tem_account',
        start_at: new Date(original.startAt),
        end_at: new Date(original.endAt),
        status: 'scheduled'
      })
      .execute()
    const off = (await build(request)).body
    for (const option of off.options) {
      const replacement = option.games.find(g =>
        [g.homeTeamId, g.awayTeamId].includes(teams.Owls)
      )!
      expect(
        replacement.startAt < original.endAt &&
          original.startAt < replacement.endAt
      ).equals(false)
    }
    await f.h.db
      .updateTable('games')
      .set({ status: 'cancelled' })
      .where('id', '=', 'outside_team')
      .execute()
    await w.call(101, 'PUT', setupPath, { avoidHeadCoachConflicts: true })
    await f.h.db
      .insertInto('scope_roles')
      .values(
        [teams.Owls, f.teamB].map(team => ({
          id: 'partial_' + team,
          scope_type: 'team' as const,
          scope_id: team,
          role: 'coach' as const,
          is_head_coach: true,
          user_id: userIdOfGumbo(104)
        }))
      )
      .execute()
    await f.h.db
      .insertInto('games')
      .values({
        id: 'outside_partial',
        season_id: f.seasonB,
        home_team_id: f.teamB,
        away_team_id: 'tem_account',
        start_at: new Date(original.startAt),
        end_at: new Date(original.endAt),
        status: 'scheduled'
      })
      .execute()
    const next = (await build(request)).body
    for (const option of next.options) {
      const game = option.games.find(g =>
        [g.homeTeamId, g.awayTeamId].includes(teams.Owls)
      )!
      expect(
        game.startAt < original.endAt && original.startAt < game.endAt
      ).equals(false)
    }
    const recalculated = (
      await build({
        mode: 'partial',
        fromPreviewId: next.id,
        option: 0
      })
    ).body
    const kept = recalculated.options[0].games.find(game =>
      [game.homeTeamId, game.awayTeamId].includes(teams.Owls)
    )!
    await f.h.db
      .updateTable('games')
      .set({
        start_at: new Date(kept.startAt),
        end_at: new Date(kept.endAt)
      })
      .where('id', '=', 'outside_partial')
      .execute()
    const denied = await publish(recalculated.id)
    expect(denied.status).equals(409)
    expect(JSON.stringify(denied.body)).includes('Manager/Head Coach')
    await f.h.db
      .updateTable('games')
      .set({ status: 'cancelled' })
      .where('id', '=', 'outside_partial')
      .execute()
    expect((await publish(recalculated.id)).status).equals(200)
  })

  it('keeps an outside manager committed without reserving the old field', async () => {
    const { f } = w.fx
    const request = { mode: 'full', existing: 'workAround' }
    const before = (await build(request)).body
    const game = before.options[0].games[0]
    const unrelated = participants().find(
      team => ![game.homeTeamId, game.awayTeamId].includes(team)
    )!
    const coach = userIdOfGumbo(104)
    await f.h.db
      .insertInto('scope_roles')
      .values(
        [f.teamB, unrelated].map(team => ({
          id: 'moving_' + team,
          scope_type: 'team' as const,
          scope_id: team,
          role: 'coach' as const,
          user_id: coach,
          is_head_coach: true
        }))
      )
      .execute()
    const moved = 'outside_move'
    await f.h.db
      .insertInto('games')
      .values({
        id: moved,
        season_id: f.seasonB,
        home_team_id: f.teamB,
        away_team_id: 'tem_account',
        field_id: game.fieldId,
        field_size: game.size,
        status: 'scheduled',
        start_at: new Date(game.startAt),
        end_at: new Date(game.endAt)
      })
      .execute()
    await f.h.db
      .insertInto('group_requests')
      .values(
        ['2029-03-01', '2029-03-02'].map(day => ({
          id: 'pending_move_' + day,
          sender_scope_id: f.teamB,
          sender_scope_type: 'team' as const,
          kind: 'game' as const,
          sender_id: coach,
          game_id: moved,
          sent_at: f.clock.now(),
          expires_at: new Date('2030-01-01'),
          terms: {
            gameId: moved,
            game: {
              homeTeamId: f.teamB,
              awayTeamId: 'tem_account',
              seasonId: f.seasonB,
              startAt: day + 'T10:00:00Z',
              endAt: day + 'T11:30:00Z',
              status: 'scheduled'
            }
          }
        }))
      )
      .execute()
    const next = (await build(request)).body
    const input = await f.h.db
      .selectFrom('schedule_previews')
      .select('input')
      .where('id', '=', next.id)
      .executeTakeFirstOrThrow()
    const snapshot = input.input as {
      engine: {
        bookings: Array<{
          key: string
          managerOnly?: boolean
          fieldId: string
          start: number
        }>
      }
    }
    expect(
      snapshot.engine.bookings.find(
        b => b.key === moved && b.managerOnly === true
      )
    ).includes({ fieldId: game.fieldId })
    expect(
      snapshot.engine.bookings.filter(b => b.key === moved).map(b => b.start)
    ).to.have.members([
      Date.parse(game.startAt),
      Date.parse('2029-03-01T10:00:00Z'),
      Date.parse('2029-03-02T10:00:00Z')
    ])
    // Keep only the unrelated matchup at the original time, then publish it.
    const edited = await w.call(101, 'PUT', `/schedule-previews/${next.id}`, {
      option: 0,
      rejectedGameKeys: next.options[0].games.map(g => g.key),
      addedGames: [game]
    })
    expect(edited.status, JSON.stringify(edited.body)).equals(200)
    expect((await publish(next.id)).status).equals(200)
  })

  it('allows only one of two leagues publishing overlapping games for the same manager', async () => {
    const { f } = w.fx
    const first = (await build({ mode: 'full', existing: 'workAround' })).body
    const game = first.options[0].games[0]
    const fieldId = await seedHarborField(w.fx)
    await f.h.db
      .updateTable('venue_fields')
      .set({
        windows: JSON.stringify([
          {
            from: '0001-01-01',
            hours: Array.from({ length: 7 }, (_, weekday) => ({
              weekday,
              start: '00:00',
              end: '23:55'
            }))
          }
        ])
      })
      .where('id', '=', fieldId)
      .execute()
    const made = await w.call<{ id: string }>(102, 'POST', '/teams', {
      name: 'Demo Sparrows',
      locality: demoLocality,
      parent: { kind: 'season', id: f.seasonB },
      idempotencyKey: 'parallel-manager'
    })
    expect(made.status).equals(201)
    await f.h.db
      .insertInto('season_teams')
      .values(
        [f.teamB, made.body.id].map(teamId => ({
          team_id: teamId,
          season_id: f.seasonB,
          active: true
        }))
      )
      .onConflict(oc => oc.columns(['team_id', 'season_id']).doNothing())
      .execute()
    // League B lists League A's field before its season chooses it.
    expect(
      (
        await w.call(102, 'PUT', `/leagues/${f.leagueB}/schedule-setup`, {
          seasonIds: [f.seasonB],
          fieldIds: [fieldId],
          addedFieldIds: [fieldId]
        })
      ).status
    ).equals(200)
    expect(
      (
        await w.call(102, 'PUT', `/seasons/${f.seasonB}/schedule-settings`, {
          ...SEASON_A_SETTINGS,
          fieldIds: [fieldId],
          regularGames: 1,
          exhibitionGames: 0
        })
      ).status
    ).equals(200)
    const second = (
      await w.call<SchedulePreview>(
        102,
        'POST',
        `/leagues/${f.leagueB}/schedule-previews/preparations`,
        { mode: 'full', existing: 'workAround' }
      )
    ).body
    const edit = await w.call(102, 'PUT', `/schedule-previews/${second.id}`, {
      option: 0,
      rejectedGameKeys: second.options[0].games.map(g => g.key),
      addedGames: [
        {
          ...game,
          seasonId: f.seasonB,
          fieldId,
          homeTeamId: f.teamB,
          awayTeamId: made.body.id,
          exhibition: false
        }
      ]
    })
    expect(edit.status, JSON.stringify(edit.body)).equals(200)
    await f.h.db
      .insertInto('scope_roles')
      .values(
        [game.homeTeamId, f.teamB].map(teamId => ({
          id: `coach_${teamId}`,
          user_id: userIdOfGumbo(104),
          scope_id: teamId,
          scope_type: 'team' as const,
          role: 'coach' as const,
          is_head_coach: true
        }))
      )
      .execute()
    const results = await Promise.all([
      publish(first.id),
      publish(second.id, 0, 102)
    ])
    expect(results.map(r => r.status).sort((a, b) => a - b)).deep.equals([
      200, 409
    ])
    expect(JSON.stringify(results.find(r => r.status === 409)?.body)).includes(
      'Manager/Head Coach'
    )
  })

  it('releases a replaced game and its pending change from manager commitments', async () => {
    const { f, teams } = w.fx
    const first = (await build({ mode: 'full', existing: 'replace' })).body
    const game = first.options[0].games.find(g =>
      [g.homeTeamId, g.awayTeamId].includes(teams.Hawks)
    )!
    const current = await w.call<{
      version: string
      game: Record<string, unknown>
    }>(101, 'GET', `/games/${G1}/scheduling`)
    await f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('team_id', '=', teams.Visitors)
      .where('season_id', '=', f.seasonA)
      .execute()
    const sent = await w.call<{ id: string; status: string }>(
      101,
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: f.seasonA },
        gameId: G1,
        expected: current.body.version,
        game: {
          ...current.body.game,
          homeTeamId: teams.Hawks,
          awayTeamId: teams.Visitors,
          startAt: game.startAt,
          endAt: game.endAt
        },
        idempotencyKey: 'pending-manager-replacement'
      }
    )
    expect(sent.body.status).equals('pending')
    await f.h.db
      .insertInto('scope_roles')
      .values({
        id: 'replacedManager',
        user_id: userIdOfGumbo(104),
        scope_type: 'team',
        scope_id: teams.Hawks,
        role: 'coach',
        is_head_coach: true
      })
      .execute()
    const replacing = (await build({ mode: 'full', existing: 'replace' })).body
    const stored = await f.h.db
      .selectFrom('schedule_previews')
      .select('input')
      .where('id', '=', replacing.id)
      .executeTakeFirstOrThrow()
    const snapshot = stored.input as {
      replaceGameIds: string[]
      engine: { bookings: Array<{ key: string }> }
    }
    expect(snapshot.replaceGameIds).includes(G1)
    expect(
      snapshot.engine.bookings.some(
        booking => booking.key === G1 || booking.key === `pending:${G1}`
      )
    ).equals(false)
    const edit = await w.call(
      101,
      'PUT',
      `/schedule-previews/${replacing.id}`,
      {
        option: 0,
        rejectedGameKeys: replacing.options[0].games.map(g => g.key),
        addedGames: [game]
      }
    )
    expect(edit.status, JSON.stringify(edit.body)).equals(200)
    expect((await publish(replacing.id)).status).equals(200)
    expect(
      (
        await f.h.db
          .selectFrom('group_requests')
          .select('status')
          .where('id', '=', sent.body.id)
          .executeTakeFirstOrThrow()
      ).status
    ).equals('superseded')
  })

  it('asks about existing games, works around them, and publishes every game at once', async () => {
    const asked = await build({ mode: 'full' })
    expect(asked.status).equals(409)
    expect((asked.body as unknown as { details: unknown }).details).deep.equals(
      { existingGames: 2 }
    )
    const built = await build({ mode: 'full', existing: 'workAround' })
    expect(built.status).equals(201)
    const preview = built.body
    expect(preview).include({
      status: 'open',
      existing: 'workAround',
      replacing: 0,
      blocking: null
    })
    expect(preview.options.length).within(1, 3)
    const [best] = preview.options
    // Everyone gets the same counts, the fixed G1 and noon game included,
    // and the exhibition teams split 4 and 3.
    for (const id of participants()) {
      const row = best.fairness.find(item => item.teamId === id)!
      expect([row.regularGames, row.exhibitionGames], id).deep.equals([4, 1])
    }
    expect(
      best.fairness
        .filter(row => row.exhibitionTeam)
        .map(row => row.exhibitionGames)
        .sort((a, b) => a - b)
    ).deep.equals([3, 4])
    expect(best.games.length).equals(12 + 7)
    // No game overlaps the fixed ones on Field 1.
    const fixed = await w.fx.f.h.db
      .selectFrom('games')
      .select(['start_at', 'end_at'])
      .where('field_id', '=', w.fieldId)
      .execute()
    for (const game of best.games)
      for (const held of fixed)
        expect(
          Date.parse(game.startAt) < held.end_at!.getTime() &&
            held.start_at.getTime() < Date.parse(game.endAt),
          game.key
        ).equals(false)
    const published = await publish(preview.id)
    expect(published.status).equals(200)
    expect(published.body).include({ scheduled: 19, awaiting: 0, removed: 0 })
    expect(published.body.preview.status).equals('published')
    const games = await w.fx.f.h.db
      .selectFrom('games')
      .select(['status', 'field_id', 'field_size', 'venue'])
      .where('schedule_preview_id', '=', preview.id)
      .execute()
    expect(games.length).equals(19)
    for (const game of games)
      expect(game).deep.equals({
        status: 'scheduled',
        field_id: w.fieldId,
        field_size: '50/70',
        venue: 'Example Park'
      })
    const notices = await w.fx.f.h.db
      .selectFrom('notification_events')
      .select(['metadata'])
      .where('source_type', '=', 'schedulePublished')
      .execute()
    expect(notices.length).equals(9)
    expect(
      notices
        .map(row => row.metadata as { title: string; description: string })
        .find(item => item.title.endsWith('Demo Visitors'))
    ).include({
      title: 'Demo Regular schedule updated for Demo Visitors',
      description: '5 games scheduled.'
    })
    // A retry, by another league admin, publishes nothing more.
    const again = await publish(preview.id, 0, 105)
    expect(again.status).equals(200)
    expect(again.body).include({ scheduled: 19, awaiting: 0 })
    expect(
      (
        await w.fx.f.h.db
          .selectFrom('schedule_preview_games')
          .select('game_key')
          .where('preview_id', '=', preview.id)
          .execute()
      ).length
    ).equals(19)
    const read = await w.call<SchedulePreview>(
      101,
      'GET',
      `/schedule-previews/${preview.id}`
    )
    expect(
      read.body.published.every(game => game.state === 'scheduled')
    ).equals(true)
  })

  it('replaces the league’s upcoming games, reusing their time, and they leave the schedules', async () => {
    const built = await build({ mode: 'full', existing: 'replace' })
    expect(built.status).equals(201)
    expect(built.body.replacing).equals(2)
    const best = built.body.options[0]
    expect(best.games.length).equals(14 + 7)
    const published = await publish(built.body.id)
    expect(published.body).include({ scheduled: 21, removed: 2 })
    const g1 = await w.fx.f.h.db
      .selectFrom('games')
      .select(['status', 'cancellation_reason'])
      .where('id', '=', G1)
      .executeTakeFirstOrThrow()
    expect(g1).deep.equals({
      status: 'cancelled',
      cancellation_reason: 'rescheduled'
    })
    const owls = await w.call<Array<{ id: string }>>(
      101,
      'GET',
      `/teams/${w.fx.teams.Owls}/games`
    )
    expect(owls.status).equals(200)
    expect(owls.body.map(game => game.id)).not.includes(G1)
    const removed = await w.fx.f.h.db
      .selectFrom('notification_events')
      .select('metadata')
      .where('source_type', '=', 'schedulePublished')
      .execute()
    const owlsNotice = removed.find(
      row => (row.metadata as { teamId?: string }).teamId === w.fx.teams.Owls
    )
    expect(
      (owlsNotice?.metadata as { description: string }).description
    ).includes('1 earlier game removed')
  })

  it('refuses a build whose counted waiting proposal was declined since, and keeps the game listed', async () => {
    const first = await build({ mode: 'full', existing: 'workAround' })
    await w.fx.f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('season_id', '=', w.fx.f.seasonA)
      .where('team_id', '=', w.fx.teams.Visitors)
      .execute()
    expect((await publish(first.body.id)).body.awaiting).equals(5)
    const next = await build({ mode: 'full', existing: 'workAround' })
    const waiting = await w.fx.f.h.db
      .selectFrom('schedule_preview_games')
      .select(['request_id', 'game_key'])
      .where('preview_id', '=', first.body.id)
      .where('game_id', 'is', null)
      .executeTakeFirstOrThrow()
    expect(
      (
        await w.call(
          103,
          'POST',
          `/game-requests/${waiting.request_id}/decline`
        )
      ).status
    ).equals(200)
    const refused = await publish(next.body.id)
    expect(refused.status).equals(409)
    expect(
      JSON.stringify((refused.body as unknown as { details: unknown }).details)
    ).includes('counted on was canceled, declined or withdrawn')
    // Still waiting to be placed again.
    const listed = await w.call<{ items: Array<{ gameKey: string }> }>(
      101,
      'GET',
      `/leagues/${w.fx.f.leagueA}/games-to-reschedule`
    )
    expect(listed.body.items.map(item => item.gameKey)).includes(
      waiting.game_key
    )
  })

  it('keeps a game listed after the build listed when a recalculation of that build is published', async () => {
    const first = await build({ mode: 'full', existing: 'workAround' })
    await w.fx.f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('season_id', '=', w.fx.f.seasonA)
      .where('team_id', '=', w.fx.teams.Visitors)
      .execute()
    expect((await publish(first.body.id)).body.awaiting).equals(5)
    // Replacing the scheduled games, it counts the waiting ones.
    const next = await build({ mode: 'full', existing: 'replace' })
    expect(next.body.options[0].games.length).greaterThan(0)
    const waiting = await w.fx.f.h.db
      .selectFrom('schedule_preview_games')
      .select(['request_id', 'game_key'])
      .where('preview_id', '=', first.body.id)
      .where('game_id', 'is', null)
      .executeTakeFirstOrThrow()
    await w.call(103, 'POST', `/game-requests/${waiting.request_id}/decline`)
    // One game rejected and placed again: nothing places the declined one.
    await w.call(101, 'PUT', `/schedule-previews/${next.body.id}`, {
      option: 0,
      rejectedGameKeys: [next.body.options[0].games[0].key]
    })
    const again = await build({
      mode: 'partial',
      fromPreviewId: next.body.id,
      option: 0
    })
    expect(again.status).equals(201)
    expect((await publish(again.body.id)).status).equals(200)
    const listed = await w.call<{ items: Array<{ gameKey: string }> }>(
      101,
      'GET',
      `/leagues/${w.fx.f.leagueA}/games-to-reschedule`
    )
    expect(listed.body.items.map(item => item.gameKey)).includes(
      waiting.game_key
    )
  })

  it('refuses a second open preview of the league once another is published, naming its waiting games too', async () => {
    const one = await build({ mode: 'full', existing: 'workAround' })
    const two = await build({ mode: 'full', existing: 'workAround' })
    await w.fx.f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('season_id', '=', w.fx.f.seasonA)
      .where('team_id', '=', w.fx.teams.Visitors)
      .execute()
    const published = await publish(one.body.id)
    expect(published.body).include({ scheduled: 14, awaiting: 5 })
    const refused = await publish(two.body.id)
    expect(refused.status).equals(409)
    const stale = (
      refused.body as unknown as {
        details: { stale: Array<{ gameKey: string; problem: string }> }
      }
    ).details.stale
    // The proposals still waiting count as much as the games scheduled.
    expect(
      stale.filter(item => item.problem.startsWith('A game was proposed'))
        .length
    ).equals(5)
  })

  it('holds the time a pending change to a counted game proposes, and publishes', async () => {
    const first = await build({ mode: 'full', existing: 'workAround' })
    expect((await publish(first.body.id)).status).equals(200)
    await w.fx.f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('season_id', '=', w.fx.f.seasonA)
      .where('team_id', '=', w.fx.teams.Visitors)
      .execute()
    const visitors = await w.fx.f.h.db
      .selectFrom('games')
      .select('id')
      .where('schedule_preview_id', '=', first.body.id)
      .where(eb =>
        eb.or([
          eb('home_team_id', '=', w.fx.teams.Visitors),
          eb('away_team_id', '=', w.fx.teams.Visitors)
        ])
      )
      .executeTakeFirstOrThrow()
    const current = await w.call<{
      version: string
      game: { startAt: string; endAt: string }
    }>(101, 'GET', `/games/${visitors.id}/scheduling`)
    // Moved a day later, it waits for the Visitors' admin.
    const later = (at: string): string =>
      new Date(Date.parse(at) + 24 * 60 * 60 * 1000).toISOString()
    const startAt = later(current.body.game.startAt)
    const sent = await w.call<{ status: string }>(
      101,
      'POST',
      '/game-requests',
      {
        sender: { kind: 'season', id: w.fx.f.seasonA },
        gameId: visitors.id,
        expected: current.body.version,
        game: {
          ...current.body.game,
          startAt,
          endAt: later(current.body.game.endAt)
        },
        idempotencyKey: 'pending-change'
      }
    )
    expect(sent.body.status).equals('pending')
    // The pending change reserves both intervals for another team this manager coaches.
    await w.fx.f.h.db
      .insertInto('scope_roles')
      .values(
        [w.fx.teams.Visitors, w.fx.teams.Hawks].map(teamId => ({
          id: `coach_${teamId}`,
          scope_type: 'team' as const,
          scope_id: teamId,
          user_id: userIdOfGumbo(104),
          role: 'coach' as const,
          is_head_coach: true
        }))
      )
      .execute()
    const next = await build({ mode: 'full', existing: 'workAround' })
    expect(next.status).equals(201)
    const stored = await w.fx.f.h.db
      .selectFrom('schedule_previews')
      .select('input')
      .where('id', '=', next.body.id)
      .executeTakeFirstOrThrow()
    const input = stored.input as {
      engine: { bookings: Array<{ key: string; start: number }> }
    }
    expect(
      input.engine.bookings.find(
        booking => booking.key === `pending:${visitors.id}`
      )?.start
    ).equals(Date.parse(startAt))
    expect((await publish(next.body.id)).status).equals(200)
  })

  it('refuses a Replace build once a game it replaces was played, and answers the count it stored', async () => {
    const built = await build({ mode: 'full', existing: 'replace' })
    expect(built.body.replacing).equals(2)
    const played = async (status: 'final' | 'scheduled'): Promise<void> => {
      await w.fx.f.h.db
        .updateTable('games')
        .set({ status })
        .where('id', '=', G1)
        .execute()
    }
    await played('final')
    const refused = await publish(built.body.id)
    expect(refused.status).equals(409)
    expect(
      JSON.stringify((refused.body as unknown as { details: unknown }).details)
    ).includes('A game this preview replaces was played, canceled or moved')
    await played('scheduled')
    const published = await publish(built.body.id)
    expect(published.status).equals(200)
    expect(published.body.removed).equals(2)
    // Asked again, it answers the same.
    expect((await publish(built.body.id)).body.removed).equals(2)
  })

  it('refuses an option whose games’ time has passed since the build', async () => {
    const built = await build({ mode: 'full', existing: 'workAround' })
    const [first] = built.body.options[0].games
    w.fx.f.advance(Date.parse(first.startAt) - Date.now() + 60 * 1000)
    const refused = await publish(built.body.id)
    expect(refused.status).equals(409)
    const stale = (
      refused.body as unknown as {
        details: { stale: Array<{ gameKey: string; problem: string }> }
      }
    ).details.stale
    expect(stale).to.deep.include({
      gameKey: first.key,
      problem: 'This game’s time has passed.'
    })
  })

  it('serializes two publishes of one preview', async () => {
    const built = await build({ mode: 'full', existing: 'workAround' })
    const [one, two] = await Promise.all([
      publish(built.body.id),
      publish(built.body.id, 0, 105)
    ])
    expect([one.status, two.status]).deep.equals([200, 200])
    expect(
      (
        await w.fx.f.h.db
          .selectFrom('games')
          .select('id')
          .where('schedule_preview_id', '=', built.body.id)
          .execute()
      ).length
    ).equals(19)
  })

  it('answers 409 when a field booking, a new game or a merged team changed things since the build', async () => {
    const built = await build({ mode: 'full', existing: 'workAround' })
    const first = built.body.options[0].games[0]
    // Another league's game on the field, at the first game's time.
    await w.fx.f.h.db
      .insertInto('games')
      .values({
        id: 'gam_elsewhere',
        home_team_id: w.fx.f.teamB,
        away_team_id: w.fx.f.standaloneTeam,
        start_at: new Date(first.startAt),
        end_at: new Date(first.endAt),
        status: 'scheduled',
        field_id: w.fieldId,
        field_size: '50/70'
      })
      .execute()
    const stale = await publish(built.body.id)
    expect(stale.status).equals(409)
    expect(
      (
        stale.body as unknown as {
          details: { stale: Array<{ gameKey: string }> }
        }
      ).details.stale.map(item => item.gameKey)
    ).includes(first.key)
    await w.fx.f.h.db
      .deleteFrom('games')
      .where('id', '=', 'gam_elsewhere')
      .execute()
    // A new game in the season.
    await w.fx.f.h.db
      .insertInto('games')
      .values({
        id: 'gam_new',
        home_team_id: w.fx.teams.Foxes,
        away_team_id: w.fx.teams.Rockets,
        season_id: w.fx.f.seasonA,
        start_at: new Date('2027-07-30T12:00:00.000Z'),
        status: 'scheduled'
      })
      .execute()
    expect((await publish(built.body.id)).status).equals(409)
    await w.fx.f.h.db.deleteFrom('games').where('id', '=', 'gam_new').execute()
    // A merged team.
    await w.fx.f.h.db
      .updateTable('teams')
      .set({ merged_into: w.fx.teams.Hawks })
      .where('id', '=', w.fx.teams.Rockets)
      .execute()
    expect((await publish(built.body.id)).status).equals(409)
    await w.fx.f.h.db
      .updateTable('teams')
      .set({ merged_into: null })
      .where('id', '=', w.fx.teams.Rockets)
      .execute()
    expect((await publish(built.body.id)).status).equals(200)
  })

  for (const edit of [true, false]) {
    it(`accepts a game while its preview waits for the graph lock (edit=${edit})`, async () => {
      const { f, teams } = w.fx
      const preview = (await build({ mode: 'full', existing: 'workAround' }))
        .body
      await f.h.db
        .updateTable('season_teams')
        .set({ active: false })
        .where('season_id', '=', f.seasonA)
        .where('team_id', '=', teams.Visitors)
        .execute()
      expect((await publish(preview.id)).status).equals(200)
      const waiting = await f.h.db
        .selectFrom('schedule_preview_games')
        .select('request_id')
        .where('preview_id', '=', preview.id)
        .where('game_id', 'is', null)
        .executeTakeFirstOrThrow()
      let writer: Promise<{ status: number }> | undefined
      await atomic(f.h.db, async trx => {
        await lockKeys(trx, ['creation:parent-graph'])
        writer = edit
          ? w.call(101, 'PUT', `/schedule-previews/${preview.id}`, {
              option: 0,
              rejectedGameKeys: [],
              addedGames: []
            })
          : publish(preview.id)
        const deadline = Date.now() + 5000
        while (true) {
          const result = await sql<{
            waiting: boolean
          }>`select exists(select 1 from pg_stat_activity where datname=current_database() and wait_event='advisory') as waiting`.execute(
            trx
          )
          if (result.rows[0].waiting) break
          if (Date.now() >= deadline)
            throw new Error('Preview writer did not reach the graph lock')
          await new Promise(resolve => setTimeout(resolve, 10))
        }
        const accepted = await decideGameRequest(
          trx,
          { userId: userIdOfGumbo(103), isAdmin: false, scopes: [] },
          waiting.request_id!,
          'accept',
          f.clock
        )
        expect(accepted.game_id).not.equals(null)
      })
      expect((await writer)?.status).equals(200)
    })
  }

  it('leaves a game waiting when the approval rules say so, and its acceptance links it to the preview', async () => {
    const built = await build({ mode: 'full', existing: 'workAround' })
    // The Visitors stop competing after the build, so their games need
    // their admin's approval.
    await w.fx.f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('season_id', '=', w.fx.f.seasonA)
      .where('team_id', '=', w.fx.teams.Visitors)
      .execute()
    const published = await publish(built.body.id)
    expect(published.status).equals(200)
    expect(published.body.awaiting).equals(5)
    expect(published.body.scheduled).equals(14)
    const waiting = await w.fx.f.h.db
      .selectFrom('schedule_preview_games')
      .select(['request_id', 'game_id', 'game_key'])
      .where('preview_id', '=', built.body.id)
      .where('game_id', 'is', null)
      .execute()
    expect(waiting.length).equals(5)
    const request = await w.fx.f.h.db
      .selectFrom('group_requests')
      .select(['terms', 'status'])
      .where('id', '=', waiting[0].request_id!)
      .executeTakeFirstOrThrow()
    expect(request.status).equals('pending')
    expect(
      (request.terms as { schedulePreviewId?: string }).schedulePreviewId
    ).equals(built.body.id)
    const accepted = await w.call<{ gameId: string }>(
      103,
      'POST',
      `/game-requests/${waiting[0].request_id}/accept`
    )
    expect(accepted.status).equals(200)
    const game = await w.fx.f.h.db
      .selectFrom('games')
      .select('schedule_preview_id')
      .where('id', '=', accepted.body.gameId)
      .executeTakeFirstOrThrow()
    expect(game.schedule_preview_id).equals(built.body.id)
    const row = await w.fx.f.h.db
      .selectFrom('schedule_preview_games')
      .select('game_id')
      .where('preview_id', '=', built.body.id)
      .where('game_key', '=', waiting[0].game_key)
      .executeTakeFirstOrThrow()
    expect(row.game_id).equals(accepted.body.gameId)
  })

  it('publishes a build that counted a waiting proposal accepted since', async () => {
    const first = await build({ mode: 'full', existing: 'workAround' })
    await w.fx.f.h.db
      .updateTable('season_teams')
      .set({ active: false })
      .where('season_id', '=', w.fx.f.seasonA)
      .where('team_id', '=', w.fx.teams.Visitors)
      .execute()
    expect((await publish(first.body.id)).body.awaiting).equals(5)
    // The next build holds the waiting games' places and counts them.
    const next = await build({ mode: 'full', existing: 'workAround' })
    expect(next.status).equals(201)
    const waiting = await w.fx.f.h.db
      .selectFrom('schedule_preview_games')
      .select('request_id')
      .where('preview_id', '=', first.body.id)
      .where('game_id', 'is', null)
      .executeTakeFirstOrThrow()
    expect(
      (await w.call(103, 'POST', `/game-requests/${waiting.request_id}/accept`))
        .status
    ).equals(200)
    // Its game is the one the build counted, not a new one.
    const published = await publish(next.body.id)
    expect(published.status).equals(200)
  })

  it('recalculates a Replace build without placing the replaced games again', async () => {
    const built = await build({ mode: 'full', existing: 'replace' })
    const option = built.body.options[0]
    expect(option.games.length).equals(14 + 7)
    const rejected = option.games[0]
    await w.call(101, 'PUT', `/schedule-previews/${built.body.id}`, {
      option: 0,
      rejectedGameKeys: [rejected.key]
    })
    const again = await build({
      mode: 'partial',
      fromPreviewId: built.body.id,
      option: 0
    })
    expect(again.status).equals(201)
    const next = again.body.options[0]
    expect(next.games.length).equals(option.games.length)
    expect(next.games.some(game => game.key.startsWith('replaced:'))).equals(
      false
    )
    for (const id of participants()) {
      const row = next.fairness.find(item => item.teamId === id)!
      expect([row.regularGames, row.exhibitionGames], id).deep.equals([4, 1])
    }
    const published = await publish(again.body.id)
    expect(published.body).include({ scheduled: 21, removed: 2 })
  })
})
