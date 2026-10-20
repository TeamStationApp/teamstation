import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { sql } from 'kysely'
import { describe, it } from 'mocha'

import { userIdOfGumbo } from '../../common/userId'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { statsDatabase } from '../../test/statsDatabase'

describe('repair people with separate scoring identities', function () {
  this.timeout(60000)
  const fixture = statsDatabase('repair_people')
  it('finds account history through mappings and keeps an unplayed membership in a dry run', async () => {
    const { db, ids } = fixture
    await db
      .updateTable('gumbo_ids')
      .set({ gumbo_id: 101 })
      .where('user_id', '=', userIdOfGumbo(ids[0]))
      .execute()
    await db
      .insertInto('memberships')
      .values(
        ids.slice(0, 2).map((userId, i) => ({
          id: `mem_repair${i}`,
          user_id: userIdOfGumbo(userId),
          team_id: 'tem_home',
          is_player: true
        }))
      )
      .execute()
    await db
      .insertInto('game_player_stats')
      .values({
        id: 'gps_repair',
        game_id: 'gam_demo',
        team_id: 'tem_home',
        gumbo_id: 101,
        pa: 1
      })
      .execute()
    await db
      .insertInto('events')
      .values({
        id: 'evt_repair',
        gameId: 'gam_demo',
        gumbo: { about: { atBatIndex: 0 }, matchup: { batter: { id: 101 } } }
      })
      .execute()
    const database = (
      await sql<{ name: string }>`select current_database() as name`.execute(db)
    ).rows[0].name
    const url = new URL(testDatabaseUrl)
    url.pathname = '/' + database
    const directory = await mkdtemp(join(tmpdir(), 'repair-people-test-'))
    try {
      await writeFile(
        join(directory, 'serverConfig.json'),
        JSON.stringify({ databaseUrl: url.toString() }),
        { mode: 0o600 }
      )
      const before = await db
        .selectFrom('memberships')
        .selectAll()
        .orderBy('id')
        .execute()
      const { stdout } = await promisify(execFile)(
        process.execPath,
        [
          '-r',
          require.resolve('sucrase/register'),
          resolve('src/server/dev/repairPeople.ts')
        ],
        { cwd: directory }
      )
      expect(stdout).includes('Nothing written. Run again with --apply.')
      expect(stdout).includes(`kept ${userIdOfGumbo(ids[1])}|tem_home:`)
      expect(stdout).not.includes(`kept ${userIdOfGumbo(ids[0])}|tem_home:`)
      expect(
        await db.selectFrom('memberships').selectAll().orderBy('id').execute()
      ).deep.equals(before)
      // Two historical identities that appeared in the same game cannot be one player.
      await db
        .updateTable('users')
        .set({ merged_into: userIdOfGumbo(ids[0]) })
        .where('id', '=', userIdOfGumbo(ids[2]))
        .execute()
      await db
        .insertInto('events')
        .values({
          id: 'evt_clashing_player',
          gameId: 'gam_demo',
          gumbo: {
            about: { atBatIndex: 1 },
            matchup: { batter: { id: ids[2] } }
          }
        })
        .execute()
      const split = await promisify(execFile)(
        process.execPath,
        [
          '-r',
          require.resolve('sucrase/register'),
          resolve('src/server/dev/repairPeople.ts')
        ],
        { cwd: directory }
      )
      expect(split.stdout).includes('they were in a game together')
      expect(
        (
          await db
            .selectFrom('users')
            .select('merged_into')
            .where('id', '=', userIdOfGumbo(ids[2]))
            .executeTakeFirstOrThrow()
        ).merged_into
      ).equals(userIdOfGumbo(ids[0]))
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
