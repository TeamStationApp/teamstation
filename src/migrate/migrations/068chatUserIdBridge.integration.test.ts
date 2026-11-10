import { expect } from 'chai'
import { describe, it } from 'mocha'
import { Pool } from 'pg'

import { chatUserIdBootstrap } from '../chatUserIdBootstrap'
import { chatIdInventorySql } from '../chatUserIdBridge'
import { migrateUp } from '../runner'
import { dropScratchDatabase, testDatabaseUrl } from '../testDatabase'
import { migration068ChatUserIdBridge } from './068chatUserIdBridge'
import { migrations } from './index'

async function scratch(
  label: string,
  run: (pool: Pool) => Promise<void>
): Promise<void> {
  const name = `teamstation_chat_bridge_${label}_${process.pid}_${Date.now()}`
  const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 })
  let pool: Pool | undefined
  try {
    await admin.query(`create database "${name}"`)
    pool = new Pool({
      connectionString: testDatabaseUrl.replace(/\/[^/]*$/, `/${name}`),
      max: 1
    })
    await run(pool)
  } finally {
    await pool?.end()
    await dropScratchDatabase(admin, name)
    await admin.end()
  }
}

async function fails(run: Promise<unknown>, words: string): Promise<void> {
  let error: unknown
  try {
    await run
  } catch (caught) {
    error = caught
  }
  expect(String(error)).includes(words)
}

describe('bounded chat account cutover dependencies', function () {
  this.timeout(120000)
  for (const type of ['bigint', 'text'])
    it(`bootstraps old named chat DDL against exactly ${type} identities`, async () => {
      await scratch(type, async pool => {
        await pool.query(`create table users(id ${type} primary key)`)
        await pool.query(
          chatUserIdBootstrap(
            `create table fixture_owner(user_id __chat_user_id_type__ references users(id));`
          )
        )
        expect(
          (
            await pool.query(`select format_type(atttypid,atttypmod) as type from pg_attribute
          where attrelid='fixture_owner'::regclass and attname='user_id'`)
          ).rows
        ).deep.equals([{ type }])
      })
    })

  it('refuses unknown bootstrap column types instead of coercing identity data', async () => {
    await scratch('uuid', async pool => {
      await pool.query('create table users(id uuid primary key)')
      await fails(
        pool.query(chatUserIdBootstrap('select 1;')),
        'Unsupported account identity column type'
      )
    })
  })

  it('normalizes only redundant grouping of fixed literal-free DISTINCT disjunctions', async () => {
    await scratch('condition', async pool => {
      const before =
        'CREATE TRIGGER fixed AFTER UPDATE ON public.users FOR EACH ROW WHEN (((old.id IS DISTINCT FROM new.id) OR (old.merged_into IS DISTINCT FROM new.merged_into))) EXECUTE FUNCTION fixed()'
      const after =
        'CREATE TRIGGER fixed AFTER UPDATE ON public.users FOR EACH ROW WHEN ((old.id IS DISTINCT FROM new.id OR old.merged_into IS DISTINCT FROM new.merged_into)) EXECUTE FUNCTION fixed()'
      await pool.query(chatIdInventorySql)
      const row = (
        await pool.query(
          `select pg_temp.chat_id_trigger_definition($1) as before,
        pg_temp.chat_id_trigger_definition($2) as after`,
          [before, after]
        )
      ).rows[0]
      expect(row.after).equals(row.before)
      for (const changed of [
        before.replace(' OR ', ' AND '),
        before.replace(
          'old.id IS DISTINCT FROM new.id',
          "old.id IS DISTINCT FROM '('"
        ),
        'CREATE TRIGGER fixed FOR EACH ROW WHEN (old.id IS DISTINCT FROM new.id)'
      ]) {
        await pool.query(chatIdInventorySql)
        await fails(
          pool.query('select pg_temp.chat_id_trigger_definition($1)', [
            changed
          ]),
          'Unexpected identity trigger condition'
        )
      }
    })
  })

  it('validates the actual WHEN and UPDATE OF contracts before removing any trigger', async () => {
    await scratch('definition', async pool => {
      await migrateUp(
        pool,
        migrations.filter(m => m.name < '068')
      )
      await pool.query(`drop trigger users_login_enabled on users;
        create trigger users_login_enabled before insert or update of login_enabled on users
        for each row execute function users_login_enabled();`)
      await fails(
        migrateUp(pool, [migration068ChatUserIdBridge]),
        'Unexpected chat identity trigger: users_login_enabled'
      )
      expect(
        (
          await pool.query(
            "select to_regclass('chat_user_id_bridge_triggers') as bridge"
          )
        ).rows[0].bridge
      ).equals(null)
      expect(
        (
          await pool.query(
            `select count(*)::int as n from pg_constraint where conname='chat_user_keys_identity_id_user_id_fkey'`
          )
        ).rows[0].n
      ).equals(1)
    })
  })

  it('refuses a changed composite ownership contract before dropping it', async () => {
    await scratch('ownership', async pool => {
      await migrateUp(
        pool,
        migrations.filter(m => m.name < '068')
      )
      await pool.query(`alter table chat_user_keys drop constraint chat_user_keys_identity_id_user_id_fkey;
        alter table chat_user_keys add constraint chat_user_keys_identity_id_user_id_fkey
          foreign key(identity_id,user_id) references chat_identities(id,user_id) on delete restrict;`)
      await fails(
        migrateUp(pool, [migration068ChatUserIdBridge]),
        'Unexpected chat identity constraint'
      )
      expect(
        (
          await pool.query(
            `select count(*)::int as n from pg_trigger where tgname='users_login_enabled'`
          )
        ).rows[0].n
      ).equals(1)
    })
  })
})
