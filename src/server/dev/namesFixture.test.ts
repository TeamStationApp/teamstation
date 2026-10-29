import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { type Database, makeDatabase } from '../db/database'
import {
  NAMES_PEOPLE,
  type NamesFixture,
  runNamesFixture
} from './namesFixture'

const adminUrl = testDatabaseUrl
const scratchName = `teamstation_names_fixture_${Date.now()}`
const scratchUrl = adminUrl.replace(/\/[^/]*$/, `/${scratchName}`)

/** The message `run` rejects with, or fails when it resolves. */
async function rejection(run: () => Promise<unknown>): Promise<string> {
  try {
    await run()
  } catch (error) {
    return error instanceof Error ? error.message : String(error)
  }
  throw new Error('expected a rejection')
}

describe('names fixture', function () {
  this.timeout(120000)

  let adminPool: Pool | undefined
  let db: Kysely<Database> | undefined
  const printed: string[] = []
  let fixture: NamesFixture

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
    fixture = await runNamesFixture(db, [], text => printed.push(text))
  })

  after(async function () {
    if (db != null) await db.destroy()
    if (adminPool != null) {
      await adminPool.query(`drop database if exists ${scratchName}`)
      await adminPool.end()
    }
  })

  it('refuses production and arguments it does not take', async () => {
    const was = process.env.NODE_ENV
    process.env.NODE_ENV = 'production'
    try {
      expect(
        await rejection(
          async () => await runNamesFixture(db!, [], () => undefined)
        )
      ).includes('production')
    } finally {
      if (was == null) delete process.env.NODE_ENV
      else process.env.NODE_ENV = was
    }
    for (const args of [['--password'], ['--password', ''], ['extra']])
      expect(
        await rejection(
          async () => await runNamesFixture(db!, args, () => undefined)
        )
      ).includes('Usage')
  })

  it('gives everyone who signs in the password, when one is given', async () => {
    const again = await runNamesFixture(
      db!,
      ['--password', 'names-fixture-password-0000'],
      () => undefined
    )
    const rows = await db!
      .selectFrom('users')
      .select(['password_hash', 'login_enabled'])
      .where(
        'id',
        'in',
        Object.values(again.people).map(person => person.userId)
      )
      .execute()
    expect(rows).has.length(4)
    for (const row of rows) {
      expect(row.login_enabled).equals(true)
      expect(row.password_hash).not.equals(null)
    }
    const first = await db!
      .selectFrom('users')
      .select('password_hash')
      .where('id', '=', fixture.people.admin.userId)
      .executeTakeFirstOrThrow()
    expect(first.password_hash).equals(null)
  })

  it('prints every id and e-mail as JSON', () => {
    expect(printed).has.length(1)
    const out = JSON.parse(printed[0]) as NamesFixture
    expect(out).deep.equals(fixture)
    expect(out.gameId).matches(/^gam_/)
    expect(out.outsideGameId).matches(/^gam_/)
    expect(out.videoId).matches(/^vid_/)
    for (const person of Object.values(out.people))
      expect(person.email).matches(/^names\.[a-z]+\.[a-z0-9]+@example\.test$/)
    expect(printed[0]).not.includes('password')
  })

  it('scores the game through a session, final, with its video', async () => {
    const game = await db!
      .selectFrom('games')
      .select(['status', 'scoringOwner', 'guests'])
      .where('id', '=', fixture.gameId)
      .executeTakeFirstOrThrow()
    expect(game.status).equals('final')
    expect(game.scoringOwner).equals('teamstation')
    expect(JSON.stringify(game.guests)).includes(String(fixture.guest.gumboId))
    const events = await db!
      .selectFrom('events')
      .select(['gumbo', 'source'])
      .where('gameId', '=', fixture.gameId)
      .execute()
    expect(events.length).greaterThan(20)
    expect(new Set(events.map(row => row.source))).deep.equals(
      new Set(['teamstation'])
    )
    const types = events.flatMap(row =>
      (
        (
          row.gumbo as {
            playEvents?: Array<{ details?: { eventType?: string } }>
          }
        ).playEvents ?? []
      ).map(event => event.details?.eventType)
    )
    for (const type of [
      'offensive_substitution',
      'pitching_substitution',
      'defensive_switch',
      'stolen_base_2b',
      'wild_pitch'
    ])
      expect(types, type).includes(type)
    const results = events.map(
      row => (row.gumbo as { result: { eventType: string } }).result.eventType
    )
    expect(results).includes('strikeout')
    // The game-only player bats last, and strikes out.
    const last = events
      .map(
        row =>
          row.gumbo as {
            about: { atBatIndex: number }
            result: { eventType: string }
            matchup?: { batter?: { id?: number } }
          }
      )
      .filter(play => play.matchup?.batter != null)
      .sort((a, b) => b.about.atBatIndex - a.about.atBatIndex)[0]
    expect(last.matchup?.batter?.id).equals(fixture.guest.gumboId)
    expect(last.result.eventType).equals('strikeout')
    const video = await db!
      .selectFrom('videos')
      .select(['game_id', 'status'])
      .where('id', '=', fixture.videoId)
      .executeTakeFirstOrThrow()
    expect(video).deep.equals({ game_id: fixture.gameId, status: 'ready' })
  })

  it("keeps the outside scorer's typed opponent and fielding chain", async () => {
    const credits = await db!
      .selectFrom('eventCredits')
      .innerJoin('events', 'events.id', 'eventCredits.eventId')
      .select([
        'eventCredits.head',
        'eventCredits.creditGumboId',
        'eventCredits.typedName',
        'eventCredits.position',
        'eventCredits.assists',
        'eventCredits.assistWord'
      ])
      .where('events.gameId', '=', fixture.outsideGameId)
      .execute()
    const single = credits.find(row => row.head === 'Single')
    expect(single).include({
      creditGumboId: null,
      typedName: NAMES_PEOPLE.typedOpponent
    })
    expect(
      credits.some(
        row =>
          row.position === 'SS' &&
          row.assistWord === 'to' &&
          row.assists.at(-1)?.position === '1B'
      )
    ).equals(true)
  })

  it('sets the default lineup, the request and the grant', async () => {
    const team = await db!
      .selectFrom('teams')
      .select('default_lineup')
      .where('id', '=', fixture.teams.away)
      .executeTakeFirstOrThrow()
    const lineup = team.default_lineup as { lineup: { batters: unknown[] } }
    expect(lineup.lineup.batters).has.length(9)
    const request = await db!
      .selectFrom('group_requests')
      .select(['kind', 'status', 'sender_id'])
      .where('id', '=', fixture.guardianRequestId)
      .executeTakeFirstOrThrow()
    expect(request).deep.equals({
      kind: 'guardian',
      status: 'pending',
      sender_id: fixture.people.admin.userId
    })
    const grant = await db!
      .selectFrom('notification_events')
      .select(['source_type', 'actor_id', 'recorded_recipients'])
      .where('id', '=', fixture.coachGrantId)
      .executeTakeFirstOrThrow()
    expect(grant).deep.equals({
      source_type: 'grant',
      actor_id: fixture.people.secondAdmin.userId,
      recorded_recipients: [fixture.people.testAccount.userId]
    })
    const admins = await db!
      .selectFrom('scope_roles')
      .select('user_id')
      .where('scope_id', '=', fixture.teams.away)
      .where('role', '=', 'admin')
      .execute()
    expect(admins.map(row => row.user_id).sort()).deep.equals(
      [fixture.people.admin.userId, fixture.people.secondAdmin.userId].sort()
    )
  })
})
