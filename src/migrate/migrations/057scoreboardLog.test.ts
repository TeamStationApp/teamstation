import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../migrations'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'

describe('057 adds the scoreboard log', function () {
  this.timeout(60000)
  const name = `teamstation_scoreboard_log_${Date.now()}`
  const actor = mintUserId(() => false)
  let admin: Pool
  let pool: Pool

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '057scoreboardLog')
    )
    await pool.query(
      `insert into users (id, "legacyId", display_name) values ($1, $2, 'Mookie Betts')`,
      [actor.userId, actor.legacyId]
    )
    await pool.query(
      `insert into teams (id, name) values ('tem_home', 'Pioneers'), ('tem_away', 'Visitors')`
    )
    await pool.query(
      `insert into games (id, home_team_id, away_team_id, start_at)
        values ('gam_one', 'tem_home', 'tem_away', now()), ('gam_two', 'tem_home', 'tem_away', now())`
    )
  })

  after(async function () {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  const log = async (
    gameId: string,
    version: string,
    cause: string,
    actorId: number | null
  ): Promise<void> => {
    await pool.query(
      `insert into scoreboard_log (game_id, version, at, cause, actor_id, publisher, overrides)
        values ($1, $2, now(), $3, $4, '{"state":{"balls":1},"receivedAt":1}', '{}')`,
      [gameId, version, cause, actorId]
    )
  }
  const refusal = async (
    gameId: string,
    version: string,
    cause: string
  ): Promise<string> => {
    let refused: unknown
    await log(gameId, version, cause, null).catch((error: unknown) => {
      refused = error
    })
    return String(refused)
  }

  it('keeps one row per game and version, of the four causes, with a bigint version and actor', async () => {
    expect((await migrateUp(pool, migrations)).applied).includes(
      '057scoreboardLog'
    )
    for (const [i, cause] of [
      'publisher',
      'speedHold',
      'dashboard',
      'reset'
    ].entries())
      await log('gam_one', `176000000000000${i}`, cause, actor.userId)
    expect(await refusal('gam_one', '1760000000000009', 'scoring')).contains(
      'scoreboard_log_cause_check'
    )
    expect(await refusal('gam_one', '1760000000000009', 'publisher')).equals(
      'undefined'
    )
    expect(await refusal('gam_one', '1760000000000009', 'publisher')).contains(
      'scoreboard_log_pkey'
    )
    expect(await refusal('gam_none', '1', 'publisher')).contains(
      'scoreboard_log_game_id_fkey'
    )
    const columns = await pool.query(
      `select column_name, data_type from information_schema.columns
        where table_name = 'scoreboard_log' and column_name in ('version', 'actor_id', 'at')
        order by column_name`
    )
    expect(columns.rows).deep.equals([
      { column_name: 'actor_id', data_type: 'bigint' },
      { column_name: 'at', data_type: 'timestamp with time zone' },
      { column_name: 'version', data_type: 'bigint' }
    ])
  })

  it('forgets a deleted actor and drops a deleted game’s rows', async () => {
    await log('gam_two', '1', 'dashboard', actor.userId)
    await pool.query(`delete from users where id = $1`, [actor.userId])
    expect(
      (
        await pool.query(
          `select count(*)::int as n from scoreboard_log where actor_id is not null`
        )
      ).rows[0].n
    ).equals(0)
    await pool.query(`delete from games where id = 'gam_one'`)
    expect(
      (await pool.query(`select game_id from scoreboard_log`)).rows
    ).deep.equals([{ game_id: 'gam_two' }])
  })

  it('rolls down by dropping the table', async () => {
    expect(
      await migrateDown(
        pool,
        migrations,
        migrations.filter(m => m.name >= '057scoreboardLog').length
      )
    ).includes('057scoreboardLog')
    expect(
      (await pool.query(`select to_regclass('scoreboard_log') as found`))
        .rows[0].found
    ).equals(null)
    await migrateUp(pool, migrations)
  })
})
