import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { mintUserId } from '../../common/mintUserId'
import { migrations } from '../migrations'
import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'

describe("060 adds a video's wall-clock timeline", function () {
  this.timeout(60000)
  const name = `teamstation_video_wall_${Date.now()}`
  const filmer = mintUserId(() => false)
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
      migrations.filter(m => m.name < '061videoWallTimeline')
    )
    await pool.query(
      `insert into users (id, "legacyId", display_name) values ($1, $2, 'Mookie Betts')`,
      [filmer.userId, filmer.legacyId]
    )
    await pool.query(
      `insert into teams (id, name) values ('tem_home', 'Pioneers'), ('tem_away', 'Visitors')`
    )
    await pool.query(
      `insert into games (id, home_team_id, away_team_id, start_at)
        values ('gam_one', 'tem_home', 'tem_away', now())`
    )
    await pool.query(
      `insert into videos (id, game_id, kind, title, storage, created_at, updated_at)
        values ('vid_one', 'gam_one', 'program', 'Programme', 'spaces', now(), now()),
               ('vid_two', 'gam_one', 'live', 'Live', 'spaces', now(), now())`
    )
    await pool.query(
      `insert into director_uploads (id, user_id, game_id, title, filename, size_bytes, part_size)
        values ('dup_one', $1, 'gam_one', 'Programme', 'take.mov', 10, 10)`,
      [filmer.userId]
    )
  })

  after(async function () {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })

  const anchor = async (
    videoId: string,
    mediaMs: number,
    source: string,
    corrected?: boolean
  ): Promise<string> => {
    let refused: unknown
    await pool
      .query(
        corrected == null
          ? `insert into video_wall_anchors (video_id, media_ms, wall, source)
              values ($1, $2, now(), $3)`
          : `insert into video_wall_anchors (video_id, media_ms, wall, source, corrected)
              values ($1, $2, now(), $3, $4)`,
        corrected == null
          ? [videoId, mediaMs, source]
          : [videoId, mediaMs, source, corrected]
      )
      .catch((error: unknown) => {
        refused = error
      })
    return String(refused)
  }

  it('keeps one point per video and media time, from SEI or arrival, corrected unless said', async function () {
    expect((await migrateUp(pool, migrations)).applied).includes(
      '061videoWallTimeline'
    )
    expect(await anchor('vid_one', 0, 'sei')).equals('undefined')
    expect(await anchor('vid_one', 500, 'sei', false)).equals('undefined')
    expect(await anchor('vid_two', 0, 'arrival')).equals('undefined')
    expect(await anchor('vid_one', 0, 'sei')).contains(
      'video_wall_anchors_pkey'
    )
    expect(await anchor('vid_one', 900, 'start')).contains(
      'video_wall_anchors_source_check'
    )
    expect(await anchor('vid_none', 0, 'sei')).contains(
      'video_wall_anchors_video_id_fkey'
    )
    const rows = await pool.query(
      `select video_id, media_ms, source, corrected from video_wall_anchors
        order by video_id, media_ms`
    )
    expect(rows.rows).deep.equals([
      { video_id: 'vid_one', media_ms: 0, source: 'sei', corrected: true },
      { video_id: 'vid_one', media_ms: 500, source: 'sei', corrected: false },
      { video_id: 'vid_two', media_ms: 0, source: 'arrival', corrected: true }
    ])
  })

  it('indexes the points that are not a corrected SEI frame, and only those', async function () {
    const indexes = await pool.query(
      `select indexname, indexdef from pg_indexes
        where tablename = 'video_wall_anchors' and indexname <> 'video_wall_anchors_pkey'
        order by indexname`
    )
    expect(
      indexes.rows.map(row => [
        row.indexname,
        /WHERE (.*)$/.exec(row.indexdef)?.[1]
      ])
    ).deep.equals([
      ['video_wall_anchors_not_sei', "(source <> 'sei'::text)"],
      ['video_wall_anchors_uncorrected', '(NOT corrected)']
    ])
  })

  it('gives videos and uploads an empty clock offset', async function () {
    const video = await pool.query(
      `select start_at_clock_offset_ms from videos where id = 'vid_one'`
    )
    expect(video.rows[0].start_at_clock_offset_ms).equals(null)
    await pool.query(
      `update director_uploads set server_clock_offset_ms = -1234 where id = 'dup_one'`
    )
    const upload = await pool.query(
      `select server_clock_offset_ms from director_uploads where id = 'dup_one'`
    )
    expect(upload.rows[0].server_clock_offset_ms).equals(-1234)
  })

  it("drops a deleted video's points", async function () {
    await pool.query(`delete from videos where id = 'vid_two'`)
    expect(
      (await pool.query(`select distinct video_id from video_wall_anchors`))
        .rows
    ).deep.equals([{ video_id: 'vid_one' }])
  })

  it('rolls down by dropping the table and both columns', async function () {
    expect(
      await migrateDown(
        pool,
        migrations,
        migrations.filter(m => m.name >= '061videoWallTimeline').length
      )
    ).includes('061videoWallTimeline')
    expect(
      (await pool.query(`select to_regclass('video_wall_anchors') as found`))
        .rows[0].found
    ).equals(null)
    const columns = await pool.query(
      `select column_name from information_schema.columns
        where (table_name = 'videos' and column_name = 'start_at_clock_offset_ms')
           or (table_name = 'director_uploads' and column_name = 'server_clock_offset_ms')`
    )
    expect(columns.rows).deep.equals([])
    await migrateUp(pool, migrations)
  })
})
