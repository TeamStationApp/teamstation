import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import { verifiedPrefix } from '../../common/chatCrypto/logHash'
import { compareUserIds } from '../../common/chatCrypto/userId'
import { makeId } from '../../common/ids'
import { migrations } from '../../migrate/migrations'
import { migrateUp } from '../../migrate/runner'
import {
  dropScratchDatabase,
  testDatabaseUrl
} from '../../migrate/testDatabase'
import { type Database, makeDatabase } from '../db/database'
import { type ChatFixture, openChatFixture } from './chatTestFixture'
import { createDm } from './dms'
import { appendLog, joinMembers, openGrantRequests } from './membershipLog'
import {
  ChatReconciler,
  drainDirty,
  memberNow,
  reconcileConversation,
  reconcileScope,
  sweep,
  targetsOf
} from './reconciler'

/**
 * U5, the reconciler: log rows, grant requests, rotation, lazy creation,
 * `memberNow`, the hash chain, DM re-checks, the sweep and the listener.
 */

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** Every conversation's log, checked from its first row. */
async function chainsVerify(db: Kysely<Database>): Promise<boolean> {
  const rows = await db
    .selectFrom('chat_membership_log')
    .selectAll()
    .orderBy('conversation_id')
    .orderBy('seq')
    .execute()
  const byConversation = new Map<string, typeof rows>()
  for (const row of rows) {
    const list = byConversation.get(row.conversation_id) ?? []
    list.push(row)
    byConversation.set(row.conversation_id, list)
  }
  for (const [conversationId, list] of byConversation) {
    const verified = verifiedPrefix(
      new Uint8Array(32),
      list.map(row => ({
        conversationId,
        seq: Number(row.seq),
        event: row.event,
        userId: row.user_id,
        actorUserId: row.actor_user_id,
        reason: row.reason,
        at: row.at,
        prevHash: new Uint8Array(row.prev_hash),
        hash: new Uint8Array(row.hash)
      }))
    )
    if (verified !== list.length) return false
    const conversation = await db
      .selectFrom('chat_conversations')
      .select(['last_log_seq'])
      .where('id', '=', conversationId)
      .executeTakeFirstOrThrow()
    if (Number(conversation.last_log_seq) !== list.length) return false
  }
  return true
}

/** Gives a user an identity and a per-user key generation (raw rows). */
async function giveIdentity(
  db: Kysely<Database>,
  userId: string
): Promise<string> {
  const identityId = makeId('chatIdentity')
  await db
    .insertInto('chat_identities')
    .values({
      id: identityId,
      user_id: userId,
      identity_public_key: new Uint8Array(32).fill(7)
    })
    .execute()
  await db
    .insertInto('chat_user_keys')
    .values({
      user_id: userId,
      identity_id: identityId,
      generation: 1,
      public_key: new Uint8Array(32).fill(7),
      signature: new Uint8Array(64)
    })
    .execute()
  return identityId
}

/** Epoch 1 of a conversation, by a user with an identity. */
async function giveEpoch(
  db: Kysely<Database>,
  conversationId: string,
  userId: string,
  identityId: string,
  boxed: Array<{ userId: string; identityId: string }>
): Promise<void> {
  await db
    .insertInto('chat_epochs')
    .values({
      conversation_id: conversationId,
      epoch: 1,
      created_by_user_id: userId,
      identity_id: identityId,
      signature: new Uint8Array(64)
    })
    .execute()
  for (const box of boxed) {
    await db
      .insertInto('chat_epoch_boxes')
      .values({
        conversation_id: conversationId,
        epoch: 1,
        user_id: box.userId,
        identity_id: box.identityId,
        generation: 1,
        box: new Uint8Array(48)
      })
      .execute()
  }
}

describe('the chat reconciler (U5)', function () {
  this.timeout(120000)
  let fixture: ChatFixture
  let db: Kysely<Database>

  before(async function () {
    const opened = await openChatFixture('reconciler', { reconcile: false })
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
    db = fixture.db
  })

  after(async function () {
    await fixture?.close()
  })

  async function conversation(
    kind: string,
    scopeId: string
  ): Promise<{ id: string; needs_rotation: boolean; last_log_seq: number }> {
    return await db
      .selectFrom('chat_conversations')
      .select(['id', 'needs_rotation', 'last_log_seq'])
      .where('kind', '=', kind as never)
      .where('scope_id', '=', scopeId)
      .executeTakeFirstOrThrow()
  }

  async function members(conversationId: string): Promise<string[]> {
    const rows = await db
      .selectFrom('chat_members')
      .select(['user_id'])
      .where('conversation_id', '=', conversationId)
      .where('left_at', 'is', null)
      .execute()
    return rows.map(row => fixture.keyOf(row.user_id)).sort()
  }

  async function log(
    conversationId: string
  ): Promise<Array<{ event: string; who: string; reason: string | null }>> {
    const rows = await db
      .selectFrom('chat_membership_log')
      .select(['event', 'user_id', 'reason'])
      .where('conversation_id', '=', conversationId)
      .orderBy('seq')
      .execute()
    return rows.map(row => ({
      event: row.event,
      who: fixture.keyOf(row.user_id),
      reason: row.reason
    }))
  }

  it('creates the chats whose audience is not empty on its first run', async function () {
    const taken = await fixture.drain()
    expect(taken).to.be.greaterThan(0)
    const rows = await db
      .selectFrom('chat_conversations')
      .select(['kind', 'scope_id'])
      .execute()
    const { teams, seasonId, leagueId } = fixture.seed
    const made = rows.map(row => `${row.kind} ${row.scope_id}`).sort()
    expect(made).deep.equals(
      [
        `teamStaff ${teams.hawks}`,
        `teamMembers ${teams.hawks}`,
        `teamFans ${teams.hawks}`,
        `teamStaff ${teams.eagles}`,
        `teamMembers ${teams.eagles}`,
        `teamFans ${teams.eagles}`,
        `seasonStaff ${seasonId}`,
        `seasonAllStaff ${seasonId}`,
        `seasonAnnouncements ${seasonId}`,
        `leagueOrg ${leagueId}`
      ].sort()
    )
    expect(await db.selectFrom('chat_dirty').selectAll().execute()).deep.equals(
      []
    )
  })

  it('writes a join row for each member, and the chain verifies', async function () {
    const staff = await conversation('teamStaff', fixture.seed.teams.hawks)
    expect(await members(staff.id)).deep.equals(['Ha', 'Hc', 'Hk', 'Hs'])
    const rows = await log(staff.id)
    const expected = ['Ha', 'Hc', 'Hk', 'Hs']
      .sort((a, b) => compareUserIds(fixture.id(a), fixture.id(b)))
      .map(key => `join ${key} audience`)
    expect(
      rows.map(row => `${row.event} ${row.who} ${row.reason}`)
    ).deep.equals(expected)
    expect(staff.needs_rotation).equals(false)
    expect(await chainsVerify(db)).equals(true)
  })

  it('does nothing when the audience has not changed', async function () {
    const staff = await conversation('teamStaff', fixture.seed.teams.hawks)
    const again = await reconcileScope(
      db,
      'teamStaff',
      fixture.seed.teams.hawks,
      fixture.now
    )
    expect(again).deep.equals({
      conversationId: staff.id,
      joined: [],
      left: []
    })
    expect(
      await reconcileScope(
        db,
        'teamStaff',
        fixture.seed.teams.owls,
        fixture.now
      )
    ).deep.equals({ conversationId: null, joined: [], left: [] })
  })

  it('writes a leave row and flags rotation when somebody goes', async function () {
    await db
      .deleteFrom('scope_roles')
      .where('user_id', '=', fixture.id('Hk'))
      .where('scope_id', '=', fixture.seed.teams.hawks)
      .execute()
    await fixture.drain()
    const staff = await conversation('teamStaff', fixture.seed.teams.hawks)
    expect(await members(staff.id)).deep.equals(['Ha', 'Hc', 'Hs'])
    expect((await log(staff.id)).at(-1)).deep.equals({
      event: 'leave',
      who: 'Hk',
      reason: 'audience'
    })
    expect(staff.needs_rotation).equals(true)
    // Still a Hawks member.
    const team = await conversation('teamMembers', fixture.seed.teams.hawks)
    expect(await members(team.id)).includes('Hk')
    expect(await chainsVerify(db)).equals(true)
  })

  it('notifies chat_changes with members', async function () {
    const listener = new Client({ connectionString: fixture.url })
    await listener.connect()
    const heard: string[] = []
    listener.on('notification', message => {
      if (message.payload != null) heard.push(message.payload)
    })
    await listener.query('listen chat_changes')
    const j = await fixture.person('J0')
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: j,
        team_id: fixture.seed.teams.hawks,
        role: 'member'
      })
      .execute()
    await fixture.drain()
    await wait(200)
    await listener.end()
    const team = await conversation('teamMembers', fixture.seed.teams.hawks)
    expect(heard).includes(JSON.stringify({ c: team.id, k: 'members' }))
  })

  it('opens grant requests for joiners with an identity, and none for those without', async function () {
    const team = await conversation('teamMembers', fixture.seed.teams.hawks)
    const hc = fixture.id('Hc')
    const hcIdentity = await giveIdentity(db, hc)
    // No epoch yet: nothing to grant.
    expect(await openGrantRequests(db, team.id, [hc])).equals(0)
    await giveEpoch(db, team.id, hc, hcIdentity, [
      { userId: hc, identityId: hcIdentity }
    ])
    const j1 = await fixture.person('J1')
    const j2 = await fixture.person('J2')
    await giveIdentity(db, j1)
    for (const userId of [j1, j2]) {
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: userId,
          team_id: fixture.seed.teams.hawks,
          role: 'member'
        })
        .execute()
    }
    await fixture.drain()
    const requests = await db
      .selectFrom('chat_grant_requests')
      .select(['user_id', 'generation', 'identity_reset'])
      .where('conversation_id', '=', team.id)
      .execute()
    expect(requests).deep.equals([
      { user_id: j1, generation: 1, identity_reset: false }
    ])
    // A member who holds a box is not asked for.
    expect(await openGrantRequests(db, team.id, [hc])).equals(0)
  })

  it('counts log seq apart from message seq', async function () {
    const team = await conversation('teamMembers', fixture.seed.teams.hawks)
    await db
      .updateTable('chat_conversations')
      .set({ last_seq: 41 })
      .where('id', '=', team.id)
      .execute()
    const before = Number(team.last_log_seq)
    await appendLog(db, team.id, [], fixture.now)
    const j3 = await fixture.person('J3')
    await joinMembers(db, team.id, [j3], null, 'audience', fixture.now)
    const after = await db
      .selectFrom('chat_conversations')
      .select(['last_seq', 'last_log_seq'])
      .where('id', '=', team.id)
      .executeTakeFirstOrThrow()
    expect(Number(after.last_seq)).equals(41)
    expect(Number(after.last_log_seq)).equals(before + 1)
    // The reconciler takes J3 out again: no membership.
    await reconcileScope(
      db,
      'teamMembers',
      fixture.seed.teams.hawks,
      fixture.now
    )
    expect(await members(team.id)).not.includes('J3')
    expect(await chainsVerify(db)).equals(true)
  })

  it('memberNow reconciles a dirty conversation before refusing', async function () {
    const team = await conversation('teamMembers', fixture.seed.teams.hawks)
    const j4 = await fixture.person('J4')
    expect(await memberNow(db, team.id, j4, fixture.now)).equals(false)
    await db
      .insertInto('memberships')
      .values({
        id: makeId('membership'),
        user_id: j4,
        team_id: fixture.seed.teams.hawks,
        role: 'member'
      })
      .execute()
    expect(await memberNow(db, team.id, j4, fixture.now)).equals(true)
    // The mark stays for the reconciler.
    const marks = await db.selectFrom('chat_dirty').selectAll().execute()
    expect(marks.length).to.be.greaterThan(0)
    expect(await memberNow(db, 'cnv_missing', j4, fixture.now)).equals(false)
    await fixture.drain()
  })

  it('two concurrent reconciliations write each join once', async function () {
    const announcements = await conversation(
      'seasonAnnouncements',
      fixture.seed.seasonId
    )
    const j5 = await fixture.person('J5')
    await db
      .insertInto('season_members')
      .values({
        id: makeId('seasonMember'),
        user_id: j5,
        season_id: fixture.seed.seasonId
      })
      .execute()
    await Promise.all([
      reconcileScope(
        db,
        'seasonAnnouncements',
        fixture.seed.seasonId,
        fixture.now
      ),
      memberNow(db, announcements.id, j5, fixture.now),
      reconcileConversation(db, announcements.id, fixture.now),
      fixture.drain()
    ])
    const joins = await db
      .selectFrom('chat_membership_log')
      .select(['seq'])
      .where('conversation_id', '=', announcements.id)
      .where('user_id', '=', j5)
      .where('event', '=', 'join')
      .execute()
    expect(joins).to.have.length(1)
    expect(await chainsVerify(db)).equals(true)
  })

  it('expands marks: a team reaches its seasons, a league its seasons, a user their chats', async function () {
    const { teams, seasonId, leagueId } = fixture.seed
    const byTeam = await targetsOf(db, [
      { scope_type: 'team', scope_id: teams.owls }
    ])
    expect(byTeam.scopes.map(s => `${s.kind} ${s.scopeId}`).sort()).deep.equals(
      [
        `seasonAllStaff ${seasonId}`,
        `seasonAnnouncements ${seasonId}`,
        `seasonStaff ${seasonId}`,
        `teamFans ${teams.owls}`,
        `teamMembers ${teams.owls}`,
        `teamStaff ${teams.owls}`
      ]
    )
    const byLeague = await targetsOf(db, [
      { scope_type: 'league', scope_id: leagueId }
    ])
    expect(byLeague.scopes.map(s => s.kind).sort()).deep.equals([
      'leagueOrg',
      'seasonAllStaff',
      'seasonAnnouncements',
      'seasonStaff'
    ])
    const byUser = await targetsOf(db, [
      { scope_type: 'user', scope_id: String(fixture.id('G1')) },
      { scope_type: 'user', scope_id: 'not a number' }
    ])
    expect(byUser.scopes.map(s => `${s.kind} ${s.scopeId}`)).includes(
      `teamMembers ${teams.hawks}`
    )
  })

  it('removes a DM member who turns under 13 or loses their account, at once', async function () {
    const p = fixture.id('P')
    const e = fixture.id('E')
    const made = await createDm(db, e, [p], fixture.now)
    expect(await memberNow(db, made.conversationId, e, fixture.now)).equals(
      true
    )
    await db
      .updateTable('users')
      .set({ birth_year: 2016, birth_month: 1 })
      .where('id', '=', e)
      .execute()
    // At once, before the reconciler runs.
    expect(await memberNow(db, made.conversationId, e, fixture.now)).equals(
      false
    )
    await fixture.drain()
    const rows = await log(made.conversationId)
    expect(rows.at(-1)).deep.equals({
      event: 'leave',
      who: 'E',
      reason: 'notEligible'
    })
    const dm = await db
      .selectFrom('chat_conversations')
      .select(['needs_rotation', 'closed_at'])
      .where('id', '=', made.conversationId)
      .executeTakeFirstOrThrow()
    expect(dm.needs_rotation).equals(true)
    expect(dm.closed_at).equals(null)
    await db
      .updateTable('users')
      .set({ birth_year: 2011, birth_month: 2 })
      .where('id', '=', e)
      .execute()
    await fixture.drain()

    // Losing every way to sign in.
    const k = fixture.id('K')
    const second = await createDm(db, k, [p], fixture.now)
    await db.deleteFrom('user_emails').where('user_id', '=', k).execute()
    await db
      .updateTable('users')
      .set({ password_hash: null })
      .where('id', '=', k)
      .execute()
    expect(await memberNow(db, second.conversationId, k, fixture.now)).equals(
      false
    )
    await fixture.drain()
    expect((await log(second.conversationId)).at(-1)).deep.equals({
      event: 'leave',
      who: 'K',
      reason: 'notEligible'
    })
    expect(await chainsVerify(db)).equals(true)
  })

  it('closes a DM on the next run when a coach role or the season goes', async function () {
    const p = fixture.id('P')
    const hc = fixture.id('Hc')
    const s = fixture.id('S')
    const coachDm = await createDm(db, hc, [p], fixture.now)
    const seasonDm = await createDm(db, s, [p], fixture.now)
    await db
      .deleteFrom('scope_roles')
      .where('user_id', '=', hc)
      .where('scope_id', '=', fixture.seed.teams.hawks)
      .execute()
    await fixture.drain()
    const closed = async (id: string): Promise<boolean> =>
      (
        await db
          .selectFrom('chat_conversations')
          .select(['closed_at'])
          .where('id', '=', id)
          .executeTakeFirstOrThrow()
      ).closed_at != null
    expect(await closed(coachDm.conversationId)).equals(true)
    expect((await log(coachDm.conversationId)).at(-1)).deep.equals({
      event: 'closed',
      who: 'P',
      reason: 'pairRule'
    })
    expect(await closed(seasonDm.conversationId)).equals(false)

    await db
      .deleteFrom('season_teams')
      .where('team_id', '=', fixture.seed.teams.hawks)
      .execute()
    await fixture.drain()
    expect(await closed(seasonDm.conversationId)).equals(true)
    // Put things back for the cases below.
    await db
      .insertInto('season_teams')
      .values({
        season_id: fixture.seed.seasonId,
        team_id: fixture.seed.teams.hawks
      })
      .execute()
    await db
      .insertInto('scope_roles')
      .values({
        id: makeId('scopeRole'),
        user_id: hc,
        scope_type: 'team',
        scope_id: fixture.seed.teams.hawks,
        role: 'coach'
      })
      .execute()
    await fixture.drain()
    expect(await chainsVerify(db)).equals(true)
  })

  it('leaves DM membership to the DM routes', async function () {
    const p = fixture.id('P')
    const g2 = fixture.id('G2')
    const dm = await createDm(db, g2, [p], fixture.now)
    await sweep(db, fixture.now)
    expect(await members(dm.conversationId)).deep.equals(['G2', 'P'])
  })

  it('lets a player in on the first of the month after they turn 13, at the sweep', async function () {
    const team = await conversation('teamMembers', fixture.seed.teams.hawks)
    expect(await members(team.id)).not.includes('T')
    fixture.now = new Date('2027-05-01T00:00:00Z')
    await sweep(db, fixture.now)
    expect(await members(team.id)).includes('T')
    expect(await members(team.id)).not.includes('R')
  })

  it('creates a missing scope chat at the sweep', async function () {
    await db
      .deleteFrom('chat_conversations')
      .where('kind', '=', 'leagueOrg')
      .execute()
    await sweep(db, fixture.now)
    const org = await conversation('leagueOrg', fixture.seed.leagueId)
    expect(await members(org.id)).deep.equals(['L'])
  })

  it('puts the marks back when a conversation fails', async function () {
    const failing = new Proxy(db, {
      get(target, prop) {
        if (prop === 'transaction') {
          return () => {
            throw new Error('down')
          }
        }
        const value = Reflect.get(target, prop, target)
        return typeof value === 'function' ? value.bind(target) : value
      }
    })
    await db
      .insertInto('chat_dirty')
      .values({ scope_type: 'league', scope_id: fixture.seed.leagueId })
      .execute()
    const lines: string[] = []
    let threw = false
    try {
      await drainDirty(failing, fixture.now, line => lines.push(line))
    } catch {
      threw = true
    }
    expect(threw).equals(true)
    expect(lines.length).to.be.greaterThan(0)
    const marks = await db
      .selectFrom('chat_dirty')
      .select(['scope_type', 'scope_id'])
      .execute()
    expect(marks).deep.equals([
      { scope_type: 'league', scope_id: fixture.seed.leagueId }
    ])
    await fixture.drain()
  })

  it('listens, drains on start, and listens again after losing the connection', async function () {
    const lines: string[] = []
    const j6 = await fixture.person('J6')
    // Marked before it starts.
    await db
      .insertInto('league_members')
      .values({
        id: makeId('leagueMember'),
        user_id: j6,
        league_id: fixture.seed.leagueId
      })
      .execute()
    const reconciler = new ChatReconciler({
      db,
      databaseUrl: fixture.url,
      debounceMs: 20,
      now: () => fixture.now,
      log: line => lines.push(line)
    })
    try {
      await reconciler.listening
      const announcements = await conversation(
        'seasonAnnouncements',
        fixture.seed.seasonId
      )
      expect(await members(announcements.id)).includes('J6')

      // A mark while listening is drained within the debounce.
      const j7 = await fixture.person('J7')
      await db
        .insertInto('league_members')
        .values({
          id: makeId('leagueMember'),
          user_id: j7,
          league_id: fixture.seed.leagueId
        })
        .execute()
      for (let i = 0; i < 50; i += 1) {
        if ((await members(announcements.id)).includes('J7')) break
        await wait(50)
      }
      expect(await members(announcements.id)).includes('J7')

      // Cut the listen connection; a mark made while it is down is drained
      // on the reconnect, a second later.
      const pool = new Pool({ connectionString: fixture.url })
      await pool.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
         where datname = current_database() and query ilike 'listen chat_dirty%'`
      )
      await pool.end()
      await wait(100)
      const j8 = await fixture.person('J8')
      const cutAt = Date.now()
      await db
        .insertInto('league_members')
        .values({
          id: makeId('leagueMember'),
          user_id: j8,
          league_id: fixture.seed.leagueId
        })
        .execute()
      for (let i = 0; i < 100; i += 1) {
        if ((await members(announcements.id)).includes('J8')) break
        await wait(50)
      }
      expect(await members(announcements.id)).includes('J8')
      expect(Date.now() - cutAt).to.be.greaterThan(700)
      expect(lines.some(line => line.includes('lost the chat_dirty'))).equals(
        true
      )
      await reconciler.sweep()
      reconciler.notified()
    } finally {
      await reconciler.close()
    }
    reconciler.notified()
    await reconciler.drain()
  })
})

describe('the chat reconciler over data from before 051 (U5)', function () {
  this.timeout(120000)
  const name = `teamstation_chat_before051_${Date.now()}_${process.pid}`
  const url = testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`)
  let adminPool: Pool | undefined

  before(async function () {
    adminPool = new Pool({ connectionString: testDatabaseUrl })
    try {
      await adminPool.query('select 1')
    } catch {
      await adminPool.end()
      adminPool = undefined
      this.skip()
    }
  })

  after(async function () {
    if (adminPool == null) return
    await dropScratchDatabase(adminPool, name)
    await adminPool.end()
  })

  it('creates the scope chats on its first run', async function () {
    await adminPool?.query(`create database ${name}`)
    const at = migrations.findIndex(migration => migration.name === '052chat')
    const seed = {
      leagueId: 'lea_legacy',
      seasonId: 'sea_legacy',
      teams: { hawks: 'tem_legacy' }
    }
    await (async () => {
      const pool = new Pool({ connectionString: url })
      try {
        await migrateUp(pool, migrations.slice(0, at))
        // Historical account rows really are bigint before 069. The current
        // seed intentionally mints full-width accounts and cannot seed this era.
        await pool.query(`
          insert into users(id,"legacyId",display_name,password_hash,birth_year,birth_month)
            select n, 'usr_' || lpad(n::text,16,'1'), 'Hank Aaron', 'fixture', 1990, 1
            from generate_series(1,5) n;
          insert into user_emails(id,user_id,email,is_primary,verified_at)
            select 'uem_legacy_' || n,n,n || '@example.test',true,now() from generate_series(1,5) n;
          insert into leagues(id,name) values('lea_legacy','Legacy League');
          insert into seasons(id,league_id,name,year) values('sea_legacy','lea_legacy','Legacy Season',2027);
          insert into teams(id,name) values('tem_legacy','Legacy Team');
          insert into season_teams(season_id,team_id) values('sea_legacy','tem_legacy');
          insert into scope_roles(id,user_id,scope_type,scope_id,role) values
            ('sro_legacy_1',1,'league','lea_legacy','admin'),
            ('sro_legacy_2',2,'season','sea_legacy','coach'),
            ('sro_legacy_3',3,'team','tem_legacy','coach');
          insert into memberships(id,user_id,team_id,role,is_player) values
            ('mem_legacy_3',3,'tem_legacy','member',false),
            ('mem_legacy_4',4,'tem_legacy','member',true);
          insert into team_follows(user_id,team_id) values(5,'tem_legacy');
        `)
        await migrateUp(pool, migrations)
      } finally {
        await pool.end()
      }
    })()
    const db = makeDatabase(url)
    try {
      expect(
        await db.selectFrom('chat_conversations').selectAll().execute()
      ).deep.equals([])
      await drainDirty(db, new Date('2027-04-10T12:00:00Z'))
      const rows = await db
        .selectFrom('chat_conversations')
        .select(['kind'])
        .where('scope_id', 'in', [
          seed.teams.hawks,
          seed.seasonId,
          seed.leagueId
        ])
        .execute()
      expect(rows.map(row => row.kind).sort()).deep.equals([
        'leagueOrg',
        'seasonAllStaff',
        'seasonAnnouncements',
        'seasonStaff',
        'teamFans',
        'teamMembers',
        'teamStaff'
      ])
    } finally {
      await db.destroy()
    }
  })
})
