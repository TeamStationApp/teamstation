import { expect } from 'chai'
import { after, before, beforeEach, describe, it } from 'mocha'
import { Client, Pool } from 'pg'

import { migrations } from './migrations'
import { migration052Chat } from './migrations/052chat'
import { migrateDown, migrateUp } from './runner'
import { schemaSnapshot } from './schemaSnapshot'
import { dropScratchDatabase, testDatabaseUrl } from './testDatabase'

/**
 * U4: 052 over a database that already has teams, seasons and leagues, then
 * every trigger that marks a chat scope dirty.
 *
 * Each case clears `chat_dirty`, writes one row, and reads back exactly the
 * marks it left and whether `chat_dirty` was notified. A barrier notify sent
 * after the write arrives after any notify the write made, so "no notify" is
 * read without waiting on a clock.
 */
const adminUrl = testDatabaseUrl
const name = `teamstation_052_${Date.now()}_${process.pid}`
const url = adminUrl.replace(/\/[^/]*$/, `/${name}`)

const before052 = migrations.filter(
  migration => migration.name < migration052Chat.name
)
const through052 = migrations.filter(
  migration => migration.name <= migration052Chat.name
)

const ANN = 201
const BEN = 202
const CAT = 203
const DAN = 204

const FIXTURE = `
insert into users (id, "legacyId", display_name) values
  (${ANN}, 'u201', 'Ann'), (${BEN}, 'u202', 'Ben'),
  (${CAT}, 'u203', 'Cat'), (${DAN}, 'u204', 'Dan');
insert into leagues (id, name) values ('lea_a', 'A'), ('lea_b', 'B');
insert into seasons (id, name, year, league_id) values
  ('sea_a', 'Spring', 2027, 'lea_a'),
  ('sea_b', 'Fall', 2027, null);
insert into teams (id, name, kind) values
  ('tem_a', 'Hawks', 'full'),
  ('tem_b', 'Eagles', 'full'),
  ('tem_old', 'Old Hawks', 'full'),
  ('tem_x', 'Visitors', 'external');
update teams set merged_into = 'tem_a' where id = 'tem_old';
`

describe('052: chat tables and the dirty-scope triggers', function () {
  this.timeout(120000)

  let admin: Pool | undefined
  let pool: Pool | undefined
  let listener: Client | undefined
  let notified = 0
  let barrier: (() => void) | undefined

  const live = (): Pool => {
    if (pool == null) throw new Error('no database')
    return pool
  }
  const sql = async (text: string): Promise<void> => {
    await live().query(text)
  }
  const dirty = async (): Promise<string[]> => {
    const { rows } = await live().query<{ mark: string }>(
      `select scope_type || ':' || scope_id as mark from chat_dirty
       order by mark`
    )
    return rows.map(row => row.mark)
  }

  /** Waits for every notify sent before now to have arrived. */
  const settle = async (): Promise<void> => {
    const arrived = new Promise<void>(resolve => {
      barrier = resolve
    })
    await sql(`select pg_notify('chat_test_barrier', '')`)
    await arrived
  }

  /** Runs `text` on a clean slate: the marks it left, and if it notified. */
  const marks = async (
    text: string
  ): Promise<{ marks: string[]; notified: boolean }> => {
    await sql('delete from chat_dirty')
    await settle()
    notified = 0
    await sql(text)
    await settle()
    return { marks: await dirty(), notified: notified > 0 }
  }
  const marked = (...list: string[]): { marks: string[]; notified: true } => ({
    marks: [...list].sort(),
    notified: true
  })
  const nothing = { marks: [], notified: false }

  const refused = async (text: string): Promise<string> => {
    try {
      await sql(text)
    } catch (error) {
      return String(error)
    }
    return 'accepted'
  }

  before(async function () {
    admin = new Pool({ connectionString: adminUrl })
    try {
      await admin.query('select 1')
    } catch {
      await admin.end()
      admin = undefined
      this.skip()
      return
    }
    await admin.query(`create database ${name}`)
    pool = new Pool({ connectionString: url })
    await migrateUp(pool, before052)
    await sql(FIXTURE)
    expect(
      await migrateUp(pool, through052).then(result => result.applied)
    ).deep.equals([migration052Chat.name])
    listener = new Client({ connectionString: url })
    await listener.connect()
    listener.on('notification', message => {
      if (message.channel === 'chat_dirty') notified += 1
      if (message.channel === 'chat_test_barrier') barrier?.()
    })
    await listener.query('listen chat_dirty')
    await listener.query('listen chat_test_barrier')
  })

  after(async function () {
    if (listener != null) await listener.end()
    if (pool != null) await pool.end()
    if (admin != null) {
      await dropScratchDatabase(admin, name)
      await admin.end()
    }
  })

  describe('on upgrade', function () {
    it('marks every unmerged full team, every season and every league that was there before', async function () {
      expect(await dirty()).deep.equals([
        'league:lea_a',
        'league:lea_b',
        'season:sea_a',
        'season:sea_b',
        'team:tem_a',
        'team:tem_b'
      ])
    })
  })

  describe('memberships', function () {
    beforeEach(async function () {
      await sql('delete from memberships')
      await sql(
        `insert into memberships (id, user_id, team_id) values ('mem_1', ${ANN}, 'tem_a')`
      )
    })

    it('marks the team and the user on insert and delete', async function () {
      expect(
        await marks(
          `insert into memberships (id, user_id, team_id) values ('mem_2', ${BEN}, 'tem_b')`
        )
      ).deep.equals(marked('team:tem_b', `user:${BEN}`))
      expect(
        await marks(`delete from memberships where id = 'mem_2'`)
      ).deep.equals(marked('team:tem_b', `user:${BEN}`))
    })

    it('marks both sides when a row moves to another team and user', async function () {
      expect(
        await marks(
          `update memberships set team_id = 'tem_b', user_id = ${BEN} where id = 'mem_1'`
        )
      ).deep.equals(
        marked('team:tem_a', 'team:tem_b', `user:${ANN}`, `user:${BEN}`)
      )
    })

    it('marks on a role or player change, and not on a jersey', async function () {
      expect(
        await marks(`update memberships set role = 'owner' where id = 'mem_1'`)
      ).deep.equals(marked('team:tem_a', `user:${ANN}`))
      expect(
        await marks(
          `update memberships set is_player = true where id = 'mem_1'`
        )
      ).deep.equals(marked('team:tem_a', `user:${ANN}`))
      expect(
        await marks(`update memberships set jersey = '7' where id = 'mem_1'`)
      ).deep.equals(nothing)
    })
  })

  describe('scope_roles', function () {
    it('marks its scope and the user, and both sides of a move', async function () {
      expect(
        await marks(
          `insert into scope_roles (id, user_id, scope_type, scope_id, role)
           values ('rol_1', ${ANN}, 'season', 'sea_a', 'coach')`
        )
      ).deep.equals(marked('season:sea_a', `user:${ANN}`))
      expect(
        await marks(
          `update scope_roles set scope_type = 'league', scope_id = 'lea_a', user_id = ${BEN}
           where id = 'rol_1'`
        )
      ).deep.equals(
        marked('season:sea_a', 'league:lea_a', `user:${ANN}`, `user:${BEN}`)
      )
      expect(
        await marks(`update scope_roles set role = 'admin' where id = 'rol_1'`)
      ).deep.equals(marked('league:lea_a', `user:${BEN}`))
      expect(
        await marks(
          `update scope_roles set granted_at = now() - interval '1 day' where id = 'rol_1'`
        )
      ).deep.equals(nothing)
      expect(
        await marks(`delete from scope_roles where id = 'rol_1'`)
      ).deep.equals(marked('league:lea_a', `user:${BEN}`))
    })
  })

  describe('team_follows', function () {
    it('marks the team and the user, and both sides of a move', async function () {
      expect(
        await marks(
          `insert into team_follows (user_id, team_id) values (${CAT}, 'tem_a')`
        )
      ).deep.equals(marked('team:tem_a', `user:${CAT}`))
      expect(
        await marks(
          `update team_follows set team_id = 'tem_b', user_id = ${DAN} where user_id = ${CAT}`
        )
      ).deep.equals(
        marked('team:tem_a', 'team:tem_b', `user:${CAT}`, `user:${DAN}`)
      )
      expect(
        await marks(
          `update team_follows set created_at = now() where user_id = ${DAN}`
        )
      ).deep.equals(nothing)
      expect(
        await marks(`delete from team_follows where user_id = ${DAN}`)
      ).deep.equals(marked('team:tem_b', `user:${DAN}`))
    })
  })

  describe('season_members and league_members', function () {
    it('marks the season', async function () {
      expect(
        await marks(
          `insert into season_members (id, user_id, season_id) values ('smb_1', ${ANN}, 'sea_a')`
        )
      ).deep.equals(marked('season:sea_a'))
      expect(
        await marks(
          `update season_members set season_id = 'sea_b' where id = 'smb_1'`
        )
      ).deep.equals(marked('season:sea_a', 'season:sea_b'))
      expect(
        await marks(
          `update season_members set role = 'member' where id = 'smb_1'`
        )
      ).deep.equals(marked('season:sea_b'))
      expect(
        await marks(
          `update season_members set source = 'import' where id = 'smb_1'`
        )
      ).deep.equals(nothing)
      expect(
        await marks(`delete from season_members where id = 'smb_1'`)
      ).deep.equals(marked('season:sea_b'))
    })

    it('marks the league', async function () {
      expect(
        await marks(
          `insert into league_members (id, user_id, league_id) values ('lmb_1', ${ANN}, 'lea_a')`
        )
      ).deep.equals(marked('league:lea_a'))
      expect(
        await marks(
          `update league_members set league_id = 'lea_b', user_id = ${BEN} where id = 'lmb_1'`
        )
      ).deep.equals(marked('league:lea_a', 'league:lea_b'))
      expect(
        await marks(
          `update league_members set source = 'import' where id = 'lmb_1'`
        )
      ).deep.equals(nothing)
      expect(
        await marks(`delete from league_members where id = 'lmb_1'`)
      ).deep.equals(marked('league:lea_b'))
    })
  })

  describe('season_teams', function () {
    it('marks the season and the team', async function () {
      expect(
        await marks(
          `insert into season_teams (season_id, team_id) values ('sea_a', 'tem_a')`
        )
      ).deep.equals(marked('season:sea_a', 'team:tem_a'))
      expect(
        await marks(
          `update season_teams set season_id = 'sea_b', team_id = 'tem_b'
           where season_id = 'sea_a' and team_id = 'tem_a'`
        )
      ).deep.equals(
        marked('season:sea_a', 'season:sea_b', 'team:tem_a', 'team:tem_b')
      )
      expect(
        await marks(`update season_teams set joined_at = now()`)
      ).deep.equals(nothing)
      expect(await marks(`delete from season_teams`)).deep.equals(
        marked('season:sea_b', 'team:tem_b')
      )
    })
  })

  describe('seasons', function () {
    it('marks the season when it comes, goes, or changes league', async function () {
      expect(
        await marks(
          `insert into seasons (id, name, year, league_id) values ('sea_c', 'Summer', 2027, 'lea_a')`
        )
      ).deep.equals(marked('season:sea_c'))
      expect(
        await marks(`update seasons set league_id = 'lea_b' where id = 'sea_c'`)
      ).deep.equals(marked('season:sea_c'))
      expect(
        await marks(`update seasons set league_id = null where id = 'sea_c'`)
      ).deep.equals(marked('season:sea_c'))
      expect(
        await marks(`update seasons set name = 'Late' where id = 'sea_c'`)
      ).deep.equals(nothing)
      expect(await marks(`delete from seasons where id = 'sea_c'`)).deep.equals(
        marked('season:sea_c')
      )
    })
  })

  describe('user_links', function () {
    it('marks both users, and all four on a move', async function () {
      expect(
        await marks(
          `insert into user_links (id, user_id, related_user_id, kind)
           values ('lnk_1', ${ANN}, ${BEN}, 'guardian')`
        )
      ).deep.equals(marked(`user:${ANN}`, `user:${BEN}`))
      expect(
        await marks(`update user_links set kind = 'family' where id = 'lnk_1'`)
      ).deep.equals(marked(`user:${ANN}`, `user:${BEN}`))
      expect(
        await marks(
          `update user_links set user_id = ${CAT}, related_user_id = ${DAN} where id = 'lnk_1'`
        )
      ).deep.equals(
        marked(`user:${ANN}`, `user:${BEN}`, `user:${CAT}`, `user:${DAN}`)
      )
      expect(
        await marks(
          `update user_links set can_manage = true where id = 'lnk_1'`
        )
      ).deep.equals(nothing)
      expect(
        await marks(`delete from user_links where id = 'lnk_1'`)
      ).deep.equals(marked(`user:${CAT}`, `user:${DAN}`))
    })
  })

  describe('user_emails', function () {
    it('marks the user, and both users when an address moves', async function () {
      expect(
        await marks(
          `insert into user_emails (id, user_id, email) values ('uem_1', ${ANN}, 'ann@example.com')`
        )
      ).deep.equals(marked(`user:${ANN}`))
      expect(
        await marks(
          `update user_emails set user_id = ${BEN} where id = 'uem_1'`
        )
      ).deep.equals(marked(`user:${ANN}`, `user:${BEN}`))
      expect(
        await marks(
          `update user_emails set is_primary = true where id = 'uem_1'`
        )
      ).deep.equals(nothing)
      expect(
        await marks(`delete from user_emails where id = 'uem_1'`)
      ).deep.equals(marked(`user:${BEN}`))
    })
  })

  describe('users', function () {
    it('marks the user and the survivor on a merge and on undoing it', async function () {
      expect(
        await marks(`update users set merged_into = ${ANN} where id = ${DAN}`)
      ).deep.equals(marked(`user:${ANN}`, `user:${DAN}`))
      expect(
        await marks(`update users set merged_into = ${BEN} where id = ${DAN}`)
      ).deep.equals(marked(`user:${ANN}`, `user:${BEN}`, `user:${DAN}`))
      expect(
        await marks(`update users set merged_into = null where id = ${DAN}`)
      ).deep.equals(marked(`user:${BEN}`, `user:${DAN}`))
    })

    it('marks the user when they gain a way to sign in or a birth month', async function () {
      expect(
        await marks(`update users set password_hash = 'x' where id = ${CAT}`)
      ).deep.equals(marked(`user:${CAT}`))
      expect(
        await marks(
          `update users set birth_year = 2013, birth_month = 3 where id = ${CAT}`
        )
      ).deep.equals(marked(`user:${CAT}`))
      expect(
        await marks(`update users set birth_month = 4 where id = ${CAT}`)
      ).deep.equals(marked(`user:${CAT}`))
    })

    it('marks nothing for anything else about a user', async function () {
      expect(
        await marks(
          `update users set display_name = 'Catherine' where id = ${CAT}`
        )
      ).deep.equals(nothing)
      expect(
        await marks(
          `insert into users (id, "legacyId", display_name) values (205, 'u205', 'Eve')`
        )
      ).deep.equals(nothing)
    })
  })

  describe('leagues', function () {
    it('marks the league when its SafeSport setting changes, and only then', async function () {
      expect(
        await marks(
          `update leagues set safesport_lao = true where id = 'lea_b'`
        )
      ).deep.equals(marked('league:lea_b'))
      expect(
        await marks(`update leagues set name = 'Bee' where id = 'lea_b'`)
      ).deep.equals(nothing)
    })
  })

  describe('writers', function () {
    it('marks nothing when the writer rolls back', async function () {
      expect(
        await marks(`
          begin;
          insert into team_follows (user_id, team_id) values (${ANN}, 'tem_b');
          rollback;
        `)
      ).deep.equals(nothing)
    })

    it('holds a mark until its writer commits, so the reconciler reads what it marked', async function () {
      await sql('delete from chat_dirty')
      await sql(
        `insert into chat_dirty (scope_type, scope_id, marked_at)
         values ('team', 'tem_b', now() - interval '1 minute')`
      )
      const writer = await live().connect()
      const reader = await live().connect()
      try {
        await writer.query('begin')
        await writer.query(
          `insert into team_follows (user_id, team_id) values (${BEN}, 'tem_b')`
        )
        let taken: string[] | undefined
        const take = reader
          .query<{ id: string }>(
            `delete from chat_dirty where scope_type = 'team'
             returning scope_id as id`
          )
          .then(result => {
            taken = result.rows.map(row => row.id)
          })
        await new Promise(resolve => setTimeout(resolve, 300))
        expect(taken).equals(undefined)
        await writer.query('commit')
        await take
        expect(taken).deep.equals(['tem_b'])
        const { rows } = await reader.query<{ n: number }>(
          `select count(*)::int as n from team_follows where team_id = 'tem_b'`
        )
        expect(rows[0].n).equals(1)
      } finally {
        writer.release()
        reader.release()
      }
      await sql(`delete from team_follows`)
    })
  })

  describe('the chat tables', function () {
    const KEY = `'\\x${'00'.repeat(32)}'::bytea`

    before(async function () {
      await sql(`
        insert into chat_identities (id, user_id, identity_public_key)
          values ('cid_1', ${ANN}, ${KEY});
        insert into chat_user_keys (user_id, identity_id, generation, public_key, signature)
          values (${ANN}, 'cid_1', 1, ${KEY}, ${KEY});
        insert into chat_conversations (id, kind, scope_type, scope_id)
          values ('cnv_1', 'teamStaff', 'team', 'tem_a');
        insert into chat_conversations (id, kind) values ('cnv_dm', 'dm');
        insert into chat_epochs (conversation_id, epoch, created_by_user_id, identity_id, signature)
          values ('cnv_1', 1, ${ANN}, 'cid_1', ${KEY});
      `)
    })

    it('keeps one chat per kind and scope, scoped as its kind says', async function () {
      expect(
        await refused(
          `insert into chat_conversations (id, kind, scope_type, scope_id)
           values ('cnv_2', 'teamStaff', 'team', 'tem_a')`
        )
      ).contains('chat_conversations_scope')
      expect(
        await refused(
          `insert into chat_conversations (id, kind, scope_type, scope_id)
           values ('cnv_3', 'seasonStaff', 'team', 'tem_a')`
        )
      ).contains('chat_conversations_scope_of_kind')
      expect(
        await refused(
          `insert into chat_conversations (id, kind, scope_type, scope_id)
           values ('cnv_4', 'dm', 'team', 'tem_a')`
        )
      ).contains('chat_conversations_scope_of_kind')
      await sql(
        `insert into chat_conversations (id, kind, scope_type, scope_id)
         values ('cnv_5', 'leagueOrg', 'league', 'lea_a'),
                ('cnv_6', 'seasonAnnouncements', 'season', 'sea_a'),
                ('cnv_7', 'teamFans', 'team', 'tem_a')`
      )
    })

    it('allows one current identity per user', async function () {
      expect(
        await refused(
          `insert into chat_identities (id, user_id, identity_public_key)
           values ('cid_2', ${ANN}, ${KEY})`
        )
      ).contains('chat_identities_current')
      await sql(
        `insert into chat_identities (id, user_id, identity_public_key, replaced_at)
         values ('cid_0', ${ANN}, ${KEY}, now())`
      )
    })

    it('chains an epoch to the one before unless the chain broke', async function () {
      const epoch = (n: number, box: string, broke: boolean): string =>
        `insert into chat_epochs (conversation_id, epoch, created_by_user_id,
           identity_id, previous_key_box, chain_break, signature)
         values ('cnv_1', ${n}, ${ANN}, 'cid_1', ${box}, ${String(broke)}, ${KEY})`
      expect(await refused(epoch(2, 'null', false))).contains(
        'chat_epochs_chain'
      )
      expect(await refused(epoch(2, KEY, true))).contains('chat_epochs_chain')
      expect(
        await refused(
          `insert into chat_epochs (conversation_id, epoch, created_by_user_id, identity_id, previous_key_box, signature)
           values ('cnv_1', 2, ${BEN}, 'cid_1', ${KEY}, ${KEY})`
        )
      ).contains('foreign key')
      await sql(epoch(2, KEY, false))
      await sql(epoch(3, 'null', true))
      expect(await refused(epoch(3, KEY, false))).contains('chat_epochs_pkey')
    })

    it('takes only client message ids, and targets only on deletes', async function () {
      const message = (
        id: string,
        seq: number,
        kind: string,
        targets: string
      ): string =>
        `insert into chat_messages (id, conversation_id, seq, epoch, sender_user_id,
           sender_identity_id, kind, target_ids, nonce, ciphertext, signature)
         values ('${id}', 'cnv_1', ${seq}, 1, ${ANN}, 'cid_1', '${kind}', ${targets},
           ${KEY}, ${KEY}, ${KEY})`
      const id = `msg_${'a'.repeat(26)}`
      expect(await refused(message('msg_short', 1, 'post', 'null'))).contains(
        'check'
      )
      expect(await refused(message(id, 1, 'post', `array['x']`))).contains(
        'chat_messages_targets'
      )
      expect(await refused(message(id, 1, 'delete', 'null'))).contains(
        'chat_messages_targets'
      )
      await sql(message(id, 1, 'post', 'null'))
      expect(
        await refused(message(`msg_${'b'.repeat(26)}`, 1, 'post', 'null'))
      ).contains('chat_messages_conversation_id_seq_key')
      await sql(message(`msg_${'c'.repeat(26)}`, 2, 'delete', `array['${id}']`))
    })
  })

  describe('down and up again', function () {
    it('rolls back to exactly what 051 left, and applies again', async function () {
      const upgraded = await schemaSnapshot(live())
      expect(
        upgraded.triggers.filter(line => line.includes('chat_dirty'))
      ).to.have.length(21)
      expect(await migrateDown(live(), through052, 1)).deep.equals([
        migration052Chat.name
      ])
      const down = await schemaSnapshot(live())
      expect(down.columns.filter(line => line.startsWith('chat_'))).deep.equals(
        []
      )
      expect(down.triggers.filter(line => line.includes('chat_'))).deep.equals(
        []
      )
      expect(down.functions.filter(line => line.includes('chat_'))).deep.equals(
        []
      )

      const scratch = `${name}_fresh`
      await admin!.query(`create database ${scratch}`)
      const fresh = new Pool({
        connectionString: adminUrl.replace(/\/[^/]*$/, `/${scratch}`)
      })
      try {
        await migrateUp(fresh, before052)
        expect(down).deep.equals(await schemaSnapshot(fresh))
      } finally {
        await fresh.end()
        await dropScratchDatabase(admin!, scratch)
      }

      await sql(`delete from teams where id = 'tem_b'`)
      expect(
        await migrateUp(live(), through052).then(result => result.applied)
      ).deep.equals([migration052Chat.name])
      expect(await schemaSnapshot(live())).deep.equals(upgraded)
      expect(await dirty()).deep.equals([
        'league:lea_a',
        'league:lea_b',
        'season:sea_a',
        'season:sea_b',
        'team:tem_a'
      ])
    })
  })
})
