import { expect } from 'chai'
import { describe, it } from 'mocha'
import { Pool } from 'pg'

import { decodeContent } from '../../common/chatContent'
import { utf8 } from '../../common/chatCrypto/bytes'
import {
  sealPreviousPukKeys,
  signEpoch,
  signPuk
} from '../../common/chatCrypto/chain'
import {
  deriveKeyPair,
  epochAad,
  hpkeSeal,
  pukAad
} from '../../common/chatCrypto/hpke'
import { signingPublicKey } from '../../common/chatCrypto/keys'
import { GENESIS_HASH, logRowHash } from '../../common/chatCrypto/logHash'
import {
  messageKey,
  openMessage,
  sealMessage
} from '../../common/chatCrypto/seal'
import { fromHex, FROZEN, seed, toHex } from '../../common/chatCrypto/vectors'
import { userIdOfGumbo, userIdOfValue } from '../../common/userId'
import {
  CHAT_ID_KEYS,
  CHAT_ID_TRIGGERS,
  chatIdInventorySql
} from '../chatUserIdBridge'
import { migrateUp } from '../runner'
import { schemaSnapshot } from '../schemaSnapshot'
import { dropScratchDatabase, testDatabaseUrl } from '../testDatabase'
import { migration068ChatUserIdBridge } from './068chatUserIdBridge'
import { migration069UserIds } from './069userIds'
import { migration075ChatCanonicalUserIds } from './075chatCanonicalUserIds'
import { migrations } from './index'

const chatNames = new Set([
  '050teamFollows',
  '051guardiansAndAccounts',
  '052chat',
  '053chatPreferences',
  '057chatMasterCompatibility',
  '068chatUserIdBridge',
  '075chatCanonicalUserIds',
  '087loginOffOnly',
  '088chatDirtyQueue',
  '099ChatLinkDecisions'
])

async function scratch(
  label: string,
  run: (pool: Pool) => Promise<void>
): Promise<void> {
  const name = `teamstation_chat_ids_${label}_${process.pid}_${Date.now()}`
  const admin = new Pool({ connectionString: testDatabaseUrl, max: 1 })
  let pool: Pool | undefined
  try {
    const { rows } = await admin.query('show server_version_num')
    expect(Number(rows[0].server_version_num)).at.least(180000)
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

const member = userIdOfGumbo(42)
const peer = userIdOfGumbo(7)
const third = userIdOfGumbo(9)
const identity = seed('identity')
const identityKey = signingPublicKey(identity)
const epochKey = seed('epoch key')
const nonce = seed('nonce').subarray(0, 24)
const fields = {
  conversationId: 'cnv_c1',
  epoch: 7,
  messageId: 'msg_aaaaaaaaaaaaaaaaaaaaaaaaaa',
  senderUserId: member,
  kind: 'post' as const
}
const plaintext =
  '{"type":"text","body":"hi 🎉","mentions":[],"attachments":[]}'

/** Real legacy-compatible cryptographic bytes, plus all six indirect ownership FKs. */
async function history(pool: Pool): Promise<void> {
  const text = (
    await pool.query<{
      canonical: boolean
    }>(`select atttypid='text'::regtype as canonical from pg_attribute
    where attrelid='users'::regclass and attname='id'`)
  ).rows[0].canonical
  const ids = text ? [member, peer, third] : [42, 7, 9]
  for (const [index, name] of [
    'Hank Aaron',
    'Babe Ruth',
    'Willie Mays'
  ].entries())
    await pool.query(
      `insert into users(id,"legacyId",display_name,password_hash) values($1,$2,$3,'fixture hash')`,
      [
        ids[index],
        [
          'usr_AAAAAAAAAAAAAAAA',
          'usr_BBBBBBBBBBBBBBBB',
          'usr_CCCCCCCCCCCCCCCC'
        ][index],
        name
      ]
    )
  await pool.query(`insert into leagues(id,name) values('lea_ids','Test League');
    insert into seasons(id,league_id,name,year,starts_on,ends_on) values('sea_ids','lea_ids','Test Season',2027,'2027-03-01','2027-05-31');
    insert into teams(id,name,league_id) values('tem_ids','Test Team','lea_ids'),('tem_other','Other Team','lea_ids');
    insert into season_teams(season_id,team_id) values('sea_ids','tem_ids');`)
  await pool.query(
    `insert into memberships(id,user_id,team_id,is_player) values('mem_ids',$1,'tem_ids',true);
    `,
    [ids[0]]
  )
  await pool.query(
    `insert into scope_roles(id,user_id,scope_type,scope_id,role) values('rol_ids',$1,'team','tem_ids','coach')`,
    [ids[0]]
  )
  await pool.query(
    `insert into season_members(id,user_id,season_id) values('sem_ids',$1,'sea_ids')`,
    [ids[0]]
  )
  await pool.query(
    `insert into league_members(id,user_id,league_id) values('lem_ids',$1,'lea_ids')`,
    [ids[0]]
  )
  await pool.query(
    `insert into user_links(id,user_id,related_user_id,kind) values('lnk_ids',$1,$2,'guardian')`,
    [ids[1], ids[0]]
  )
  await pool.query(
    `insert into user_emails(id,user_id,email,is_primary,source) values('eml_ids',$1,'fixture@example.test',true,'manual')`,
    [ids[0]]
  )
  await pool.query(
    `insert into follows(user_id,group_type,group_id) values($1,'team','tem_ids')`,
    [ids[0]]
  )
  const puk = deriveKeyPair(seed('recipient'))
  const device = deriveKeyPair(seed('fixture device'))
  await pool.query(
    `insert into chat_devices(id,user_id,name,platform,box_public_key,sign_public_key)
    values('cdv_ids',$1,'Test Device','web',$2,$3)`,
    [ids[0], device.publicKey, identityKey]
  )
  await pool.query(
    `insert into chat_identities(id,user_id,identity_public_key) values('cid_1',$1,$2)`,
    [ids[0], identityKey]
  )
  const previous = sealPreviousPukKeys({
    userId: member,
    identityId: 'cid_1',
    generation: 3,
    privateKey: puk.secretKey,
    older: [{ generation: 1, privateKey: seed('older key') }],
    nonce
  })
  await pool.query(
    `insert into chat_user_keys(user_id,identity_id,generation,public_key,signature,previous_keys_box)
    values($1,'cid_1',3,$2,$3,$4)`,
    [
      ids[0],
      puk.publicKey,
      signPuk(
        { userId: member, generation: 3, publicKey: puk.publicKey },
        identity
      ),
      previous
    ]
  )
  const deviceBox = hpkeSeal(
    'puk',
    device.publicKey,
    pukAad({
      userId: member,
      identityId: 'cid_1',
      generation: 3,
      deviceId: 'cdv_ids'
    }),
    puk.secretKey,
    seed('ephemeral')
  )
  await pool.query(
    `insert into chat_user_key_boxes(user_id,identity_id,generation,device_id,box) values($1,'cid_1',3,'cdv_ids',$2)`,
    [ids[0], deviceBox]
  )
  await pool.query(
    `insert into chat_conversations(id,kind,created_by,last_seq,last_log_seq) values('cnv_c1','dm',$1,1,1)`,
    [ids[0]]
  )
  for (const id of ids.slice(0, 2))
    await pool.query(
      `insert into chat_members(conversation_id,user_id) values('cnv_c1',$1)`,
      [id]
    )
  await pool.query(
    `insert into chat_membership_log(conversation_id,seq,event,user_id,prev_hash,hash,at)
    values('cnv_c1',1,'join',$1,$2,$3,to_timestamp(1790000000))`,
    [
      ids[0],
      GENESIS_HASH,
      logRowHash(GENESIS_HASH, {
        conversationId: 'cnv_c1',
        seq: 1,
        event: 'join',
        userId: member,
        actorUserId: null,
        reason: null,
        at: 1790000000000
      })
    ]
  )
  await pool.query(
    `insert into chat_epochs(conversation_id,epoch,created_by_user_id,identity_id,chain_break,signature)
    values('cnv_c1',7,$1,'cid_1',true,$2)`,
    [
      ids[0],
      signEpoch(
        { conversationId: 'cnv_c1', epoch: 7, previousKeyBox: null },
        identity
      )
    ]
  )
  const box = hpkeSeal(
    'epoch',
    puk.publicKey,
    epochAad({
      conversationId: 'cnv_c1',
      epoch: 7,
      recipientUserId: member,
      identityId: 'cid_1',
      generation: 3
    }),
    epochKey,
    seed('ephemeral')
  )
  await pool.query(
    `insert into chat_epoch_boxes(conversation_id,epoch,user_id,identity_id,generation,box)
    values('cnv_c1',7,$1,'cid_1',3,$2)`,
    [ids[0], box]
  )
  await pool.query(
    `insert into chat_grant_requests(conversation_id,user_id,identity_id,generation)
    values('cnv_c1',$1,'cid_1',3)`,
    [ids[0]]
  )
  const sealed = sealMessage({
    ...fields,
    epochKey,
    plaintext: utf8(plaintext),
    identitySecretKey: identity,
    nonce
  })
  expect(toHex(sealed.signature)).equals(FROZEN.sealSignature)
  await pool.query(
    `insert into chat_messages(id,conversation_id,seq,epoch,sender_user_id,sender_identity_id,kind,nonce,ciphertext,signature)
    values($1,'cnv_c1',1,7,$2,'cid_1','post',$3,$4,$5)`,
    [
      fields.messageId,
      ids[0],
      sealed.nonce,
      sealed.ciphertext,
      sealed.signature
    ]
  )
  await pool.query(
    `insert into chat_attachments(id,conversation_id,uploader_user_id,size,object_key,digest)
    values('cat_ids','cnv_c1',$1,16,'fixture-object',$2)`,
    [ids[0], fromHex(FROZEN.streamSmallDigest)]
  )
  await pool.query(
    `insert into chat_read_cursors(conversation_id,user_id,seq) values('cnv_c1',$1,1)`,
    [ids[0]]
  )
  await pool.query(
    `insert into chat_reports(id,conversation_id,message_id,reporter_user_id,envelope,message_key,plaintext,verified)
    values('crp_ids','cnv_c1',$1,$2,$3,$4,$5,true)`,
    [
      fields.messageId,
      ids[1],
      JSON.stringify({ ...fields, senderUserId: 42 }),
      messageKey(epochKey, 'cnv_c1', fields.messageId),
      plaintext
    ]
  )
  await pool.query(
    `insert into chat_conversation_preferences(user_id,conversation_id,pinned,muted,manual_unread)
    values($1,'cnv_c1',true,true,true)`,
    [ids[0]]
  )
  await pool.query(
    `insert into chat_message_pins(user_id,conversation_id,message_id) values($1,'cnv_c1',$2)`,
    [ids[0], fields.messageId]
  )
}

async function opaque(pool: Pool): Promise<unknown> {
  const columns = [
    ['chat_devices', 'box_public_key,sign_public_key'],
    ['chat_identities', 'identity_public_key'],
    ['chat_user_keys', 'public_key,signature,previous_keys_box'],
    ['chat_user_key_boxes', 'box'],
    ['chat_membership_log', 'prev_hash,hash,at'],
    ['chat_epochs', 'previous_key_box,signature'],
    ['chat_epoch_boxes', 'box'],
    ['chat_messages', 'nonce,ciphertext,signature'],
    ['chat_attachments', 'digest'],
    ['chat_reports', 'envelope,message_key,plaintext,verified']
  ]
  const result: Record<string, unknown> = {}
  for (const [table, fields] of columns)
    result[table] = (await pool.query(`select ${fields} from ${table}`)).rows
  return result
}

async function triggerState(
  pool: Pool
): Promise<Array<{ name: string; definition: string; enabled: string }>> {
  return (
    await pool.query(
      `select tgname as name,pg_get_triggerdef(oid) as definition,tgenabled as enabled
    from pg_trigger where tgname=any($1::text[]) order by tgname`,
      [CHAT_ID_TRIGGERS.map(t => t.name)]
    )
  ).rows
}

async function finalSchema(pool: Pool): Promise<unknown> {
  // pg-pool retires a client after an intentionally failed FK assertion.
  // Recreate only session-local comparison helpers on the replacement client.
  await pool.query(chatIdInventorySql)
  const schema = await schemaSnapshot(pool)
  const names = new Set(CHAT_ID_TRIGGERS.map(t => t.name))
  schema.triggers = await Promise.all(
    schema.triggers.map(async definition => {
      const name = definition.split(
        ' '
      )[2] as (typeof CHAT_ID_TRIGGERS)[number]['name']
      return names.has(name)
        ? (
            await pool.query(
              'select pg_temp.chat_id_trigger_definition($1) as definition',
              [definition]
            )
          ).rows[0].definition
        : definition
    })
  )
  return schema
}

async function assertFinal(pool: Pool): Promise<void> {
  expect(
    (
      await pool.query(`select to_regclass('chat_user_id_bridge_triggers') as bridge,
    to_regprocedure('refresh_login_enabled(bigint)') as old_refresh,
    to_regprocedure('login_enabled_for(bigint,text,bigint)') as old_login`)
    ).rows[0]
  ).deep.equals({ bridge: null, old_refresh: null, old_login: null })
  expect(
    (
      await pool.query(
        `select count(*)::int as n from pg_constraint where conname like 'chat_id_bridge_%'`
      )
    ).rows[0].n
  ).equals(0)
  for (const key of CHAT_ID_KEYS) {
    expect(
      (
        await pool.query(
          `select pg_get_constraintdef(oid) as definition from pg_constraint
      where conrelid=$1::regclass and conname=$2`,
          [key.table_name, key.name]
        )
      ).rows
    ).deep.equals([{ definition: key.definition }])
  }
  const row = (await pool.query('select * from chat_messages')).rows[0]
  if (row != null) {
    expect(
      decodeContent(
        openMessage({
          ...fields,
          nonce: row.nonce,
          ciphertext: row.ciphertext,
          signature: row.signature,
          epochKey,
          senderIdentityKey: identityKey
        })
      )
    ).deep.equals({
      type: 'text',
      body: 'hi 🎉',
      mentions: [],
      attachments: []
    })
    expect(row.sender_user_id).equals(member)
    expect(
      (await pool.query('select user_id from chat_message_pins')).rows
    ).deep.equals([{ user_id: member }])
    expect(
      (await pool.query('select user_id from chat_conversation_preferences'))
        .rows
    ).deep.equals([{ user_id: member }])
  }
}

async function sameTriggers(
  pool: Pool,
  before: Awaited<ReturnType<typeof triggerState>>
): Promise<void> {
  const after = await triggerState(pool)
  expect(after.map(({ name, enabled }) => ({ name, enabled }))).deep.equals(
    before.map(({ name, enabled }) => ({ name, enabled }))
  )
  for (let i = 0; i < before.length; i++) {
    const normalized = await pool.query(
      `select pg_temp.chat_id_trigger_definition($1) as before,
      pg_temp.chat_id_trigger_definition($2) as after`,
      [before[i].definition, after[i].definition]
    )
    expect(normalized.rows[0].after, before[i].name).equals(
      normalized.rows[0].before
    )
  }
}

/** Changing and unchanged writes exercise every restored condition and both follow directions. */
async function triggerEffects(pool: Pool): Promise<void> {
  const change = async (
    sql: string,
    args: unknown[],
    expected: string[]
  ): Promise<void> => {
    await pool.query('delete from chat_dirty')
    await pool.query(sql, args)
    const actual = (
      await pool.query(
        // The queue appends a mark per write (088); a scope is read once.
        `select distinct scope_type||':'||scope_id as mark from chat_dirty order by 1`
      )
    ).rows.map(row => row.mark)
    expect(actual, sql).deep.equals([...expected].sort())
  }
  const users = [`user:${member}`, `user:${third}`]
  const updates: Array<[string, unknown[], string[]]> = [
    [
      `update memberships set user_id=$1 where id='mem_ids'`,
      [third],
      ['team:tem_ids', ...users]
    ],
    [
      `update scope_roles set user_id=$1 where id='rol_ids'`,
      [third],
      ['team:tem_ids', ...users]
    ],
    [
      `update season_members set user_id=$1 where id='sem_ids'`,
      [third],
      ['season:sea_ids']
    ],
    [
      `update league_members set user_id=$1 where id='lem_ids'`,
      [third],
      ['league:lea_ids']
    ],
    [
      `update user_links set user_id=$1 where id='lnk_ids'`,
      [third],
      [`user:${peer}`, ...users]
    ],
    [`update user_emails set user_id=$1 where id='eml_ids'`, [third], users],
    [
      `update users set merged_into=$1 where id=$2`,
      [third, peer],
      [`user:${peer}`, `user:${third}`]
    ],
    [
      `update follows set user_id=$1,group_id='tem_other' where user_id=$2 and group_type='team' and group_id='tem_ids'`,
      [third, member],
      ['team:tem_ids', 'team:tem_other', ...users]
    ]
  ]
  for (const [sql, args, marks] of updates) {
    await change(sql, args, marks)
    // An UPDATE statement with the same values must have no dirty or mirror effects.
    const unchanged = sql.startsWith('update follows')
      ? ([
          `update follows set user_id=$1,group_id='tem_other' where user_id=$1 and group_type='team' and group_id='tem_other'`,
          [third]
        ] as const)
      : ([sql, args] as const)
    await change(unchanged[0], [...unchanged[1]], [])
  }
  expect(
    (await pool.query('select user_id,team_id from team_follows')).rows
  ).deep.equals([{ user_id: third, team_id: 'tem_other' }])
  await change(
    `update team_follows set team_id='tem_ids' where user_id=$1 and team_id='tem_other'`,
    [third],
    ['team:tem_ids', 'team:tem_other', `user:${third}`]
  )
  await change(
    `update team_follows set team_id='tem_ids' where user_id=$1 and team_id='tem_ids'`,
    [third],
    []
  )
  expect(
    (
      await pool.query(
        `select user_id,group_id from follows where group_type='team'`
      )
    ).rows
  ).deep.equals([{ user_id: third, group_id: 'tem_ids' }])
}

/** Both UPDATE OF-only triggers must call text helpers after a committed 069. */
async function accountEffects(pool: Pool): Promise<void> {
  const a = userIdOfValue((1n << 127n) + 17n)
  const b = userIdOfValue((1n << 127n) + 18n)
  await pool.query(
    `insert into users(id,display_name,login_enabled) values($1,'Jackie Robinson',true),($2,'Roberto Clemente',true)`,
    [a, b]
  )
  const enabled = async (): Promise<boolean[]> =>
    (
      await pool.query(
        `select login_enabled from users where id=any($1::text[]) order by display_name`,
        [[a, b]]
      )
    ).rows.map(row => row.login_enabled)
  // Switched on before any way in, as an account settles (087).
  expect(await enabled()).deep.equals([true, true])
  await pool.query(
    `update users set password_hash='fixture hash' where id=$1`,
    [a]
  )
  expect(await enabled()).deep.equals([true, true])
  await pool.query(`update users set password_hash=null where id=$1`, [a])
  expect(await enabled()).deep.equals([false, true])
  await pool.query(
    `insert into user_emails(id,user_id,email,is_primary,source) values('eml_high',$1,'new@example.test',true,'manual')`,
    [a]
  )
  // An address never switches an account on.
  expect(await enabled()).deep.equals([false, true])
  await pool.query(`update users set login_enabled=true where id=$1`, [a])
  expect(await enabled()).deep.equals([true, true])
  await pool.query(`update user_emails set user_id=$1 where id='eml_high'`, [b])
  expect(await enabled()).deep.equals([false, true])
  await pool.query(`delete from user_emails where id='eml_high'`)
  expect(await enabled()).deep.equals([false, false])
  await pool.query(
    `update users set password_hash='fixture hash',disabled_at=now(),deleted_at=now() where id=$1`,
    [a]
  )
  expect(
    (
      await pool.query(
        `select login_enabled,disabled_at is not null as disabled,deleted_at is not null as deleted from users where id=$1`,
        [a]
      )
    ).rows
  ).deep.equals([{ login_enabled: false, disabled: true, deleted: true }])
  await fails(
    pool.query(`update users set disabled_at=null where id=$1`, [a]),
    'users_deleted_stays_disabled'
  )
  await pool.query(`update users set merged_into=$1 where id=$2`, [b, a])
  expect(await enabled()).deep.equals([false, false])
  expect(
    (
      await pool.query(
        `select count(*)::int as n from gumbo_ids where user_id=any($1::text[])`,
        [[a, b]]
      )
    ).rows[0].n
  ).equals(0)
}

describe('chat canonical identity database integration', function () {
  this.timeout(120000)
  let expectedSchema: unknown

  it('upgrades installed numeric chat without losing its identity constraints', async () => {
    await scratch('legacy', async pool => {
      await migrateUp(
        pool,
        migrations.filter(m => m.name < '068')
      )
      await history(pool)
      const before = await opaque(pool)
      const triggers = await triggerState(pool)
      await migrateUp(pool, migrations)
      const { rows } =
        await pool.query(`select data_type from information_schema.columns
        where table_name='chat_user_keys' and column_name='user_id'`)
      expect(rows).deep.equals([{ data_type: 'text' }])
      expect(await opaque(pool)).deep.equals(before)
      await sameTriggers(pool, triggers)
      await assertFinal(pool)
      await fails(
        pool.query(
          `insert into chat_user_keys(user_id,identity_id,generation,public_key,signature)
        select $1,identity_id,4,public_key,signature from chat_user_keys where user_id=$2`,
          [peer, member]
        ),
        'chat_user_keys_identity_id_user_id_fkey'
      )
      expectedSchema = await finalSchema(pool)
      await triggerEffects(pool)
      await accountEffects(pool)
    })
  })

  it('installs chat over current master already through canonical IDs and sync migrations', async () => {
    await scratch('master', async pool => {
      await migrateUp(
        pool,
        migrations.filter(m => !chatNames.has(m.name))
      )
      await migrateUp(pool, migrations)
      const { rows } =
        await pool.query(`select data_type from information_schema.columns
        where table_name='chat_user_keys' and column_name='user_id'`)
      expect(rows).deep.equals([{ data_type: 'text' }])
      await history(pool)
      await assertFinal(pool)
      expect(await finalSchema(pool)).deep.equals(expectedSchema)
      await triggerEffects(pool)
      await accountEffects(pool)
    })
  })

  it('builds an empty database to the same canonical schema and functioning triggers', async () => {
    await scratch('empty', async pool => {
      await migrateUp(pool, migrations)
      expect(await finalSchema(pool)).deep.equals(expectedSchema)
      await history(pool)
      await assertFinal(pool)
      await triggerEffects(pool)
      await accountEffects(pool)
    })
  })

  it('resumes a committed pre069 bridge and retries an entirely rolled-back finalizer', async () => {
    await scratch('retry', async pool => {
      await migrateUp(
        pool,
        migrations.filter(m => m.name < '068')
      )
      await history(pool)
      const before = await opaque(pool)
      const triggers = await triggerState(pool)
      await migrateUp(pool, [migration068ChatUserIdBridge])
      expect(
        (
          await pool.query(
            'select count(*)::int as n from chat_user_id_bridge_triggers'
          )
        ).rows[0].n
      ).equals(12)
      expect(await triggerState(pool)).length(0)
      await migrateUp(
        pool,
        migrations.filter(m => m.name < '075')
      )
      await fails(
        migrateUp(pool, [
          {
            ...migration075ChatCanonicalUserIds,
            up:
              migration075ChatCanonicalUserIds.up +
              `do $fail$ begin raise exception 'Injected finalizer rollback'; end $fail$;`
          }
        ]),
        'Injected finalizer rollback'
      )
      expect(await opaque(pool)).deep.equals(before)
      expect(
        (
          await pool.query(
            'select count(*)::int as n from chat_user_id_bridge_triggers'
          )
        ).rows[0].n
      ).equals(12)
      expect(await triggerState(pool)).length(0)
      await migrateUp(pool, migrations)
      expect(await opaque(pool)).deep.equals(before)
      await sameTriggers(pool, triggers)
      await assertFinal(pool)
      expect(await finalSchema(pool)).deep.equals(expectedSchema)
      await triggerEffects(pool)
      await accountEffects(pool)
    })
  })

  it('preserves disabled, replica and always trigger modes through restoration', async () => {
    await scratch('modes', async pool => {
      await migrateUp(
        pool,
        migrations.filter(m => m.name < '068')
      )
      for (const [index, trigger] of CHAT_ID_TRIGGERS.entries())
        await pool.query(
          `alter table ${trigger.table_name} ${['enable', 'disable', 'enable replica', 'enable always'][index % 4]} trigger ${trigger.name}`
        )
      const before = await triggerState(pool)
      await migrateUp(pool, migrations)
      await sameTriggers(pool, before)
      await assertFinal(pool)
    })
  })

  it('upgrades previously replayed catalog trigger definitions without changing their conditions', async () => {
    await scratch('replayed', async pool => {
      await migrateUp(
        pool,
        migrations.filter(m => m.name < '068')
      )
      const before = await triggerState(pool)
      // A schema dump restores these exact CREATE TRIGGER statements. PostgreSQL
      // flattens redundant DISTINCT/OR grouping while parsing them again.
      for (const trigger of CHAT_ID_TRIGGERS) {
        const saved = before.find(row => row.name === trigger.name)!
        await pool.query(
          `drop trigger ${trigger.name} on ${trigger.table_name}`
        )
        await pool.query(saved.definition)
      }
      expect((await triggerState(pool))[0].definition).not.equals(
        before[0].definition
      )
      await migrateUp(pool, migrations)
      await sameTriggers(pool, before)
      await assertFinal(pool)
    })
  })

  it('refuses an unexpected column-dependent trigger and rolls back the entire bridge', async () => {
    await scratch('blocker', async pool => {
      await migrateUp(
        pool,
        migrations.filter(m => m.name < '068')
      )
      await pool.query(`create trigger fixture_identity_blocker before update of id on users
        for each row execute function users_login_enabled()`)
      const before = await triggerState(pool)
      await fails(
        migrateUp(pool, [migration068ChatUserIdBridge]),
        'Unexpected identity-dependent trigger'
      )
      expect(await triggerState(pool)).deep.equals(before)
      expect(
        (
          await pool.query(
            "select to_regclass('chat_user_id_bridge_triggers') as bridge"
          )
        ).rows[0].bridge
      ).equals(null)
      await pool.query('drop trigger fixture_identity_blocker on users')
      await migrateUp(pool, migrations)
      await assertFinal(pool)
    })
  })

  it('proves the shipped069 still fails without the composite-key bridge after the trigger blockers are removed', async () => {
    await scratch('unbridged', async pool => {
      await migrateUp(
        pool,
        migrations.filter(
          m => m.name < '069' && m.name !== '068chatUserIdBridge'
        )
      )
      for (const trigger of CHAT_ID_TRIGGERS)
        await pool.query(
          `drop trigger ${trigger.name} on ${trigger.table_name}`
        )
      await fails(
        migrateUp(pool, [migration069UserIds]),
        'cannot be implemented'
      )
      expect(
        (
          await pool.query(
            `select atttypid='bigint'::regtype as numeric from pg_attribute where attrelid='users'::regclass and attname='id'`
          )
        ).rows[0].numeric
      ).equals(true)
    })
  })
})
