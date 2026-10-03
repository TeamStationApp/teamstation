import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { ChatEngine } from '../../app/chat/engine/engine'
import type { ChatKeyRecord, ChatKeyStore } from '../../app/chat/keyRecord'
import { TeamStationClient } from '../../common/api'
import { type ChatFixture, openChatFixture } from './chatTestFixture'
import { pinsFor, setMessagePin, updatePreferences } from './preferences'
import { reconcileConversation } from './reconciler'

class Store implements ChatKeyStore {
  record: ChatKeyRecord | undefined
  async load(): Promise<ChatKeyRecord | undefined> {
    return this.record
  }

  async save(record: ChatKeyRecord): Promise<void> {
    this.record = record
  }

  async wipe(): Promise<void> {
    this.record = undefined
  }

  async exists(): Promise<boolean> {
    return this.record != null
  }
}
function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void
  const promise = new Promise<void>(_resolve => {
    resolve = _resolve
  })
  return { promise, resolve }
}

describe('chat metadata transaction lock order', function () {
  this.timeout(30000)
  let fixture: ChatFixture
  let engine: ChatEngine
  let id: string
  const gateKey = 832471
  before(async function () {
    const opened = await openChatFixture('preferences_races')
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
    engine = new ChatEngine({
      client: new TeamStationClient({
        baseUrl: fixture.api,
        token: fixture.tokenOf('Hc')
      }),
      store: new Store(),
      userId: fixture.id('Hc'),
      device: { name: 'Test browser', platform: 'web' }
    })
    expect(await engine.start()).equals('ready')
    id = engine.conversations().find(chat => chat.kind === 'teamMembers')!.id
    await engine.open(id)
    await sql`create function test_metadata_gate() returns trigger language plpgsql as $$
      begin perform pg_advisory_xact_lock(832471); return new; end $$`.execute(
      fixture.db
    )
  })
  after(async function () {
    engine?.stop()
    await fixture?.close()
  })

  async function waitBlocked(count: number): Promise<void> {
    const deadline = Date.now() + 5000
    while (Date.now() < deadline) {
      const result = await sql<{
        count: string
      }>`select count(*)::text as count from pg_stat_activity
        where datname=current_database() and pid<>pg_backend_pid() and wait_event_type='Lock'`.execute(
        fixture.db
      )
      if (Number(result.rows[0].count) >= count) return
      await new Promise(resolve => setTimeout(resolve, 10))
    }
    throw new Error(
      'Expected real concurrent transactions to reach their locks'
    )
  }

  async function race(
    table: 'chat_message_pins' | 'chat_conversation_preferences',
    first: () => Promise<unknown>,
    second: () => Promise<unknown>
  ): Promise<Array<PromiseSettledResult<unknown>>> {
    await sql
      .raw(
        `create trigger test_metadata_gate before insert on ${table} for each row execute function test_metadata_gate()`
      )
      .execute(fixture.db)
    const armed = deferred()
    const release = deferred()
    const blocker = fixture.db.transaction().execute(async trx => {
      await sql`select pg_advisory_xact_lock(${gateKey})`.execute(trx)
      armed.resolve()
      await release.promise
    })
    await armed.promise
    let work: Array<Promise<unknown>> = []
    try {
      work = [first()]
      await waitBlocked(1)
      work.push(second())
      await waitBlocked(2)
      release.resolve()
      return await Promise.allSettled(work)
    } finally {
      release.resolve()
      await blocker
      await Promise.allSettled(work)
      await sql
        .raw(`drop trigger test_metadata_gate on ${table}`)
        .execute(fixture.db)
    }
  }

  it('commits pin-first concurrent author deletion without deadlock or a remaining pin', async function () {
    const post = (await engine.sendText(id, 'Disposable race post'))!
    const results = await race(
      'chat_message_pins',
      async () =>
        await setMessagePin(fixture.db, fixture.id('N'), id, post.id, true),
      async () => {
        await engine.deleteMessage(id, post.id)
      }
    )
    expect(
      results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason.code),
      'database race errors'
    ).deep.equals([])
    expect(results.map(result => result.status)).deep.equals([
      'fulfilled',
      'fulfilled'
    ])
    expect(await pinsFor(fixture.db, fixture.id('N'), id)).deep.equals([])
    expect(
      (
        await fixture.db
          .selectFrom('chat_messages')
          .select('cleared_at')
          .where('id', '=', post.id)
          .executeTakeFirstOrThrow()
      ).cleared_at
    ).not.equals(null)
  })

  it('refuses pin-after-delete and leaves the deleted post unpinned', async function () {
    const post = (await engine.sendText(id, 'Another disposable race post'))!
    await engine.deleteMessage(id, post.id)
    const result = await Promise.allSettled([
      setMessagePin(fixture.db, fixture.id('N'), id, post.id, true)
    ])
    expect(result[0].status).equals('rejected')
    expect((result[0] as PromiseRejectedResult).reason.status).equals(404)
    expect(await pinsFor(fixture.db, fixture.id('N'), id)).deep.equals([])
  })

  it('commits first preference insert before concurrent membership reconciliation without inversion', async function () {
    const member = fixture.id('N')
    await fixture.db
      .deleteFrom('memberships')
      .where('user_id', '=', member)
      .execute()
    const results = await race(
      'chat_conversation_preferences',
      async () =>
        await updatePreferences(fixture.db, member, id, { muted: true }),
      async () => {
        await reconcileConversation(fixture.db, id, fixture.now)
      }
    )
    expect(
      results
        .filter(result => result.status === 'rejected')
        .map(result => result.reason.code),
      'database race errors'
    ).deep.equals([])
    expect(results.map(result => result.status)).deep.equals([
      'fulfilled',
      'fulfilled'
    ])
    expect(
      (
        await fixture.db
          .selectFrom('chat_members')
          .select('left_at')
          .where('conversation_id', '=', id)
          .where('user_id', '=', member)
          .executeTakeFirstOrThrow()
      ).left_at
    ).not.equals(null)
    const denied = await Promise.allSettled([
      updatePreferences(fixture.db, member, id, { muted: false })
    ])
    expect(denied[0].status).equals('rejected')
    expect((denied[0] as PromiseRejectedResult).reason.status).equals(404)
  })
})
