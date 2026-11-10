import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { expect } from 'chai'
import { sql } from 'kysely'
import { describe, it } from 'mocha'

import { asUserId } from '../../common/userId'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { statsDatabase } from '../../test/statsDatabase'

describe('development account creation commands', function () {
  this.timeout(60000)
  const fixture = statsDatabase('identity_commands')
  it('creates reusable administrator accounts and demo scoring identities in an isolated database', async () => {
    const db = fixture.db
    const database = (
      await sql<{ name: string }>`select current_database() as name`.execute(db)
    ).rows[0].name
    const url = new URL(testDatabaseUrl)
    url.pathname = '/' + database
    const directory = await mkdtemp(join(tmpdir(), 'identity-command-test-'))
    try {
      await writeFile(
        join(directory, 'serverConfig.json'),
        JSON.stringify({ databaseUrl: url.toString() }),
        { mode: 0o600 }
      )
      const run = async (name: string, ...args: string[]): Promise<string> =>
        (
          await promisify(execFile)(
            process.execPath,
            [
              '-r',
              require.resolve('sucrase/register'),
              resolve(`src/server/dev/${name}.ts`),
              ...args
            ],
            { cwd: directory, env: { ...process.env, NODE_ENV: 'test' } }
          )
        ).stdout
      const first = await run(
        'seed',
        'fixture-admin@example.test',
        'fixture-password-only'
      )
      expect(first).includes('created fixture-admin@example.test (usr_')
      const user = await db
        .selectFrom('users')
        .selectAll()
        .where('is_admin', '=', true)
        .executeTakeFirstOrThrow()
      expect(asUserId(user.id)).equals(user.id)
      expect(user.login_enabled).equals(true)
      expect(
        await run(
          'seed',
          'fixture-admin@example.test',
          'replacement-fixture-password'
        )
      ).includes(`updated fixture-admin@example.test (${user.id})`)
      expect(
        await db
          .selectFrom('users')
          .select('id')
          .where('is_admin', '=', true)
          .execute()
      ).length(1)
      const demo = JSON.parse(await run('demo'))
      expect(asUserId(demo.viewerId)).equals(demo.viewerId)
      expect(asUserId(demo.strangerId)).equals(demo.strangerId)
      const players = await db
        .selectFrom('memberships')
        .innerJoin('gumbo_ids', 'gumbo_ids.user_id', 'memberships.user_id')
        .select(['memberships.user_id', 'gumbo_id'])
        .where('is_player', '=', true)
        .execute()
      expect(players.length).greaterThan(0)
      expect(
        players.every(
          player =>
            asUserId(player.user_id) === player.user_id &&
            Number.isSafeInteger(player.gumbo_id)
        )
      ).equals(true)
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  })
})
