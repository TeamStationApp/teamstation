import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { userIdOfGumbo } from '../../common/userId'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { insertFixtureUsers } from '../../test/insertFixtureUsers'
import { type Database, makeDatabase } from '../db/database'
import type { MessagesUsage } from './messagesApi'
import { recordUsage, usageWeeks, weekStartUtc } from './usage'

const usage = (
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0
): MessagesUsage => ({
  inputTokens,
  cacheCreationInputTokens,
  cacheReadInputTokens,
  outputTokens
})

describe('Tess usage', function () {
  describe('weekStartUtc', function () {
    it('starts the week on Monday 00:00 UTC', function () {
      expect(weekStartUtc(new Date('2026-10-19T00:00:00.000Z'))).equals(
        '2026-10-19'
      )
      // The last moment of Sunday is still the week before.
      expect(weekStartUtc(new Date('2026-10-25T23:59:59.999Z'))).equals(
        '2026-10-19'
      )
      expect(weekStartUtc(new Date('2026-10-26T00:00:00.000Z'))).equals(
        '2026-10-26'
      )
      expect(weekStartUtc(new Date('2026-10-21T15:30:00.000Z'))).equals(
        '2026-10-19'
      )
    })

    it('crosses the year boundary', function () {
      expect(weekStartUtc(new Date('2027-01-01T12:00:00.000Z'))).equals(
        '2026-12-28'
      )
      expect(weekStartUtc(new Date('2026-01-01T00:00:00.000Z'))).equals(
        '2025-12-29'
      )
    })

    it('reads a time written with an offset as the UTC instant it is', function () {
      // Monday 01:30 in a zone two hours ahead is Sunday 23:30 UTC.
      expect(weekStartUtc(new Date('2026-10-26T01:30:00+02:00'))).equals(
        '2026-10-19'
      )
      // Sunday 20:00 five hours behind is Monday 01:00 UTC.
      expect(weekStartUtc(new Date('2026-10-25T20:00:00-05:00'))).equals(
        '2026-10-26'
      )
    })
  })

  describe('the weekly store', function () {
    this.timeout(60000)
    const name = `teamstation_tessusage_${process.pid}_${Date.now()}`
    const first = userIdOfGumbo(4401)
    const second = userIdOfGumbo(4402)
    let admin: Pool
    let db: Kysely<Database>

    before(async () => {
      admin = new Pool({ connectionString: testDatabaseUrl })
      await admin.query(`create database ${name}`)
      const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
      const pool = new Pool({ connectionString: url })
      await migrateUp(pool, migrations)
      await pool.end()
      db = makeDatabase(url)
      await insertFixtureUsers(db, [
        { id: 4401, display_name: 'Tony Gwynn' },
        { id: 4402, display_name: 'Ryne Sandberg' }
      ])
    })
    after(async () => {
      await db?.destroy()
      if (admin != null) {
        await admin.query(`drop database if exists ${name}`)
        await admin.end()
      }
    })

    it('adds a week’s calls up, input and output apart', async () => {
      expect(await usageWeeks(db, first)).deep.equals([])
      // Input is fresh input, cache writes and cache reads together.
      await recordUsage(
        db,
        first,
        usage(1000, 200, 3000, 500),
        new Date('2026-10-19T00:00:00.000Z')
      )
      await recordUsage(
        db,
        first,
        usage(250, 80),
        new Date('2026-10-25T23:59:59.999Z')
      )
      expect(await usageWeeks(db, first)).deep.equals([
        {
          weekStart: '2026-10-19',
          inputTokens: 4750,
          outputTokens: 280,
          requests: 2
        }
      ])
    })

    it('opens a new row on the next Monday, and keeps each person apart', async () => {
      await recordUsage(
        db,
        first,
        usage(10, 5, 0, 20),
        new Date('2026-10-26T00:00:00.000Z')
      )
      await recordUsage(
        db,
        second,
        usage(7, 3),
        new Date('2026-10-21T09:00:00.000Z')
      )
      expect(await usageWeeks(db, first)).deep.equals([
        {
          weekStart: '2026-10-26',
          inputTokens: 30,
          outputTokens: 5,
          requests: 1
        },
        {
          weekStart: '2026-10-19',
          inputTokens: 4750,
          outputTokens: 280,
          requests: 2
        }
      ])
      expect(await usageWeeks(db, first, 1)).deep.equals([
        {
          weekStart: '2026-10-26',
          inputTokens: 30,
          outputTokens: 5,
          requests: 1
        }
      ])
      expect(await usageWeeks(db, second)).deep.equals([
        {
          weekStart: '2026-10-19',
          inputTokens: 7,
          outputTokens: 3,
          requests: 1
        }
      ])
    })

    it('counts past what a 32-bit integer holds, and dates a call made now', async () => {
      const big = 3_000_000_000
      await recordUsage(db, second, usage(big, big), new Date('2027-01-01'))
      await recordUsage(db, second, usage(big, 1), new Date('2027-01-02'))
      expect((await usageWeeks(db, second))[0]).deep.equals({
        weekStart: '2026-12-28',
        inputTokens: 2 * big,
        outputTokens: big + 1,
        requests: 2
      })
      const before = await usageWeeks(db, second)
      await recordUsage(db, second, usage(1, 1))
      const thisWeek = weekStartUtc(new Date())
      const requests = (weeks: typeof before): number =>
        weeks.find(week => week.weekStart === thisWeek)?.requests ?? 0
      expect(requests(await usageWeeks(db, second))).equals(
        requests(before) + 1
      )
    })
  })
})
