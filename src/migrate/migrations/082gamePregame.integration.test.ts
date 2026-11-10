import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrateDown, migrateUp } from '../runner'
import { testDatabaseUrl } from '../testDatabase'
import { migration082GamePregame } from './082gamePregame'
import { migrations } from './index'

describe('082 game pregame', function () {
  this.timeout(60000)
  const name = `teamstation_pregame_${process.pid}_${Date.now()}`
  let admin: Pool
  let pool: Pool
  const record = (actions: unknown[]): unknown => ({
    version: 3,
    setupBefore: { players: {}, teams: {}, tagOrder: [] },
    actions
  })
  const lineup = { type: 'lineup', kind: 'roster' }
  const atBat = (actions: unknown[], playEvents: unknown[] = []): string =>
    JSON.stringify({
      about: { atBatIndex: 0, halfInning: 'top', isComplete: false },
      playEvents,
      teamStation: record(actions)
    })
  const row = async (
    id: string
  ): Promise<{ currentPlay: unknown; pregame: unknown }> =>
    (
      await pool.query(
        'select "currentPlay", pregame from games where id = $1',
        [id]
      )
    ).rows[0]
  before(async () => {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
    })
    await migrateUp(
      pool,
      migrations.filter(m => m.name < '082')
    )
    await pool.query(
      `insert into teams(id,name) values ('tem_home','Hosts'),('tem_away','Visitors')`
    )
    const insert = async (
      id: string,
      currentPlay: string | null,
      status = 'scheduled'
    ): Promise<void> => {
      await pool.query(
        `insert into games(id,home_team_id,away_team_id,start_at,status,"currentPlay") values ($1,'tem_home','tem_away',now(),$2,$3)`,
        [id, status, currentPlay]
      )
    }
    await insert('gam_pregame', atBat([lineup, lineup]))
    await insert('gam_pitched', atBat([lineup, { type: 'pitch', call: 'B' }]))
    await insert('gam_events', atBat([lineup], [{ details: {} }]))
    await insert('gam_live', atBat([lineup]), 'inProgress')
    await insert('gam_between', atBat([lineup]))
    await insert('gam_none', null)
    await pool.query(
      `insert into events(id,"gameId",gumbo) values ('evt_between','gam_between','{"about":{"atBatIndex":0}}')`
    )
  })
  after(async () => {
    await pool?.end()
    if (admin != null) {
      await admin.query(`drop database if exists ${name}`)
      await admin.end()
    }
  })
  it('moves only an unbegun game’s lineup record to pregame, and down gives every pregame game an at-bat again', async () => {
    const current = async (id: string): Promise<unknown> =>
      (await pool.query('select "currentPlay" from games where id = $1', [id]))
        .rows[0].currentPlay
    const before = {
      pitched: await current('gam_pitched'),
      events: await current('gam_events'),
      live: await current('gam_live'),
      between: await current('gam_between')
    }
    await migrateUp(pool, [migration082GamePregame])
    expect(await row('gam_pregame')).deep.equals({
      currentPlay: null,
      pregame: record([lineup, lineup])
    })
    for (const [id, was] of [
      ['gam_pitched', before.pitched],
      ['gam_events', before.events],
      ['gam_live', before.live],
      ['gam_between', before.between]
    ] as const)
      expect(await row(id), id).deep.equals({ currentPlay: was, pregame: null })
    expect(await row('gam_none')).deep.equals({
      currentPlay: null,
      pregame: null
    })
    // A game saved before its first pitch after up.
    await pool.query(
      `insert into games(id,home_team_id,away_team_id,start_at,pregame) values ('gam_after','tem_home','tem_away',now(),$1)`,
      [JSON.stringify(record([lineup]))]
    )

    await migrateDown(pool, [migration082GamePregame])
    for (const [id, actions] of [
      ['gam_pregame', [lineup, lineup]],
      ['gam_after', [lineup]]
    ] as const) {
      const restored = (await current(id)) as {
        about: unknown
        teamStation: unknown
      }
      expect(restored.about, id).deep.include({
        atBatIndex: 0,
        halfInning: 'top'
      })
      expect(restored.teamStation, id).deep.equals(record([...actions]))
    }
    expect(
      (
        await pool.query('select "currentPlay" from games where id = $1', [
          'gam_none'
        ])
      ).rows[0].currentPlay
    ).equals(null)
  })
})
