import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { dropScratchDatabase, testDatabaseUrl } from '../testDatabase'
import { migration101LiveChanges } from './101liveChanges'
import { migrations } from './index'

type Notice = Record<string, string | null>

/** 101: `live_changes` notices for streams, videos and the games they film. */
describe('101 live changes', function () {
  this.timeout(60000)
  const name = `teamstation_live_changes_${process.pid}_${Date.now()}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  const through = migrations.filter(
    migration => migration.name <= migration101LiveChanges.name
  )
  let admin: Pool
  let pool: Pool
  let listener: Client
  const payloads: string[] = []
  let marks = 0

  /** Notifies a mark and waits to hear it: everything committed before it has arrived. */
  const settle = async (): Promise<string> => {
    const mark = `mark ${++marks}`
    await pool.query(`select pg_notify('live_changes', $1)`, [mark])
    const deadline = Date.now() + 5000
    while (!payloads.includes(mark)) {
      if (Date.now() > deadline) throw new Error(`Never heard ${mark}`)
      await new Promise(resolve => setTimeout(resolve, 5))
    }
    return mark
  }

  /**
   * What `live_changes` says for `write` alone. Notices go out in commit
   * order, so a mark before it drops what earlier writes said, and a mark
   * after it ends the wait without guessing at a delay.
   */
  const heard = async (write: () => Promise<unknown>): Promise<Notice[]> => {
    await settle()
    payloads.length = 0
    await write()
    const mark = await settle()
    return payloads
      .slice(0, payloads.indexOf(mark))
      .map(payload => JSON.parse(payload) as Notice)
  }

  const sorted = (notices: Notice[]): string[] =>
    notices.map(notice => JSON.stringify(notice)).sort()

  let streams = 0
  /** A stream of `gam_live` for `tem_home`, filming `videoId`. */
  const addStream = async (videoId: string | null): Promise<string> => {
    const id = `liv_${++streams}`
    await pool.query(
      `insert into live_streams
         (id, game_id, team_id, key_hash, key_prefix, key_cipher, opens_at,
          video_id)
       values ($1, 'gam_live', 'tem_home', $1, 'pre', 'cipher', now(), $2)`,
      [id, videoId]
    )
    return id
  }

  const ours = async (): Promise<string[]> =>
    (
      await pool.query<{ line: string }>(
        `select tgname as line from pg_trigger where tgname like '%live_changes%'
         union all
         select proname from pg_proc where proname like '%live_changes%'
         order by 1`
      )
    ).rows.map(row => row.line)

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(pool, through)
    await pool.query(`
      insert into teams (id, name) values
        ('tem_home', 'Pioneers'), ('tem_away', 'Visitors'),
        ('tem_other', 'Others');
      insert into games (id, home_team_id, away_team_id, start_at) values
        ('gam_live', 'tem_home', 'tem_away', now()),
        ('gam_quiet', 'tem_home', 'tem_away', now()),
        ('gam_ended', 'tem_home', 'tem_away', now());
      insert into videos (id, game_id, kind, title, storage) values
        ('vid_live', 'gam_live', 'live', 'Live', 'local'),
        ('vid_program', 'gam_live', 'program', 'Programme', 'spaces'),
        ('vid_other', 'gam_live', 'program', 'Other', 'spaces')`)
    listener = new Client({ connectionString: url })
    await listener.connect()
    listener.on('notification', message => {
      if (message.channel === 'live_changes')
        payloads.push(message.payload ?? '')
    })
    await listener.query('listen live_changes')
  })

  after(async function () {
    await listener?.end()
    await pool?.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  describe('live_streams', function () {
    it('says an insert, a revoke and a delete once each, with the stream and its video', async function () {
      let id = ''
      expect(
        await heard(async () => {
          id = await addStream('vid_live')
        })
      ).deep.equals([{ s: id, v: 'vid_live' }])
      expect(
        await heard(
          async () =>
            await pool.query(
              `update live_streams
                  set state = 'revoked', closes_at = now(), updated_at = now()
                where id = $1`,
              [id]
            )
        )
      ).deep.equals([{ s: id, v: 'vid_live' }])
      expect(
        await heard(
          async () =>
            await pool.query(`delete from live_streams where id = $1`, [id])
        )
      ).deep.equals([{ s: id, v: 'vid_live' }])
    })

    it('says a stream with no video with a null video', async function () {
      let id = ''
      expect(
        await heard(async () => {
          id = await addStream(null)
        })
      ).deep.equals([{ s: id, v: null }])
      await pool.query(`delete from live_streams where id = $1`, [id])
    })

    it('says nothing for the ingest’s own reports, one column or all of them', async function () {
      const id = await addStream('vid_live')
      for (const set of [
        `status = '{"receiving": true}'`,
        'status_at = now()',
        'last_published_at = now()',
        `last_error = 'it went wrong'`,
        `updated_at = now() + interval '1 second'`,
        `status = '{"receiving": false}', status_at = now(),
         last_published_at = now(), last_error = null, updated_at = now()`
      ])
        expect(
          await heard(
            async () =>
              await pool.query(`update live_streams set ${set} where id = $1`, [
                id
              ])
          ),
          set
        ).deep.equals([])
      await pool.query(`delete from live_streams where id = $1`, [id])
    })

    it('says nothing for a write that changes nothing', async function () {
      const id = await addStream('vid_live')
      expect(
        await heard(
          async () =>
            await pool.query(
              `update live_streams set state = state, label = label
                where id = $1`,
              [id]
            )
        )
      ).deep.equals([])
      await pool.query(`delete from live_streams where id = $1`, [id])
    })
  })

  describe('videos', function () {
    const changes = [
      ['hidden', 'not hidden'],
      [
        'storage',
        `case when storage = 'spaces' then 'local' else 'spaces' end`
      ],
      [
        'spaces_verified_at',
        `coalesce(spaces_verified_at, now()) + interval '1 second'`
      ],
      ['replaced_by', `case when replaced_by is null then 'vid_other' end`],
      ['start_at', `coalesce(start_at, now()) + interval '1 second'`]
    ]
    for (const videoId of ['vid_live', 'vid_program'])
      for (const [column, value] of changes)
        it(`says a change to ${column} of ${videoId}`, async function () {
          expect(
            await heard(
              async () =>
                await pool.query(
                  `update videos set ${column} = ${value} where id = $1`,
                  [videoId]
                )
            )
          ).deep.equals([{ v: videoId }])
        })

    it('says nothing for a title, or for a column set to what it was', async function () {
      for (const set of [
        `title = 'Renamed'`,
        `duration_sec = 12.5, size_bytes = 100`,
        'hidden = hidden, storage = storage, start_at = start_at'
      ])
        expect(
          await heard(
            async () =>
              await pool.query(
                `update videos set ${set} where id in ('vid_live', 'vid_program')`
              )
          ),
          set
        ).deep.equals([])
    })

    it('says a delete, of a programme and of a live video whose stream lets go of it', async function () {
      await pool.query(`
        insert into videos (id, game_id, kind, title, storage) values
          ('vid_gone_program', 'gam_live', 'program', 'Gone', 'spaces'),
          ('vid_gone_live', 'gam_live', 'live', 'Gone live', 'local')`)
      expect(
        await heard(
          async () =>
            await pool.query(`delete from videos where id = 'vid_gone_program'`)
        )
      ).deep.equals([{ v: 'vid_gone_program' }])
      const stream = await addStream('vid_gone_live')
      expect(
        sorted(
          await heard(
            async () =>
              await pool.query(`delete from videos where id = 'vid_gone_live'`)
          )
        )
      ).deep.equals(sorted([{ v: 'vid_gone_live' }, { s: stream, v: null }]))
      await pool.query(`delete from live_streams where id = $1`, [stream])
    })
  })

  describe('games', function () {
    const changes = [
      [
        'end_at',
        `coalesce(end_at, start_at + interval '2 hours') + interval '1 minute'`
      ],
      ['start_at', `start_at - interval '1 minute'`],
      [
        'home_team_id',
        `case when home_team_id = 'tem_home' then 'tem_other' else 'tem_home' end`
      ],
      [
        'away_team_id',
        `case when away_team_id = 'tem_away' then 'tem_other' else 'tem_away' end`
      ]
    ]

    it('says each change of time or team while a stream is open', async function () {
      const stream = await addStream('vid_live')
      for (const [column, value] of changes)
        expect(
          await heard(
            async () =>
              await pool.query(
                `update games set ${column} = ${value} where id = 'gam_live'`
              )
          ),
          column
        ).deep.equals([{ g: 'gam_live' }])
      await pool.query(`delete from live_streams where id = $1`, [stream])
    })

    it('says nothing with no stream, with only ended streams, or for another column', async function () {
      await pool.query(
        `insert into live_streams
           (id, game_id, team_id, key_hash, key_prefix, key_cipher, opens_at,
            ended_at)
         values ('liv_ended', 'gam_ended', 'tem_home', 'liv_ended', 'pre',
                 'cipher', now(), now())`
      )
      for (const gameId of ['gam_quiet', 'gam_ended'])
        for (const [column, value] of changes)
          expect(
            await heard(
              async () =>
                await pool.query(
                  `update games set ${column} = ${value} where id = $1`,
                  [gameId]
                )
            ),
            `${gameId} ${column}`
          ).deep.equals([])
      const stream = await addStream('vid_live')
      expect(
        await heard(
          async () =>
            await pool.query(
              `update games set home_score = 3, notes = 'A note',
                      start_at = start_at
                where id = 'gam_live'`
            )
        )
      ).deep.equals([])
      await pool.query(`delete from live_streams where id = $1`, [stream])
    })
  })

  // Last: a suite's own cases run before its nested suites', and this one
  // takes the triggers away.
  describe('a rollback, and the way down', function () {
    it('says nothing for a transaction that rolls back', async function () {
      const stream = await addStream('vid_live')
      expect(
        await heard(async () => {
          const client = await pool.connect()
          try {
            await client.query('begin')
            await client.query(
              `update live_streams set state = 'revoked' where id = $1`,
              [stream]
            )
            await client.query(`update videos set hidden = not hidden`)
            await client.query(
              `update games set end_at = start_at + interval '5 hours'
                where id = 'gam_live'`
            )
            await client.query(`insert into live_streams
                (id, game_id, team_id, key_hash, key_prefix, key_cipher, opens_at)
              values ('liv_never', 'gam_live', 'tem_home', 'liv_never', 'pre',
                      'cipher', now())`)
            await client.query('rollback')
          } finally {
            client.release()
          }
        })
      ).deep.equals([])
      await pool.query(`delete from live_streams where id = $1`, [stream])
    })

    it('leaves no trigger or function on the way down', async function () {
      expect(await ours()).deep.equals([
        'games_live_changes',
        'games_live_changes',
        'live_streams_live_changes',
        'live_streams_live_changes',
        'live_streams_live_changes_update',
        'videos_live_changes',
        'videos_live_changes',
        'videos_live_changes_update'
      ])
      await migrateDown(pool, through, 1)
      expect(await ours()).deep.equals([])
      expect(
        await heard(async () => {
          await addStream('vid_live')
          await pool.query(`update videos set hidden = not hidden`)
        })
      ).deep.equals([])
    })
  })
})
