import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { migration063GameStarted } from '../../migrate/migrations/063gameStarted'
import { type GroupFixture, groupFixture } from '../../test/groupFixtures'

describe('remaining scoring on game detail and schedules', function () {
  this.timeout(60000)
  let f: GroupFixture
  const id = 'gam_live_policy_demo'
  before(async () => {
    f = await groupFixture()
    await f.h.db
      .insertInto('games')
      .values({
        id,
        home_team_id: f.teamA,
        away_team_id: f.teamB,
        season_id: f.seasonA,
        start_at: new Date(),
        status: 'inProgress'
      })
      .execute()
  })
  after(async () => {
    await f?.h.close()
  })

  async function check(expected: boolean, live = expected): Promise<void> {
    for (const user of [101, null]) {
      for (const path of [
        `/games/${id}`,
        ...(user == null ? [] : [`/teams/${f.teamA}/games`]),
        `/teams/${f.teamA}`
      ]) {
        const response = await f.h.request('GET', path, undefined, user)
        expect(response.status, path).equals(200)
        const body = await response.json()
        const game =
          path === `/games/${id}`
            ? body
            : (Array.isArray(body) ? body : body.games).find(
                (g: { id: string }) => g.id === id
              )
        expect(game.hasScoringEvents, path).equals(expected)
        expect(game.isGameLive, path).equals(live)
      }
    }
  }

  it('does not count initialized at-bats, and follows pitches, plays and their removal', async () => {
    await f.h.db
      .updateTable('games')
      .set({
        currentPlay: { about: { inning: 1 }, teamStation: { actions: [] } }
      })
      .where('id', '=', id)
      .execute()
    await check(false)
    await f.h.db
      .updateTable('games')
      .set({
        currentPlay: {
          teamStation: { actions: [{ type: 'pitch', kind: 'ball' }] }
        }
      })
      .where('id', '=', id)
      .execute()
    await check(true)
    await f.h.db
      .updateTable('games')
      .set({ currentPlay: null })
      .where('id', '=', id)
      .execute()
    await check(false)
    await f.h.db
      .insertInto('events')
      .values({
        id: 'evt_live_policy_demo',
        gameId: id,
        gumbo: {
          about: { atBatIndex: 0 },
          result: { eventType: 'walk' },
          playEvents: [{ isPitch: true }]
        }
      })
      .execute()
    await check(true)
    await f.h.db.deleteFrom('events').where('gameId', '=', id).execute()
    await check(false)
  })

  it('excludes roster and setup actions from current and completed plays', async () => {
    for (const action of [
      { type: 'lineup', kind: 'roster' },
      { type: 'lineup', kind: 'substitute' },
      { type: 'gameFlow', kind: 'placeRunner' },
      { type: 'gameFlow', kind: 'override' },
      { type: 'result', eventType: 'manual_placement' }
    ]) {
      const gumbo = {
        about: { atBatIndex: 0 },
        result: { eventType: 'defensive_switch' },
        teamStation: { actions: [action] },
        playEvents: [{ isPitch: false, isSubstitution: true }]
      }
      await f.h.db
        .updateTable('games')
        .set({ currentPlay: gumbo })
        .where('id', '=', id)
        .execute()
      await check(false)
      await f.h.db
        .insertInto('events')
        .values({ id: 'evt_setup_demo', gameId: id, gumbo })
        .execute()
      await check(false)
      await f.h.db.deleteFrom('events').where('gameId', '=', id).execute()
    }
    for (const gumbo of [
      { teamStation: { actions: [{ type: 'ballInPlay', contact: 'swing' }] } },
      { playEvents: [{ details: { isInPlay: true } }] },
      { playEvents: [{ isPitch: true }] }
    ]) {
      await f.h.db
        .updateTable('games')
        .set({ currentPlay: gumbo })
        .where('id', '=', id)
        .execute()
      await check(true)
    }
  })

  it('repairs stale in-progress statuses without changing final, cancelled or scored games', async () => {
    for (const [suffix, status, currentPlay] of [
      [
        'setup',
        'inProgress',
        { teamStation: { actions: [{ type: 'lineup' }] } }
      ],
      ['pitch', 'inProgress', { playEvents: [{ isPitch: true }] }],
      ['stored', 'inProgress', null],
      ['final', 'final', null],
      ['cancelled', 'cancelled', null]
    ] as const) {
      await f.h.db
        .insertInto('games')
        .values({
          id: `gam_repair_${suffix}`,
          home_team_id: f.teamA,
          away_team_id: f.teamB,
          start_at: new Date(),
          status,
          currentPlay
        })
        .execute()
    }
    await f.h.db
      .insertInto('events')
      .values({
        id: 'evt_repair_stored',
        gameId: 'gam_repair_stored',
        gumbo: { about: { atBatIndex: 0 }, playEvents: [{ isPitch: true }] }
      })
      .execute()
    await sql.raw(migration063GameStarted.down).execute(f.h.db)
    await sql.raw(migration063GameStarted.up).execute(f.h.db)
    const games = await f.h.db
      .selectFrom('games')
      .select(['id', 'status'])
      .where('id', 'like', 'gam_repair_%')
      .execute()
    expect(Object.fromEntries(games.map(g => [g.id, g.status]))).deep.equals({
      gam_repair_setup: 'scheduled',
      gam_repair_pitch: 'inProgress',
      gam_repair_stored: 'inProgress',
      gam_repair_final: 'final',
      gam_repair_cancelled: 'cancelled'
    })
  })

  it('keeps roster saves scheduled, starts on a pitch or in-play event, and reverses after undo', async () => {
    const setup = {
      about: { atBatIndex: 0, inning: 1, halfInning: 'top', isComplete: false },
      playEvents: [{ isPitch: false, isSubstitution: true }]
    }
    const pitch = { ...setup, playEvents: [{ isPitch: true }] }
    const inPlay = {
      ...setup,
      playEvents: [{ isPitch: true, details: { isInPlay: true } }]
    }
    const complete = {
      ...inPlay,
      about: { ...setup.about, isComplete: true },
      result: { eventType: 'single' }
    }
    const roster = {
      ...setup,
      result: { eventType: 'defensive_switch' }
    }
    for (const [change, started] of [
      [{ currentPlay: setup }, false],
      [{ currentPlay: pitch }, true],
      [{ currentPlay: setup }, false],
      [{ currentPlay: inPlay }, true],
      [{ plays: [complete], currentPlay: setup }, true],
      [{ plays: [roster], currentPlay: setup }, false]
    ] as const) {
      const response = await f.h.request(
        'POST',
        `/games/${id}/events`,
        {
          mode: 'live',
          source: { system: 'teamstation' },
          plays: [],
          ...change
        },
        101
      )
      expect(response.status, JSON.stringify(await response.json())).equals(200)
      const row = await f.h.db
        .selectFrom('games')
        .select('status')
        .where('id', '=', id)
        .executeTakeFirstOrThrow()
      expect(row.status).equals(started ? 'inProgress' : 'scheduled')
      await check(started)
    }
    await f.h.db.deleteFrom('events').where('gameId', '=', id).execute()
  })

  it('applies server time and finalization consistently to every projection', async () => {
    const hour = 3600000
    await f.h.db
      .updateTable('games')
      .set({
        currentPlay: {
          teamStation: { actions: [{ type: 'pitch', kind: 'ball' }] }
        }
      })
      .where('id', '=', id)
      .execute()
    for (const offset of [-24 * hour, 24 * hour]) {
      await f.h.db
        .updateTable('games')
        .set({ start_at: new Date(Date.now() + offset) })
        .where('id', '=', id)
        .execute()
      await check(true, false)
    }
    await f.h.db
      .updateTable('games')
      .set({ start_at: new Date() })
      .where('id', '=', id)
      .execute()
    await check(true, true)
    for (const status of ['final', 'cancelled'] as const) {
      await f.h.db
        .updateTable('games')
        .set({ status })
        .where('id', '=', id)
        .execute()
      await check(true, false)
    }
  })
})
