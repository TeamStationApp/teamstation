import { randomBytes } from 'node:crypto'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'

import { migrations } from './migrations'
import { migration052SeasonGameRefinements } from './migrations/052seasonGameRefinements'
import { migrateUp } from './runner'
import { schemaSnapshot } from './schemaSnapshot'
import { dropScratchDatabase, testDatabaseUrl } from './testDatabase'

const through052 = migrations.filter(
  migration => migration.name <= migration052SeasonGameRefinements.name
)

interface RequestTerms {
  game: { homeTeamId: string; awayTeamId: string }
  gameId?: string | null
  proposedGameId?: string
  replacesGameId?: string | null
  consentTeamIds?: string[]
  hostingAuthorizerUserId?: number
  hostingAuthorizationSource?: string
}

describe('052 over legacy schedules and request history', function () {
  this.timeout(120000)
  const name = `teamstation_season_refinements_${Date.now()}_${randomBytes(4).toString('hex')}`
  let admin: Pool | undefined
  let pool: Pool | undefined
  let created = false
  const close = async (): Promise<void> => {
    try {
      await pool?.end()
    } finally {
      pool = undefined
      if (admin != null) {
        if (created) await dropScratchDatabase(admin, name)
        created = false
        await admin.end()
        admin = undefined
      }
    }
  }
  before(async () => {
    try {
      admin = new Pool({ connectionString: testDatabaseUrl })
      const version = await admin.query<{ server_version_num: string }>(
        'show server_version_num'
      )
      expect(Number(version.rows[0].server_version_num)).at.least(180000)
      await admin.query(`create database ${name}`)
      created = true
      pool = new Pool({
        connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
      })
      await migrateUp(
        pool,
        through052.filter(
          migration => migration.name < migration052SeasonGameRefinements.name
        )
      )
      await seedLegacyHistory(pool)
    } catch (error) {
      await close()
      throw error
    }
  })
  after(close)

  it('backfills classification, preserves identities and history, and is stable on a second runner pass', async () => {
    const db = pool!
    expect(
      (
        await db.query(
          `select column_name from information_schema.columns where table_name='games' and column_name in ('exhibition','timezone')`
        )
      ).rows
    ).deep.equals([])
    const legacyGames = (await db.query('select * from games order by id')).rows
    const legacyRequests = (
      await db.query('select * from group_requests order by id')
    ).rows
    const historicalSides = (
      await db.query(
        `select * from group_request_sides where request_id='req_accepted' order by scope_type,scope_id`
      )
    ).rows
    const unrelatedSides = (
      await db.query(
        `select * from group_request_sides where request_id='req_participation' order by scope_type,scope_id`
      )
    ).rows
    const pendingParticipantSides = (
      await db.query(
        `select * from group_request_sides where request_id='req_edit' and scope_type='team' and scope_id in ('tem_home','tem_away') order by scope_id`
      )
    ).rows
    const first = await migrateUp(db, through052)
    expect(first.applied).deep.equals([migration052SeasonGameRefinements.name])
    const games = (await db.query('select * from games order by id')).rows
    expect(
      games.map(({ exhibition, timezone, ...legacy }) => legacy)
    ).deep.equals(legacyGames)
    expect(
      (await db.query('select * from group_requests order by id')).rows.map(
        ({ terms, ...unchanged }) => unchanged
      )
    ).deep.equals(legacyRequests.map(({ terms, ...unchanged }) => unchanged))
    expect(
      games.map(row => ({
        id: row.id,
        exhibition: row.exhibition,
        timezone: row.timezone
      }))
    ).deep.equals([
      { id: 'gam_hosted', exhibition: false, timezone: 'America/Los_Angeles' },
      { id: 'gam_outside', exhibition: false, timezone: 'UTC' }
    ])
    const requests = await db.query<{
      id: string
      terms: RequestTerms
      game_id: string | null
    }>(
      `select id,terms,game_id from group_requests where kind='game' order by id`
    )
    const terms = Object.fromEntries(
      requests.rows.map(row => [row.id, row.terms])
    )
    expect(requests.rows.map(row => row.id)).deep.equals([
      'req_accepted',
      'req_edit',
      'req_new',
      'req_reserved',
      'req_terms_id'
    ])
    for (const row of requests.rows)
      expect(row.terms.consentTeamIds).deep.equals(['tem_home', 'tem_away'])
    expect(terms.req_edit).includes({
      hostingAuthorizerUserId: 102,
      hostingAuthorizationSource: 'legacyReceipt'
    })
    expect(terms.req_new).not.property('hostingAuthorizerUserId')
    expect(terms.req_accepted).not.property('hostingAuthorizerUserId')
    expect(terms.req_edit.proposedGameId).equals('gam_hosted')
    expect(terms.req_accepted.proposedGameId).equals('gam_hosted')
    expect(terms.req_terms_id.proposedGameId).equals('gam_outside')
    expect(terms.req_reserved.proposedGameId).equals('gam_reserved')
    expect(terms.req_reserved.replacesGameId).equals('gam_hosted')
    expect(terms.req_edit).deep.includes({
      affectedTeamIds: ['tem_home', 'tem_away', 'tem_old'],
      hostSeasonIds: ['sea_hosted']
    })
    expect(terms.req_new.proposedGameId).matches(/^gam_[a-f0-9]{32}$/)
    expect(terms.req_new.replacesGameId).equals(null)
    expect(requests.rows.find(row => row.id === 'req_new')!.game_id).equals(
      null
    )
    expect(
      (await db.query('select count(*)::int as count from games')).rows[0].count
    ).equals(2)
    expect(
      (
        await db.query(
          `select * from group_request_sides where request_id='req_edit' order by scope_id`
        )
      ).rows
    ).deep.equals(pendingParticipantSides)
    expect(
      (
        await db.query(
          `select * from group_request_sides where request_id='req_accepted' order by scope_type,scope_id`
        )
      ).rows
    ).deep.equals(historicalSides)
    expect(
      (
        await db.query(
          `select * from group_request_sides where request_id='req_participation' order by scope_type,scope_id`
        )
      ).rows
    ).deep.equals(unrelatedSides)
    const fullRows = async (): Promise<unknown[]> =>
      await Promise.all(
        ['games', 'group_requests', 'group_request_sides'].map(
          async table =>
            (
              await db.query(
                `select * from ${table} order by ${table === 'group_request_sides' ? 'request_id,scope_type,scope_id' : 'id'}`
              )
            ).rows
        )
      )
    const upgradedRows = await fullRows()
    const upgradedSchema = await schemaSnapshot(db)
    const second = await migrateUp(db, through052)
    expect(second.applied).deep.equals([])
    expect(second.alreadyApplied).includes(
      migration052SeasonGameRefinements.name
    )
    expect(await fullRows()).deep.equals(upgradedRows)
    expect(await schemaSnapshot(db)).deep.equals(upgradedSchema)
  })
})

async function seedLegacyHistory(pool: Pool): Promise<void> {
  await pool.query(`
    insert into users(id,"legacyId",display_name,login_enabled) values
      (101,'usr_upgrade_admin','Demo Upgrade Admin',true),
      (102,'usr_upgrade_approver','Demo Upgrade Approver',true);
    insert into seasons(id,name,year,timezone) values ('sea_hosted','Demo Season',2026,'America/Los_Angeles');
    insert into teams(id,name) values ('tem_home','Demo Home'),('tem_away','Demo Away'),('tem_old','Demo Old Opponent');
    insert into games(id,home_team_id,away_team_id,season_id,start_at,status,home_score,away_score,linescore) values
      ('gam_hosted','tem_home','tem_away','sea_hosted','2026-09-01T18:00:00Z','final',4,2,'{"home":{"r":4},"away":{"r":2}}'),
      ('gam_outside','tem_home','tem_away',null,'2026-09-02T18:00:00Z','scheduled',null,null,null);
  `)
  const game = {
    homeTeamId: 'tem_home',
    awayTeamId: 'tem_away',
    seasonId: 'sea_hosted',
    startAt: '2026-09-01T18:00:00Z',
    venue: 'Demo Field',
    outsideTournament: null,
    status: 'scheduled'
  }
  for (const row of [
    {
      id: 'req_edit',
      status: 'pending',
      gameId: 'gam_hosted',
      terms: {
        kind: 'game',
        game,
        gameId: 'gam_hosted',
        affectedTeamIds: ['tem_home', 'tem_away', 'tem_old'],
        hostSeasonIds: ['sea_hosted']
      }
    },
    {
      id: 'req_new',
      status: 'pending',
      gameId: null,
      terms: { kind: 'game', game, gameId: null }
    },
    {
      id: 'req_terms_id',
      status: 'pending',
      gameId: null,
      terms: { kind: 'game', game, gameId: 'gam_outside' }
    },
    {
      id: 'req_reserved',
      status: 'pending',
      gameId: null,
      terms: {
        kind: 'game',
        game,
        gameId: null,
        proposedGameId: 'gam_reserved',
        replacesGameId: 'gam_hosted'
      }
    },
    {
      id: 'req_accepted',
      status: 'accepted',
      gameId: 'gam_hosted',
      terms: { kind: 'game', game, gameId: 'gam_hosted' }
    }
  ])
    await pool.query(
      `insert into group_requests(id,kind,sender_id,sender_scope_type,sender_scope_id,terms,status,sent_at,expires_at,game_id) values($1,'game',101,'team','tem_home',$2,$3,'2026-09-01T12:00:00Z','2026-09-08T12:00:00Z',$4)`,
      [row.id, JSON.stringify(row.terms), row.status, row.gameId]
    )
  await pool.query(`
    insert into group_requests(id,kind,sender_id,sender_scope_type,sender_scope_id,terms,status,sent_at,expires_at)
      values('req_participation','participation',101,'season','sea_hosted','{"kind":"participation","seasonId":"sea_hosted","teamId":"tem_home"}','pending','2026-09-01T12:00:00Z','2026-09-08T12:00:00Z');
  `)
  await pool.query(
    `insert into group_request_sides(request_id,scope_type,scope_id) values('req_new','season','sea_hosted')`
  )
  for (const request of ['req_edit', 'req_accepted', 'req_participation'])
    for (const [scope, id] of [
      ['team', 'tem_home'],
      ['team', 'tem_away'],
      ['team', 'tem_old'],
      ['season', 'sea_hosted'],
      ['user', '102']
    ])
      await pool.query(
        `insert into group_request_sides(request_id,scope_type,scope_id,approved_by,approved_at) values($1,$2,$3,102,'2026-09-01T13:00:00Z')`,
        [request, scope, id]
      )
}
