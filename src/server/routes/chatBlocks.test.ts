import { expect } from 'chai'
import { sql } from 'kysely'
import { after, before, describe, it } from 'mocha'

import { ChatEngine } from '../../app/chat/engine/engine'
import type { ChatKeyRecord } from '../../app/chat/keyRecord'
import { TeamStationClient } from '../../common/api'
import { HttpError } from '../../common/errors'
import { userIdOfValue } from '../../common/userId'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { closeInto } from '../admin/people'
import { PostgresFeed } from '../changeFeed/postgresFeed'
import {
  blockedSenderIds,
  blockingRecipientIds,
  blocksFor,
  lockBlockPolicy,
  setBlock
} from '../chat/blocks'
import {
  type ChatFixture,
  openChatFixture,
  TEST_MEDIA
} from '../chat/chatTestFixture'
import { mayPost } from '../chat/messages'
import { ChatFanout } from '../socket/chatFanout'

/** Real PostgreSQL and HTTP, with independently encrypted client messages. */
describe('personal chat blocking', function () {
  this.timeout(120000)
  let f: ChatFixture
  const engines: ChatEngine[] = []
  const clients: TeamStationClient[] = []
  let group: string
  let dm: string
  let original: string
  before(async function () {
    const fixture = await openChatFixture('blocks', {
      space: {
        endpoint: 'https://example.test',
        region: 'test',
        bucket: 'fixture',
        accessKeyId: 'fixture',
        secretAccessKey: 'fixture',
        pathStyle: true
      }
    })
    if (fixture == null) {
      this.skip()
      return
    }
    f = fixture
    for (const key of ['Hc', 'Hs', 'N']) {
      let record: ChatKeyRecord | undefined
      const client = new TeamStationClient({
        baseUrl: f.api,
        token: f.tokenOf(key)
      })
      clients.push(client)
      const engine = new ChatEngine({
        client,
        userId: f.id(key),
        device: { name: 'Fixture browser', platform: 'web' },
        store: {
          load: async () => record,
          save: async next => {
            record = next
          },
          wipe: async () => {
            record = undefined
          },
          exists: async () => record != null
        }
      })
      engines.push(engine)
      expect(await engine.start()).equals('ready')
    }
    group = engines[0]
      .conversations()
      .find(chat => chat.kind === 'teamMembers')!.id
    await engines[1].open(group)
    original = (await engines[1].sendText(
      group,
      'A message from the fixture peer.'
    ))!.id
    await engines[0].open(group)
    await engines[2].open(group)
    dm = (await clients[1].createDm([f.id('Hc')])).id
    await engines[1].refresh()
    await engines[1].open(dm)
    await engines[1].sendText(dm, 'An existing direct message.')
  })
  after(async () => {
    for (const engine of engines) engine.stop()
    if (f != null) await f.close()
  })
  const block = async (
    value = true
  ): ReturnType<TeamStationClient['setChatBlock']> => {
    const rows = await clients[0].setChatBlock(f.id('Hs'), value)
    // These engines have no socket transport; model the blocker's personal hint.
    await engines[0].refresh()
    await engines[0].idle()
    return rows
  }
  it('is personal, idempotent, and does not need encryption keys', async () => {
    await f.signIn('Hc-other', 'Hc')
    expect(
      (await f.call('Hc-other', 'PUT', `/chat/blocks/${f.id('Hs')}`)).status
    ).equals(200)
    expect(await block()).has.length(1)
    expect((await clients[0].chatBlocks())[0]).includes({ userId: f.id('Hs') })
    expect(await clients[1].chatBlocks()).deep.equals([])
    await block(false)
    expect(await block(false)).deep.equals([])
  })
  it('refuses self, missing and unrelated targets and machine tokens', async () => {
    expect(
      (await f.call('Hc', 'PUT', `/chat/blocks/${f.id('Hc')}`)).status
    ).equals(400)
    expect(
      (
        await f.call(
          'Hc',
          'PUT',
          `/chat/blocks/${userIdOfValue(999999999999999n)}`
        )
      ).status
    ).equals(404)
    const stranger = await f.person('stranger')
    expect(
      (await f.call('Hc', 'PUT', `/chat/blocks/${stranger}`)).status
    ).equals(404)
    expect(
      (await f.call('Hc', 'PUT', '/chat/blocks/not-a-user')).status
    ).equals(400)
    await f.apiToken('machine', 'Hc')
    expect((await f.call('machine', 'GET', '/chat/blocks')).status).equals(403)
    expect((await fetch(f.api + '/chat/blocks')).status).equals(401)
  })
  it('filters old and new ciphertext before pagination and restores it on unblock', async () => {
    await block()
    await engines[1].sendText(group, 'Still delivered to other members.')
    const third = await engines[2].sendText(
      group,
      'Visible third-party message.'
    )
    const page = await clients[0].chatMessages(group, { limit: 1 })
    expect(third).not.equals(undefined)
    expect(page.map(message => message.id)).deep.equals([third!.id])
    expect(
      await clients[0].chatMessages(group, { before: third!.seq, limit: 1 })
    ).deep.equals([])
    expect(
      (await clients[2].chatMessages(group)).some(
        message => message.id === original
      )
    ).equals(true)
    await block(false)
    expect(
      (await clients[0].chatMessages(group)).some(
        message => message.id === original
      )
    ).equals(true)
  })
  it('filters previews, unread and pins without changing team membership or roles', async () => {
    const membership = await f.db
      .selectFrom('memberships')
      .selectAll()
      .execute()
    const roles = await f.db.selectFrom('scope_roles').selectAll().execute()
    await clients[0].pinChatMessage(group, original, true)
    const newest = await engines[1].sendText(group, 'Newest peer post.')
    await block()
    const summary = (await clients[0].chatConversations()).find(
      chat => chat.id === group
    )!
    expect(summary.lastPostId).not.equals(newest!.id)
    expect(await clients[0].chatPins(group)).deep.equals([])
    expect(
      (
        await f.call(
          'Hc',
          'PUT',
          `/chat/conversations/${group}/pins/${original}`
        )
      ).status
    ).equals(404)
    expect(
      await f.db.selectFrom('memberships').selectAll().execute()
    ).deep.equals(membership)
    expect(
      await f.db.selectFrom('scope_roles').selectAll().execute()
    ).deep.equals(roles)
    await block(false)
  })
  it('rejects reused/new/group DMs and blocked sends with a generic response', async () => {
    await block()
    expect(await mayPost(f.db, dm, f.id('Hs'), f.now)).equals('reader')
    for (const people of [[f.id('Hc')], [f.id('Hc'), f.id('N')]]) {
      const answer = await f.call('Hs', 'POST', '/chat/dms', {
        userIds: people
      })
      expect(answer.status).equals(403)
      expect(JSON.stringify(answer.body).toLowerCase()).not.contains('block')
    }
    const sent = await f.call(
      'Hs',
      'POST',
      `/chat/conversations/${dm}/messages`,
      {
        id: 'msg_1111111111111111111111'
      }
    )
    // Malformed bodies remain invalid; valid encrypted sends reach the policy.
    expect(sent.status).equals(400)
    let denied = false
    try {
      await engines[1].sendText(dm, 'Must not be accepted.')
    } catch (error) {
      expect(error).instanceOf(HttpError)
      expect((error as HttpError).code).equals('forbidden')
      expect((error as HttpError).details).deep.equals({
        reason: 'recipientBlocked'
      })
      denied = true
    }
    expect(denied).equals(true)
    await engines[0].refresh()
    await engines[0].open(dm)
    await engines[0].sendText(dm, 'The blocker may still send.')
    const other = (await clients[2].createDm([f.id('Hs')])).id
    expect(
      (
        await f.call('N', 'POST', `/chat/dms/${other}/members`, {
          userIds: [f.id('Hc')]
        })
      ).status
    ).equals(403)
    await block(false)
    await engines[1].sendText(dm, 'Sending is restored.')
  })
  it('refuses attachment reads from blocked uploaders', async () => {
    await f.db
      .insertInto('chat_attachments')
      .values({
        id: 'cat_fixture_blocked',
        conversation_id: group,
        uploader_user_id: f.id('Hs'),
        size: 100,
        digest: Buffer.alloc(32),
        object_key: 'fixture/blob',
        completed_at: f.now
      })
      .execute()
    await block()
    expect(
      (await f.call('Hc', 'GET', '/chat/attachments/cat_fixture_blocked'))
        .status
    ).equals(404)
    await block(false)
    expect(
      (await f.call('Hc', 'GET', '/chat/attachments/cat_fixture_blocked'))
        .status
    ).equals(200)
  })
  it('reports and blocks atomically while keeping report-only behavior', async () => {
    await engines[0].open(group)
    const report = await engines[0].report(group, original)
    expect(report.verified).equals(true)
    expect(await clients[0].chatBlocks()).deep.equals([])
    const evidence = await f.db
      .selectFrom('chat_reports')
      .selectAll()
      .where('id', '=', report.id)
      .executeTakeFirstOrThrow()
    const body = {
      messageId: original,
      plaintext: evidence.plaintext,
      messageKey: Buffer.from(evidence.message_key).toString('base64url'),
      blockSender: true
    }
    expect((await f.call('Hc', 'POST', '/chat/reports', body)).status).equals(
      201
    )
    expect(await clients[0].chatBlocks()).has.length(1)
    await block(false)
    const combined = await engines[0].report(group, original, true)
    expect(combined.verified).equals(true)
    expect(engines[0].isBlocked(f.id('Hs'))).equals(true)
    await block(false)
    expect(
      (
        await f.call('Hc', 'POST', '/chat/reports', {
          ...body,
          messageId: 'invalid'
        })
      ).status
    ).equals(400)
    expect(await clients[0].chatBlocks()).deep.equals([])
    expect((await f.call('Hs', 'POST', '/chat/reports', body)).status).equals(
      400
    )
    expect(await clients[1].chatBlocks()).deep.equals([])
    await sql`alter table chat_reports add constraint fixture_report_failure check (plaintext <> 'Fixture rejected report')`.execute(
      f.db
    )
    try {
      expect(
        (
          await f.call('Hc', 'POST', '/chat/reports', {
            ...body,
            plaintext: 'Fixture rejected report'
          })
        ).status
      ).equals(500)
      expect(await clients[0].chatBlocks()).deep.equals([])
    } finally {
      await sql`alter table chat_reports drop constraint fixture_report_failure`.execute(
        f.db
      )
    }
  })
  it('waits for in-flight policy readers before acknowledging a block', async () => {
    let release!: () => void
    let entered!: () => void
    const ready = new Promise<void>(resolve => {
      entered = resolve
    })
    const held = new Promise<void>(resolve => {
      release = resolve
    })
    const reader = f.db.transaction().execute(async trx => {
      await lockBlockPolicy(trx)
      entered()
      await held
    })
    await ready
    let acknowledged = false
    const writing = block().then(() => {
      acknowledged = true
    })
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(acknowledged).equals(false)
    release()
    await reader
    await writing
    expect(acknowledged).equals(true)
    await block(false)
  })
  it('preserves blocks through merged historical identities and deduplicates the list', async () => {
    const old = await f.person('old')
    await f.db
      .insertInto('chat_user_blocks')
      .values({ blocker_user_id: f.id('Hc'), blocked_user_id: old })
      .execute()
    await closeInto(f.db, old, f.id('Hs'))
    await block()
    expect(await blockedSenderIds(f.db, f.id('Hc'))).includes(old)
    const oldActor = await f.person('old-blocker')
    await f.db
      .insertInto('chat_user_blocks')
      .values({ blocker_user_id: oldActor, blocked_user_id: old })
      .execute()
    await closeInto(f.db, oldActor, f.id('Hc'))
    expect([...(await blockingRecipientIds(f.db, old))])
      .includes(f.id('Hc'))
      .and.includes(oldActor)
    expect([...(await blockingRecipientIds(f.db, f.id('Hs')))]).includes(
      f.id('Hc')
    )
    expect([...(await blockingRecipientIds(f.db, 'usr_missing'))]).deep.equals(
      []
    )
    expect([...(await blockingRecipientIds(f.db, f.id('N')))]).deep.equals([])
    expect(await blocksFor(f.db, TEST_MEDIA, f.id('Hc'))).has.length(1)
    await setBlock(f.db, f.id('Hc'), old, false, f.now)
    expect(await clients[0].chatBlocks()).deep.equals([])
  })
  it('delivers deletion metadata without blocked ciphertext so moderation still removes content', async () => {
    await engines[0].refresh()
    await engines[0].idle()
    const target = (await engines[1].sendText(group, 'A post to remove.'))!
    await engines[0].open(group)
    await clients[2].setChatBlock(f.id('Hc'), true)
    await engines[0].moderatorDelete(group, target.id)
    const rows = await clients[2].chatMessages(group)
    const removal = rows.find(
      row =>
        row.kind === 'moderatorDelete' &&
        row.targetIds?.includes(target.id) === true
    )!
    expect(removal.ciphertext).equals('')
    expect(removal.clearedAt).not.equals(null)
    await engines[2].open(group)
    expect(
      engines[2]
        .view(group)!
        .messages.find(message => message.id === target.id)!.status
    ).equals('removed')
    await clients[2].setChatBlock(f.id('Hc'), false)
  })
  it('notifies only the blocker and filters typing hints for them', async () => {
    const name = (
      await sql<{ name: string }>`select current_database() as name`.execute(
        f.db
      )
    ).rows[0].name
    let queries = 0
    const countingDb = f.db.withPlugin({
      transformQuery(args) {
        queries++
        return args.node
      },
      async transformResult(args) {
        return args.result
      }
    })
    const feed = new PostgresFeed({
      databaseUrl: testDatabaseUrl.replace(/\/[^/]*$/, '/' + name),
      log: () => undefined
    })
    const fanout = new ChatFanout({
      db: countingDb,
      readMembers: async () =>
        new Set([
          ...['Hc', 'Hs', 'N'].map(key => f.id(key)),
          ...Array.from({ length: 100 }, (_, i) => `fixture-extra-${i}`)
        ]),
      feed
    })
    const received = new Map<string, unknown[]>()
    for (const key of ['Hc', 'Hs', 'N']) {
      received.set(key, [])
      fanout.add({
        userId: f.id(key),
        send: frame => {
          received.get(key)!.push(frame)
        }
      })
    }
    try {
      await fanout.listening
      await block()
      await new Promise(resolve => setTimeout(resolve, 50))
      expect(received.get('Hc')).deep.includes({
        type: 'chatUser',
        kind: 'blocks'
      })
      expect(received.get('Hs')).deep.equals([])
      for (const events of received.values()) events.length = 0
      queries = 0
      await fanout.deliver(
        JSON.stringify({ c: group, k: 'typing', u: f.id('Hs') })
      )
      expect(queries).at.most(5)
      expect(received.get('Hc')).deep.equals([])
      expect(received.get('N')).has.length(1)
      await block(false)
    } finally {
      await fanout.close()
      await feed.close()
    }
  })
  it('purges open encrypted history, quote snippets, reactions and pins, then restores on unblock', async () => {
    const actor = engines[0]
    await actor.pinMessage(group, original, true)
    await engines[2].sendText(group, 'A reply that remains.', {
      quoteId: original
    })
    await actor.open(group)
    const own = await actor.sendText(group, 'Third-party context remains.')
    await engines[1].open(group)
    await engines[1].react(group, own!.id, '👍')
    await actor.open(group)
    expect(
      actor.view(group)!.messages.some(message => message.id === original)
    ).equals(true)
    await actor.setBlocked(f.id('Hs'), true)
    await actor.idle()
    const hidden = actor.view(group)!
    expect(actor.isBlocked(f.id('Hs'))).equals(true)
    expect(
      hidden.messages.some(message => message.senderUserId === f.id('Hs'))
    ).equals(false)
    expect(
      hidden.messages.find(message => message.id === own!.id)!.reactions
    ).deep.equals([])
    expect(hidden.pins).deep.equals([])
    expect(
      hidden.messages.find(message => message.body === 'A reply that remains.')
        ?.quote?.snippet
    ).equals('Message unavailable')
    await actor.setBlocked(f.id('Hs'), false)
    await actor.idle()
    expect(
      actor.view(group)!.messages.some(message => message.id === original)
    ).equals(true)
    await actor.pinMessage(group, original, false)
  })
  it('hides every merged identity immediately after report-and-block when refreshing fails', async () => {
    const actor = engines[0]
    await engines[2].sendText(group, 'Canonical identity history.')
    await actor.open(group)
    const own = await actor.sendText(group, 'Unrelated history stays visible.')
    await closeInto(f.db, f.id('Hs'), f.id('N'))
    const readBlocks = clients[0].chatBlocks.bind(clients[0])
    clients[0].chatBlocks = async () => {
      throw new Error('Fixture block-list outage')
    }
    try {
      const reported = await actor.report(group, original, true)
      expect(reported.verified).equals(true)
      expect(actor.isBlocked(f.id('Hs'))).equals(true)
      expect(actor.isBlocked(f.id('N'))).equals(true)
      expect(actor.view(group)!.messages.map(message => message.id)).includes(
        own!.id
      )
      expect(
        actor
          .view(group)!
          .messages.some(
            message =>
              message.senderUserId === f.id('Hs') ||
              message.senderUserId === f.id('N')
          )
      ).equals(false)
      await actor.idle()
      expect(
        actor
          .view(group)!
          .messages.some(
            message =>
              message.senderUserId === f.id('Hs') ||
              message.senderUserId === f.id('N')
          )
      ).equals(false)
      expect((await readBlocks())[0].userIds).includes(f.id('N'))
    } finally {
      clients[0].chatBlocks = readBlocks
    }
  })
  it('keeps history closed if a report response lacks the authoritative identity set', async () => {
    const actor = engines[0]
    await clients[0].setChatBlock(f.id('N'), false)
    await actor.refresh()
    await actor.open(group)
    const report = clients[0].reportChatMessage.bind(clients[0])
    const readBlocks = clients[0].chatBlocks.bind(clients[0])
    clients[0].reportChatMessage = async body => {
      const { id, verified } = await report(body)
      return { id, verified }
    }
    clients[0].chatBlocks = async () => {
      throw new Error('Fixture block-list outage')
    }
    try {
      await actor.report(group, original, true)
      expect(actor.view(group)!.messages).deep.equals([])
      await actor.idle()
      expect(actor.view(group)!.messages).deep.equals([])
    } finally {
      clients[0].reportChatMessage = report
      clients[0].chatBlocks = readBlocks
    }
    await actor.refresh()
    expect(actor.isBlocked(f.id('N'))).equals(true)
  })
})
