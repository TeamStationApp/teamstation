import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { dropScratchDatabase, testDatabaseUrl } from '../testDatabase'
import { migration102VideoSpaceSecret } from './102videoSpaceSecret'
import { migrations } from './index'

const SECRET_A = '0123456789abcdef0123456789abcdef'
const SECRET_B = 'fedcba9876543210fedcba9876543210'

/** 102: `videos.space_secret`, and the `live_changes` trigger watching it. */
describe('102 video space secret', function () {
  this.timeout(60000)
  const name = `teamstation_space_secret_${process.pid}_${Date.now()}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  const through = migrations.filter(
    migration => migration.name <= migration102VideoSpaceSecret.name
  )
  let admin: Pool
  let pool: Pool
  let listener: Client
  const payloads: string[] = []
  let marks = 0

  /** Everything committed before a mark has been heard once the mark is. */
  const heard = async (write: () => Promise<unknown>): Promise<unknown[]> => {
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
    await settle()
    payloads.length = 0
    await write()
    const mark = await settle()
    return payloads
      .slice(0, payloads.indexOf(mark))
      .map(payload => JSON.parse(payload) as unknown)
  }

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(pool, through)
    await pool.query(`
      insert into teams (id, name) values
        ('tem_home', 'Pioneers'), ('tem_away', 'Visitors');
      insert into games (id, home_team_id, away_team_id, start_at) values
        ('gam_one', 'tem_home', 'tem_away', now());
      insert into videos (id, game_id, kind, title, storage) values
        ('vid_live', 'gam_one', 'live', 'Live', 'local'),
        ('vid_program', 'gam_one', 'program', 'Programme', 'spaces')`)
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

  it('is null on a row from before, and takes only 32 lowercase hex characters', async function () {
    const { rows } = await pool.query<{ space_secret: string | null }>(
      `select space_secret from videos order by id`
    )
    expect(rows.map(row => row.space_secret)).deep.equals([null, null])
    for (const bad of ['ABCDEF0123456789ABCDEF0123456789', 'short', ''])
      await pool
        .query(`update videos set space_secret = $1 where id = 'vid_live'`, [
          bad
        ])
        .then(
          () => expect.fail(`${bad} was taken`),
          (error: unknown) =>
            expect((error as Error).message).contains('space_secret_hex')
        )
  })

  for (const videoId of ['vid_live', 'vid_program'])
    it(`says a change to space_secret of ${videoId}, and nothing for the same value`, async function () {
      const secret = videoId === 'vid_live' ? SECRET_A : SECRET_B
      expect(
        await heard(
          async () =>
            await pool.query(
              `update videos set space_secret = $1 where id = $2`,
              [secret, videoId]
            )
        )
      ).deep.equals([{ v: videoId }])
      expect(
        await heard(
          async () =>
            await pool.query(
              `update videos set space_secret = space_secret, title = 'Renamed' where id = $1`,
              [videoId]
            )
        )
      ).deep.equals([])
    })

  it('never gives two videos one secret', async function () {
    await pool
      .query(`update videos set space_secret = $1 where id = 'vid_program'`, [
        SECRET_A
      ])
      .then(
        () => expect.fail('a shared secret was taken'),
        (error: unknown) =>
          expect((error as Error).message).contains('space_secret_unique')
      )
  })

  it('still says the columns 101 watched', async function () {
    expect(
      await heard(
        async () =>
          await pool.query(
            `update videos set hidden = not hidden where id = 'vid_live'`
          )
      )
    ).deep.equals([{ v: 'vid_live' }])
  })

  it('puts 101’s trigger back and drops the column on the way down', async function () {
    await migrateDown(pool, through, 1)
    const { rows } = await pool.query<{ count: string }>(
      `select count(*) from information_schema.columns
        where table_name = 'videos' and column_name = 'space_secret'`
    )
    expect(Number(rows[0].count)).equals(0)
    expect(
      await heard(
        async () =>
          await pool.query(
            `update videos set hidden = not hidden where id = 'vid_program'`
          )
      )
    ).deep.equals([{ v: 'vid_program' }])
    expect(
      await heard(
        async () =>
          await pool.query(
            `update videos set title = 'Again' where id = 'vid_program'`
          )
      )
    ).deep.equals([])
  })
})
