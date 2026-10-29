import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { POSITIONS } from '../../common/scoring/state'
import { userIdOfGumbo } from '../../common/userId'
import { makeDatabase } from '../../server/db/database'
import { resolvedDefaultOf } from '../../server/events/teamLineups'
import { migrateDown, migrateUp } from '../runner'
import { dropScratchDatabase, testDatabaseUrl } from '../testDatabase'
import { migration093DefaultLineupIds } from './093defaultLineupIds'
import { migrations } from './index'

const JUDGE = 3001
const BETTS = 3002

/** A person as a default stored before 093 kept him: with his name. */
const named = (
  gumboId: number | null,
  name: string,
  jersey: string
): { gumboId: number | null; name: string; jersey: string } => ({
  gumboId,
  name,
  jersey
})

/** A defense with `fielders` and nobody else. */
const defenseOf = (
  fielders: Record<string, unknown>
): Record<string, unknown> =>
  Object.fromEntries(
    POSITIONS.map(position => [position, fielders[position] ?? null])
  )

/**
 * 093: a team's default lineup keeps its players by id and jersey. Every
 * person with a `gumboId` loses his stored name; a placeholder keeps the name
 * typed for him, and the default reads named as before.
 */
describe('093 default lineups keep ids', function () {
  this.timeout(60000)
  const name = `teamstation_default_lineup_ids_${process.pid}_${Date.now()}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  const through092 = migrations.filter(
    migration => migration.name < migration093DefaultLineupIds.name
  )
  const through093 = migrations.filter(
    migration => migration.name <= migration093DefaultLineupIds.name
  )
  const stored = {
    lineup: {
      batters: [
        named(JUDGE, 'Aaron J', '99'),
        named(null, 'Typed Guest', ''),
        named(BETTS, 'Mookie B', '50')
      ],
      defense: defenseOf({
        P: named(JUDGE, 'Aaron J', '99'),
        C: named(null, 'Typed Guest', ''),
        RF: named(BETTS, 'Mookie B', '50')
      })
    },
    fromGameId: 'gam_taken',
    setAt: '2026-04-01T18:00:00.000Z'
  }
  let admin: Pool
  let pool: Pool
  const defaults = async (): Promise<Record<string, unknown>> =>
    Object.fromEntries(
      (
        await pool.query<{ id: string; default_lineup: unknown }>(
          'select id, default_lineup from teams order by id'
        )
      ).rows.map(row => [row.id, row.default_lineup])
    )

  before(async function () {
    admin = new Pool({ connectionString: testDatabaseUrl })
    await admin.query(`create database ${name}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(pool, through092)
    for (const [gumboId, first, last] of [
      [JUDGE, 'Aaron', 'Judge'],
      [BETTS, 'Mookie', 'Betts']
    ] as const) {
      await pool.query(
        `insert into users (id, display_name, first_name, last_name)
          values ($1, $2, $3, $4)`,
        [userIdOfGumbo(gumboId), `${first} ${last}`, first, last]
      )
      await pool.query(
        'insert into gumbo_ids (gumbo_id, user_id) values ($1, $2)',
        [gumboId, userIdOfGumbo(gumboId)]
      )
    }
    await pool.query(
      `insert into teams (id, name, default_lineup) values
        ('tem_kept', 'Visitors', $1),
        ('tem_none', 'Hosts', null),
        ('tem_empty', 'Owls', $2),
        ('tem_odd', 'Hawks', $3)`,
      [
        JSON.stringify(stored),
        JSON.stringify({ lineup: null, fromGameId: null, setAt: null }),
        JSON.stringify({ lineup: { batters: 'nonsense' }, setAt: null })
      ]
    )
    await migrateUp(pool, through093)
  })
  after(async function () {
    await pool?.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  it('takes the name out of every person with an id and keeps a placeholder’s', async function () {
    const after093 = await defaults()
    expect(after093.tem_kept).deep.equals({
      lineup: {
        batters: [
          { gumboId: JUDGE, jersey: '99' },
          { gumboId: null, name: 'Typed Guest', jersey: '' },
          { gumboId: BETTS, jersey: '50' }
        ],
        defense: defenseOf({
          P: { gumboId: JUDGE, jersey: '99' },
          C: { gumboId: null, name: 'Typed Guest', jersey: '' },
          RF: { gumboId: BETTS, jersey: '50' }
        })
      },
      fromGameId: 'gam_taken',
      setAt: '2026-04-01T18:00:00.000Z'
    })
    for (const player of ['Aaron', 'Judge', 'Mookie', 'Betts'])
      expect(JSON.stringify(after093.tem_kept)).not.contains(player)
  })

  it('leaves a team with no default, an empty one and one that does not read as they were', async function () {
    const after093 = await defaults()
    expect(after093.tem_none).equals(null)
    expect(after093.tem_empty).deep.equals({
      lineup: null,
      fromGameId: null,
      setAt: null
    })
    expect(after093.tem_odd).deep.equals({
      lineup: { batters: 'nonsense' },
      setAt: null
    })
  })

  it('reads the default named from the accounts, as before', async function () {
    const db = makeDatabase(url)
    try {
      const row = await db
        .selectFrom('teams')
        .select('default_lineup')
        .where('id', '=', 'tem_kept')
        .executeTakeFirstOrThrow()
      const read = await resolvedDefaultOf(db, 'tem_kept', row.default_lineup)
      expect(read).deep.equals({
        ...stored,
        lineup: {
          ...stored.lineup,
          defense: defenseOf(stored.lineup.defense)
        }
      })
    } finally {
      await db.destroy()
    }
  })

  it('cannot be rolled back', async () => {
    const refused = await migrateDown(pool, through093, 1).then(
      () => '',
      (error: unknown) => String(error)
    )
    expect(refused).contains('cannot be put back')
    expect((await defaults()).tem_kept).not.equals(null)
  })
})
