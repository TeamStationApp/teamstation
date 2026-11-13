import { appendFileSync } from 'node:fs'

import { expect } from 'chai'
import type { Kysely } from 'kysely'
import { after, afterEach, before, beforeEach, describe, it } from 'mocha'

import { utf8 } from '../../common/chatCrypto/bytes'
import { newEpochKey } from '../../common/chatCrypto/keys'
import { newMessageId } from '../../common/chatCrypto/messageIds'
import { type EnvelopeKind, sealMessage } from '../../common/chatCrypto/seal'
import { makeId } from '../../common/ids'
import type { ChatRead, ChatWake } from '../../common/push'
import {
  senderDeps,
  type TestPushQueue,
  testPushQueue,
  transcript
} from '../../test/pushQueueKit'
import { testRedisUrl } from '../../test/scoreboardKit'
import { b64, ChatDevices, ok, type TestKeys } from '../chat/chatTestDevices'
import { type ChatFixture, openChatFixture } from '../chat/chatTestFixture'
import type { ChatMessageView } from '../chat/messages'
import type { Database } from '../db/database'
import type { ApnsMessage } from './apns'
import { chatWakes, MAX_INLINE_WAKE, wakeChat } from './chatWakes'
import type { FcmMessage } from './fcm'
import {
  chatRequestOf,
  makePushEnqueuer,
  PUSH_GROUP,
  type PushEnqueuer,
  readRequestOf
} from './queue'
import type {
  PushAddress,
  PushMessage,
  PushTransport,
  PushTransports
} from './send'
import type { WebPushMessage } from './webPush'

/**
 * M3 through the message route, with real sealed envelopes: a new post wakes
 * the other members' devices, each with its own `ChatWake` in its platform's
 * shape, and nothing else wakes anybody. The route queues its request on the
 * push queue (the test Valkey), as the server's does, and the push sender's
 * own code reads it and sends. A recording transport stands in for APNs, FCM
 * and Web Push.
 *
 * With `TS_PUSH_DISPATCH_LOG` set, each case appends its recipients and
 * per-platform payloads to that file (the `server-push-dispatch.log`
 * artifact).
 */

interface Sent {
  to: PushAddress
  message: PushMessage
}

const dispatchLog = process.env.TS_PUSH_DISPATCH_LOG

describe('chat wakes (M3)', function () {
  this.timeout(120000)
  let fixture: ChatFixture
  let devices: ChatDevices
  let sent: Sent[] = []
  let pending: Array<Promise<unknown>> = []
  let pushQueue: TestPushQueue
  let enqueuer: PushEnqueuer | null = null
  let filtering = false
  let failWakes = false
  /** Posts are only queued, for a case to drain on a clock of its own. */
  let queueOnly = false
  let failReads = false
  /** How many moved cursors the route told of. */
  let readsTold = 0
  const held: Record<string, TestKeys> = {}
  let members: string
  let membersKey: Uint8Array

  /** Registrations every service refuses for good. */
  let refusing = new Set<string>()
  const recorder = <M extends PushMessage>(): PushTransport<M> => ({
    async send(to, message) {
      sent.push({ to, message })
      if (refusing.has(to.id))
        return { status: 'rejected', reason: 'BadDeviceToken' }
      return { status: 'sent' }
    }
  })
  const transports: PushTransports = {
    ios: recorder<ApnsMessage>(),
    android: recorder<FcmMessage>(),
    web: recorder<WebPushMessage>()
  }

  before(async function () {
    pushQueue = await testPushQueue()
    const opened = await openChatFixture('wakes', {
      // The route's request, queued, and the sender's work on it.
      wakes: async message => {
        if (failWakes) throw new Error('wakes are down')
        // As the server wires it: the API's enqueuer, never waited on.
        if (enqueuer != null) {
          const queued = enqueuer.add(chatRequestOf(message))
          pending.push(queued)
          return await queued
        }
        if (queueOnly) {
          const queued = pushQueue.add(chatRequestOf(message))
          pending.push(queued)
          return await queued
        }
        const wake = pushQueue
          .add(chatRequestOf(message))
          .then(
            async () =>
              await pushQueue.drain(
                senderDeps(fixture.db, transports, { iosFiltering: filtering })
              )
          )
        pending.push(wake)
        return await wake
      },
      // A moved cursor, queued only when a wake reached the reader there, as
      // the server's enqueuer queues it.
      reads: async read => {
        readsTold++
        if (failReads) throw new Error('reads are down')
        const queued = pushQueue.queue.addIfWoken({
          ...readRequestOf(read),
          v: 1,
          attempt: 1,
          devices: undefined
        })
        pending.push(queued)
        return await queued
      }
    })
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
    devices = new ChatDevices(fixture)
    for (const key of ['Hc', 'Hk', 'Hs', 'P', 'B', 'C']) {
      held[key] = (await devices.enrol(key)).keys
    }
    members = await chatId('Hc', 'Hawks Members')
    membersKey = await makeEpoch('Hc', members)
    // Everybody listens but Hs, who never turned it on, and Hk, who turned
    // it off.
    await fixture.db
      .insertInto('user_notification_settings')
      .values([
        ...['Hc', 'P', 'B', 'C'].map(key => ({
          user_id: fixture.id(key),
          messages: true
        })),
        { user_id: fixture.id('Hk'), messages: false }
      ])
      .execute()
  })

  after(async function () {
    await pushQueue?.close()
    await fixture?.close()
  })

  beforeEach(async function () {
    sent = []
    pending = []
    filtering = false
    failWakes = false
    queueOnly = false
    failReads = false
    readsTold = 0
    refusing = new Set()
    await fixture.db.deleteFrom('push_registrations').execute()
    const woken = await pushQueue.client.keys(
      `${pushQueue.prefix}:push:woken:*`
    )
    if (woken.length > 0) await pushQueue.client.del(woken)
  })

  afterEach(async function () {
    await next(this.currentTest?.title ?? '')
  })

  /**
   * Ends one step of a case: with `TS_PUSH_DISPATCH_LOG`, writes what it
   * sent and which registered devices it left out, then starts afresh.
   */
  async function next(step: string): Promise<void> {
    if (dispatchLog != null) {
      const lines = [`\n## ${step}`]
      if (sent.length === 0) lines.push('  (no pushes)')
      for (const { to, message } of sent) {
        const read = readOf(message)
        if (read != null) {
          lines.push(
            `  -> ${fixture.keyOf(to.userId)} ${to.platform} (${to.id})`,
            `     ${JSON.stringify(transportFields(message))}`,
            `     read ${JSON.stringify(read)}`
          )
          continue
        }
        const { env, ...wake } = wakeOf({ to, message })
        lines.push(
          `  -> ${fixture.keyOf(to.userId)} ${to.platform} (${to.id})`,
          `     ${JSON.stringify(transportFields(message))}`,
          `     wake ${JSON.stringify(wake)}`,
          env == null
            ? '     no env: the device fetches the message'
            : `     env: message ${env.id} seq ${env.seq}, ${Buffer.byteLength(JSON.stringify({ ...wake, env }))} bytes with it`
        )
      }
      const reachedIds = new Set(sent.map(item => item.to.id))
      const left = (
        await fixture.db
          .selectFrom('push_registrations')
          .select(['id', 'user_id', 'platform'])
          .orderBy('id')
          .execute()
      ).filter(row => !reachedIds.has(row.id))
      if (left.length > 0)
        lines.push(
          `  not woken: ${left.map(row => `${fixture.keyOf(row.user_id)} ${row.platform}`).join(', ')}`
        )
      appendFileSync(dispatchLog, `${lines.join('\n')}\n`)
    }
    sent = []
    pending = []
  }

  async function chatId(who: string, title: string): Promise<string> {
    const list = ok(
      await fixture.call(who, 'GET', '/chat/conversations')
    ) as Array<{ id: string; title: string | null }>
    const chat = list.find(item => item.title === title)
    if (chat == null) throw new Error(`${who} has no ${title}`)
    return chat.id
  }

  async function makeEpoch(
    creator: string,
    conversationId: string
  ): Promise<Uint8Array> {
    const epochKey = newEpochKey()
    const recipients = await devices.recipients(
      creator,
      conversationId,
      'eligible'
    )
    ok(
      await fixture.call(
        creator,
        'POST',
        `/chat/conversations/${conversationId}/epochs`,
        devices.epochBody({
          conversationId,
          epoch: 1,
          creator: held[creator],
          epochKey,
          previousEpochKey: null,
          recipients
        })
      ),
      201
    )
    return epochKey
  }

  function seal(
    key: string,
    conversationId: string,
    epochKey: Uint8Array,
    kind: EnvelopeKind,
    content: unknown,
    targetIds?: string[]
  ): Record<string, unknown> {
    const id = newMessageId()
    const keys = held[key]
    const sealed = sealMessage({
      conversationId,
      epoch: 1,
      messageId: id,
      senderUserId: keys.userId,
      kind,
      epochKey,
      plaintext: utf8(JSON.stringify(content)),
      identitySecretKey: keys.identity.secretKey
    })
    return {
      id,
      epoch: 1,
      kind,
      senderIdentityId: keys.identityId,
      nonce: b64(sealed.nonce),
      ciphertext: b64(sealed.ciphertext),
      signature: b64(sealed.signature),
      ...(targetIds == null ? {} : { targetIds })
    }
  }

  const text = (body: string): unknown => ({
    type: 'text',
    body,
    mentions: [],
    attachments: []
  })

  /** How many seconds from now APNs keeps `message` for an unreachable phone. */
  const keptFor = (message: ApnsMessage): number =>
    (message.expiration ?? 0) - Math.floor(Date.now() / 1000)

  /** Posts and waits for whatever it woke. */
  async function post(
    who: string,
    conversationId: string,
    body: Record<string, unknown>,
    status = 201
  ): Promise<ChatMessageView> {
    const made = ok(
      await fixture.call(
        who,
        'POST',
        `/chat/conversations/${conversationId}/messages`,
        body
      ),
      status
    ) as ChatMessageView
    await Promise.all(pending)
    return made
  }

  const SAFARI = 'https://web.push.apple.com/QGmHZGq0AAAAAAAAAAAAAAAAAAAAAAAA'
  const CHROME = 'https://fcm.googleapis.com/fcm/send/aAAAAAAAAAA:APA91b0000'
  const FIREFOX =
    'https://updates.push.services.mozilla.com/wpush/v2/gAAAAAAAAAAAAAAAAAAA'

  /** A device of `key`'s, on the session the fixture signed them in with. */
  async function register(
    key: string,
    platform: PushAddress['platform'],
    endpoint = CHROME,
    session = fixture.sessionOf(key)
  ): Promise<string> {
    const id = makeId('pushRegistration')
    const token = `${platform}-${key}-${session}-${'0'.repeat(32)}`
    const address =
      platform === 'web'
        ? JSON.stringify({
            endpoint,
            expirationTime: null,
            keys: { p256dh: 'BAAA', auth: 'AAAA' }
          })
        : token
    await fixture.db
      .insertInto('push_registrations')
      .values({
        id,
        user_id: fixture.id(key),
        session_id: session,
        platform,
        address_key:
          platform === 'web' ? `${endpoint}/${key}/${session}` : token,
        address,
        environment: 'production'
      })
      .execute()
    return id
  }

  /** The clear a message carries, when it is one rather than a wake. */
  function readOf(message: PushMessage): ChatRead | null {
    const { aps: _aps, ...payload } = (
      message.platform === 'ios'
        ? message.payload
        : JSON.parse(
            message.platform === 'android'
              ? message.data.payload
              : message.payload
          )
    ) as ChatRead & { aps?: unknown }
    return payload.t === 'read' ? payload : null
  }

  /** The wake a message carries, which always names its own recipient. */
  function wakeOf({ to, message }: Sent): ChatWake {
    const { aps: _aps, ...wake } = (
      message.platform === 'ios'
        ? message.payload
        : JSON.parse(
            message.platform === 'android'
              ? message.data.payload
              : message.payload
          )
    ) as ChatWake & { aps?: unknown }
    expect(wake.u, 'u is the recipient').equals(to.userId)
    expect(wake.t).equals('chat')
    return wake
  }

  /** A message without its wake: what each platform's service is told. */
  function transportFields(message: PushMessage): unknown {
    switch (message.platform) {
      case 'ios':
        return {
          pushType: message.pushType,
          priority: message.priority,
          aps: message.payload.aps
        }
      case 'android':
        return { priority: message.priority }
      case 'web':
        return { urgency: message.urgency }
    }
  }

  const to = (key: string, platform: PushAddress['platform']): Sent => {
    const found = sent.find(
      item =>
        item.to.userId === fixture.id(key) && item.to.platform === platform
    )
    if (found == null) throw new Error(`nothing to ${key} on ${platform}`)
    return found
  }

  const reached = (): string[] =>
    sent.map(item => `${fixture.keyOf(item.to.userId)}:${item.to.platform}`)

  /** `sender` as `reader` sees them in the chat's member list. */
  async function memberName(
    reader: string,
    conversationId: string,
    sender: string
  ): Promise<string> {
    const list = ok(
      await fixture.call(
        reader,
        'GET',
        `/chat/conversations/${conversationId}/members`
      )
    ) as Array<{ userId: string; shortName: string }>
    const member = list.find(item => item.userId === fixture.id(sender))
    if (member == null) throw new Error(`${sender} is not in ${conversationId}`)
    return member.shortName
  }

  it('wakes both members of a DM: an alert on iOS, high priority elsewhere, Safari too', async function () {
    await register('C', 'ios')
    await register('C', 'android')
    await register('C', 'web', SAFARI)
    await register('Hc', 'ios')
    await register('Hc', 'web')
    // The sender's own devices hear nothing.
    await register('B', 'ios')
    const dm = ok(
      await fixture.call('B', 'POST', '/chat/dms', {
        userIds: [fixture.id('C'), fixture.id('Hc')]
      }),
      201
    ).id as string
    const dmKey = await makeEpoch('B', dm)
    const made = await post('B', dm, seal('B', dm, dmKey, 'post', text('hi')))

    expect(reached().sort()).deep.equals([
      'C:android',
      'C:ios',
      'C:web',
      'Hc:ios',
      'Hc:web'
    ])
    for (const item of sent) {
      const wake = wakeOf(item)
      const reader = fixture.keyOf(item.to.userId)
      expect(wake).deep.equals({
        t: 'chat',
        u: fixture.id(reader),
        c: dm,
        seq: made.seq,
        dm: true,
        from: await memberName(reader, dm, 'B'),
        title: null,
        url: `teamstation://chat/${dm}`,
        env: made
      })
    }
    const ios = to('C', 'ios').message as ApnsMessage
    expect(ios).to.include({ pushType: 'alert', priority: 10 })
    expect(keptFor(ios)).closeTo(60 * 60, 5)
    expect(ios.payload.aps).deep.equals({
      alert: { body: `New message from ${await memberName('C', dm, 'B')}` },
      'mutable-content': 1,
      sound: 'default',
      'thread-id': `chat:${dm}`
    })
    expect(to('C', 'android').message).to.include({
      priority: 'high',
      ttlSeconds: 8 * 60 * 60
    })
    expect(to('C', 'android').message).not.to.have.property('collapseKey')
    expect(to('C', 'web').message).to.include({
      urgency: 'high',
      ttlSeconds: 60 * 60
    })
    expect(to('Hc', 'web').message).to.include({ urgency: 'high' })
  })

  it('names the sender as each reader reads them, with the chat title', async function () {
    await register('Hc', 'android')
    await register('B', 'android')
    const made = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('game day'))
    )
    expect(reached().sort()).deep.equals(['B:android', 'Hc:android'])
    // The coach reads the player in full; another parent does not.
    expect(wakeOf(to('Hc', 'android')).from)
      .equals('Pat Player')
      .and.equals(await memberName('Hc', members, 'P'))
    expect(wakeOf(to('B', 'android')).from)
      .equals('Pat P')
      .and.equals(await memberName('B', members, 'P'))
    for (const item of sent)
      expect(wakeOf(item)).to.include({
        c: members,
        seq: made.seq,
        dm: false,
        title: 'Hawks Members',
        url: `teamstation://chat/${members}`
      })
  })

  it('sends a group message as a background push to iOS, normal priority to Android, and not to Safari', async function () {
    await register('Hc', 'ios')
    await register('Hc', 'android')
    await register('Hc', 'web')
    await register('B', 'web', SAFARI)
    await post('P', members, seal('P', members, membersKey, 'post', text('x')))
    expect(reached().sort()).deep.equals(['Hc:android', 'Hc:ios', 'Hc:web'])
    const ios = to('Hc', 'ios').message as ApnsMessage
    expect(ios).to.include({ pushType: 'background', priority: 5 })
    expect(keptFor(ios)).closeTo(8 * 60 * 60, 5)
    expect(ios.payload.aps).deep.equals({ 'content-available': 1 })
    expect(to('Hc', 'android').message).to.include({
      priority: 'normal',
      ttlSeconds: 8 * 60 * 60
    })
    expect(to('Hc', 'android').message).not.to.have.property('collapseKey')
    expect(to('Hc', 'web').message).to.include({ urgency: 'normal' })
  })

  it('sends Firefox a DM but never a group wake, which Chrome still gets', async function () {
    await register('Hc', 'web', FIREFOX)
    await register('B', 'web')
    await post('P', members, seal('P', members, membersKey, 'post', text('x')))
    expect(reached()).deep.equals(['B:web'])
    expect(to('B', 'web').message).to.include({ urgency: 'normal' })
    await next('a group message skips Firefox and wakes Chrome')

    const dm = ok(
      await fixture.call('B', 'POST', '/chat/dms', {
        userIds: [fixture.id('Hc')]
      }),
      201
    ).id as string
    const dmKey = await makeEpoch('B', dm)
    await post('B', dm, seal('B', dm, dmKey, 'post', text('hi')))
    expect(reached()).deep.equals(['Hc:web'])
    expect(to('Hc', 'web').message).to.include({ urgency: 'high' })
    expect(wakeOf(to('Hc', 'web'))).to.include({ dm: true, c: dm })
  })

  it('sends a group message as a rewritable alert to iOS with iosFiltering', async function () {
    filtering = true
    await register('Hc', 'ios')
    await post('P', members, seal('P', members, membersKey, 'post', text('x')))
    const ios = to('Hc', 'ios').message as ApnsMessage
    expect(ios).to.include({ pushType: 'alert', priority: 10 })
    expect(keptFor(ios)).closeTo(60 * 60, 5)
    expect(ios.payload.aps).deep.equals({
      alert: { body: 'New message in Hawks Members' },
      'mutable-content': 1,
      sound: 'default',
      'thread-id': `chat:${members}`
    })
  })

  it('leaves out the sender, anyone in a block with them, those who muted, and those with messages off', async function () {
    for (const key of ['Hc', 'Hk', 'Hs', 'P', 'B', 'C']) {
      await register(key, 'android')
    }
    // B blocked the sender; the sender blocked C.
    ok(await fixture.call('B', 'PUT', `/chat/blocks/${fixture.id('P')}`))
    await post('P', members, seal('P', members, membersKey, 'post', text('1')))
    expect(reached().sort()).deep.equals(['C:android', 'Hc:android'])

    await next('leaving out: B blocked the sender P')
    ok(await fixture.call('P', 'PUT', `/chat/blocks/${fixture.id('C')}`))
    await post('P', members, seal('P', members, membersKey, 'post', text('2')))
    expect(reached()).deep.equals(['Hc:android'])

    await next('leaving out: the sender P also blocked C')
    ok(
      await fixture.call(
        'Hc',
        'PATCH',
        `/chat/conversations/${members}/preferences`,
        {
          muted: true
        }
      )
    )
    await post('P', members, seal('P', members, membersKey, 'post', text('3')))
    expect(reached()).deep.equals([])

    // Unblocked and unmuted, everybody listening hears it again.
    await next('leaving out: Hc muted Hawks Members too')
    ok(await fixture.call('B', 'DELETE', `/chat/blocks/${fixture.id('P')}`))
    ok(await fixture.call('P', 'DELETE', `/chat/blocks/${fixture.id('C')}`))
    ok(
      await fixture.call(
        'Hc',
        'PATCH',
        `/chat/conversations/${members}/preferences`,
        {
          muted: false
        }
      )
    )
    await post('P', members, seal('P', members, membersKey, 'post', text('4')))
    expect(reached().sort()).deep.equals([
      'B:android',
      'C:android',
      'Hc:android'
    ])
  })

  it('wakes nobody for a retried post, a reaction, an edit or a delete', async function () {
    await register('Hc', 'ios')
    const first = seal('B', members, membersKey, 'post', text('once'))
    const made = await post('B', members, first)
    expect(reached()).deep.equals(['Hc:ios'])

    await next('nothing else wakes: the first post')
    expect(await post('B', members, first, 200)).deep.equals(made)
    await post(
      'B',
      members,
      seal('B', members, membersKey, 'reaction', {
        type: 'reaction',
        target: made.id,
        emoji: '+1'
      })
    )
    await post(
      'B',
      members,
      seal('B', members, membersKey, 'edit', {
        type: 'edit',
        target: made.id,
        body: 'twice'
      })
    )
    await post(
      'B',
      members,
      seal('B', members, membersKey, 'delete', {}, [made.id])
    )
    expect(pending).deep.equals([])
    expect(sent).deep.equals([])
  })

  it('leaves out the envelope when the wake would be over 3000 bytes', async function () {
    await register('Hc', 'web')
    await post(
      'B',
      members,
      seal('B', members, membersKey, 'post', text('x'.repeat(3000)))
    )
    const large = wakeOf(to('Hc', 'web'))
    expect(large).not.to.have.property('env')
    expect(large.seq).to.be.a('number')

    await next('the envelope: a wake over 3000 bytes')
    const made = await post(
      'B',
      members,
      seal('B', members, membersKey, 'post', text('short'))
    )
    const small = (to('Hc', 'web').message as WebPushMessage).payload
    expect(JSON.parse(small).env).deep.equals(made)
    expect(Buffer.byteLength(small)).to.be.at.most(MAX_INLINE_WAKE)
  })

  it('answers the send whatever happens to its wakes', async function () {
    await register('Hc', 'ios')
    failWakes = true
    const made = await post(
      'B',
      members,
      seal('B', members, membersKey, 'post', text('x'))
    )
    expect(sent).deep.equals([])

    // A wake that cannot read who to wake throws, and the sender puts its
    // request back for a later try.
    const broken = {
      selectFrom: () => {
        throw new Error('the database is away')
      }
    } as unknown as Kysely<Database>
    let thrown: unknown
    await chatWakes(broken, made, { transports, iosFiltering: false }).catch(
      (error: unknown) => {
        thrown = error
      }
    )
    expect(String(thrown)).equals('Error: the database is away')
    await pushQueue.add(chatRequestOf(made))
    const said: string[] = []
    await pushQueue.drain(
      senderDeps(broken, transports, {
        log: line => {
          said.push(line)
        }
      })
    )
    expect(said).length(1)
    expect(said[0]).match(
      /^push sender: chat request \S+ \(attempt 1\) failed, trying again at \S+: Error: the database is away$/
    )
    const later = await pushQueue.client.zRange(
      pushQueue.queue.keys.later,
      0,
      -1
    )
    expect(later.map(raw => JSON.parse(raw) as unknown)).deep.equals([
      { ...chatRequestOf(made), v: 1, attempt: 2 }
    ])
    await pushQueue.client.del(pushQueue.queue.keys.later)
  })

  it("queues one request through the API's enqueuer, and posts at once with Valkey away", async function () {
    const settings = {
      redis: { url: testRedisUrl, prefix: pushQueue.prefix },
      databaseUrl: fixture.url
    }
    enqueuer = makePushEnqueuer(settings, () => undefined)
    try {
      // Connected, as a worker is once it is up.
      while (
        !(await enqueuer.add({
          t: 'reminder',
          kind: 'game',
          eventId: 'gam_warm',
          startAt: '2027-05-01T22:00:00.000Z'
        }))
      )
        await new Promise(resolve => setTimeout(resolve, 20))
      await pushQueue.client.del(pushQueue.queue.keys.requests)
      await pushQueue.queue.ensureGroup()
      const made = await post(
        'B',
        members,
        seal('B', members, membersKey, 'post', text('queued'))
      )
      const entries = await pushQueue.client.xRange(
        pushQueue.queue.keys.requests,
        '-',
        '+'
      )
      expect(entries.map(entry => JSON.parse(entry.message.r))).deep.equals([
        { ...chatRequestOf(made), v: 1, attempt: 1 }
      ])
      // The sender's: nothing sent by the API itself.
      expect(sent).deep.equals([])
      const read = await pushQueue.queue.read('test-sender', 16, 1)
      for (const entry of read) await pushQueue.queue.done(entry.id)
      expect(
        Number(
          (
            await pushQueue.client.xPending(
              pushQueue.queue.keys.requests,
              PUSH_GROUP
            )
          ).pending
        )
      ).equals(0)
    } finally {
      await enqueuer.close()
    }

    const said: string[] = []
    enqueuer = makePushEnqueuer(
      { ...settings, redis: { url: 'redis://127.0.0.1:1', prefix: 'away' } },
      line => said.push(line)
    )
    try {
      const asked = Date.now()
      await post(
        'B',
        members,
        seal('B', members, membersKey, 'post', text('lost'))
      )
      expect(Date.now() - asked).lessThan(2000)
      expect(
        said.filter(line => line.startsWith('push queue: dropped'))
      ).deep.equals([
        'push queue: dropped a chat request: Valkey is not connected'
      ])
    } finally {
      await enqueuer.close()
      enqueuer = null
    }
  })

  it('wakes on a later try only the members a failure kept the last from', async function () {
    await register('Hc', 'ios')
    await register('P', 'android')
    failWakes = true
    const made = await post(
      'B',
      members,
      seal('B', members, membersKey, 'post', text('again'))
    )
    const report = await wakeChat(
      fixture.db,
      {
        c: made.conversationId,
        seq: made.seq,
        sender: made.senderUserId,
        to: [fixture.id('P')]
      },
      { transports, iosFiltering: false }
    )
    expect(report?.sent).equals(1)
    expect(sent.map(item => fixture.keyOf(item.to.userId))).deep.equals(['P'])
  })

  it("wakes nobody for a request whose post is not there, not the sender's, or not a post", async function () {
    await register('Hc', 'ios')
    failWakes = true
    const made = await post(
      'B',
      members,
      seal('B', members, membersKey, 'post', text('x'))
    )
    const ask = async (change: {
      seq?: number
      sender?: string
    }): Promise<unknown> =>
      await wakeChat(
        fixture.db,
        {
          c: made.conversationId,
          seq: made.seq,
          sender: made.senderUserId,
          to: undefined,
          ...change
        },
        { transports, iosFiltering: false }
      )
    expect(await ask({ seq: made.seq + 100 })).equals(null)
    expect(await ask({ sender: fixture.id('Hc') })).equals(null)
    expect(sent).deep.equals([])
  })

  /**
   * Drains what was queued as the sender would `ahead` ms after now, with a
   * 15 s hold, putting back first what is due by then.
   */
  async function drainAt(ahead: number): Promise<void> {
    const clock = (): Date => new Date(Date.now() + ahead)
    await pushQueue.queue.promote(clock().getTime())
    await pushQueue.drain(
      senderDeps(fixture.db, transports, { chatHoldMs: 15_000, clock })
    )
  }

  /** `who` reads `conversationId` up to `seq`, as the app does. */
  async function read(
    who: string,
    conversationId: string,
    seq: number
  ): Promise<void> {
    ok(
      await fixture.call(
        who,
        'PUT',
        `/chat/conversations/${conversationId}/read`,
        { seq }
      )
    )
    await Promise.all(pending)
  }

  /** A second signed-in session of `key`'s: another device of theirs. */
  async function otherSession(key: string): Promise<string> {
    const id = makeId('authSession')
    await fixture.db
      .insertInto('auth_sessions')
      .values({
        id,
        user_id: fixture.id(key),
        token_hash: `other-${id}`,
        created_at: new Date(),
        expires_at: new Date(Date.now() + 3_600_000)
      })
      .execute()
    return id
  }

  it('holds a post 15 s, and skips a member who read it meanwhile or wrote after it', async function () {
    await register('Hc', 'android')
    await register('B', 'android')
    await register('C', 'android')
    queueOnly = true
    const made = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('held'))
    )
    for (const name of ['seen', 'queue'] as const)
      transcript(
        name,
        `\n## hold, then check (chatWakes.integration.test.ts)\n$ P posts seq ${made.seq} to Hawks Members; the route queues ${JSON.stringify(chatRequestOf(made))}`
      )
    // Within the hold: nothing sent, and the request waits, due 15 s on.
    await drainAt(1000)
    expect(sent).deep.equals([])
    const [waiting] = await pushQueue.client.zRangeWithScores(
      pushQueue.queue.keys.later,
      0,
      -1
    )
    const due = (JSON.parse(waiting.value) as { due: number }).due
    expect(waiting.score).equals(due)
    for (const name of ['seen', 'queue'] as const)
      transcript(
        name,
        `$ sender at post + 1 s: held, nothing sent; ZADD ${pushQueue.queue.keys.later} ${waiting.score} (queued at ${new Date(due - 15_000).toISOString()}, + 15 s) ${waiting.value}`
      )
    // Hc reads it in the app, and C answers it, both while it is held.
    await read('Hc', members, made.seq)
    const answer = await post(
      'C',
      members,
      seal('C', members, membersKey, 'post', text('ok'))
    )
    const cursor = await fixture.db
      .selectFrom('chat_read_cursors')
      .select('seq')
      .where('user_id', '=', fixture.id('Hc'))
      .where('conversation_id', '=', members)
      .executeTakeFirstOrThrow()
    transcript(
      'seen',
      `$ within the hold: Hc's read cursor moves to ${cursor.seq}; C posts seq ${answer.seq}; B does neither`
    )
    await drainAt(16_000)
    // B, who neither read nor wrote, is woken for P's post; C's post wakes
    // B, and Hc, whose cursor is behind it.
    expect(
      sent.map(item => `${fixture.keyOf(item.to.userId)}:${wakeOf(item).seq}`)
    ).deep.members([`B:${made.seq}`, `B:${made.seq + 1}`, `Hc:${made.seq + 1}`])
    expect(await pushQueue.client.zCard(pushQueue.queue.keys.later)).equals(0)
    const woke = (seq: number): string[] =>
      sent
        .filter(item => wakeOf(item).seq === seq)
        .map(item => `${fixture.keyOf(item.to.userId)} ${item.to.platform}`)
    transcript(
      'seen',
      [
        `$ sender at post + 16 s, the hold over: seq ${made.seq} woke [${woke(made.seq).join(', ')}]`,
        `  Hc skipped: read cursor at ${cursor.seq} (>= seq ${made.seq})`,
        `  C skipped: posted seq ${answer.seq} after seq ${made.seq}`,
        `  B sent: neither read nor wrote since`,
        `$ C's own post, seq ${made.seq + 1}, woke [${woke(made.seq + 1).join(', ')}]: Hc's cursor is behind it`
      ].join('\n')
    )
    transcript(
      'queue',
      `$ sender at post + 16 s: promoted, sent, XACK + XDEL; ZCARD later ${await pushQueue.client.zCard(pushQueue.queue.keys.later)}`
    )
  })

  it('sends a held post to a member who has not seen it, and tries it again unheld', async function () {
    await register('Hc', 'android')
    queueOnly = true
    const made = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('unread'))
    )
    await drainAt(0)
    expect(sent).deep.equals([])
    // Read only up to the one before: it is still unseen.
    await read('Hc', members, made.seq - 1)
    let failing = true
    const flaky: PushTransports = {
      android: {
        async send(to, message) {
          if (failing) return { status: 'failed', reason: 'down' }
          sent.push({ to, message })
          return { status: 'sent' }
        }
      }
    }
    const at =
      (ahead: number): (() => Date) =>
      () =>
        new Date(Date.now() + ahead)
    await pushQueue.queue.promote(at(16_000)().getTime())
    await pushQueue.drain(
      senderDeps(fixture.db, flaky, { chatHoldMs: 15_000, clock: at(16_000) })
    )
    expect(sent).deep.equals([])
    // Its retry, 5 s on, is sent at once: the hold is over.
    failing = false
    await pushQueue.queue.promote(at(22_000)().getTime())
    await pushQueue.drain(
      senderDeps(fixture.db, flaky, { chatHoldMs: 15_000, clock: at(22_000) })
    )
    expect(sent.map(item => wakeOf(item).seq)).deep.equals([made.seq])
    expect(await pushQueue.queue.wokenAt(fixture.id('Hc'), members)).equals(
      made.seq
    )
  })

  it('takes a read conversation down from the reader’s other devices, only after a wake', async function () {
    const SAFARI_SUB = SAFARI
    const EDGE = 'https://wns2-par02p.notify.windows.com/w/?token=BQYAAAB0000'
    const elsewhere = await otherSession('Hc')
    // The device that reads, and Hc's others on each platform and browser.
    await register('Hc', 'android')
    const others = {
      ios: await register('Hc', 'ios', CHROME, elsewhere),
      android: await register('Hc', 'android', CHROME, elsewhere),
      chrome: await register('Hc', 'web', CHROME, elsewhere),
      edge: await register('Hc', 'web', EDGE, elsewhere)
    }
    await register('Hc', 'web', SAFARI_SUB, elsewhere)
    await register('Hc', 'web', FIREFOX, elsewhere)
    await fixture.db
      .deleteFrom('chat_read_cursors')
      .where('user_id', '=', fixture.id('Hc'))
      .where('conversation_id', '=', members)
      .execute()

    // A read with no wake before it queues nothing.
    const first = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('one'))
    )
    await pushQueue.client.del(
      pushQueue.queue.keys.woken(fixture.id('Hc'), members)
    )
    await next('a wake, its mark taken away')
    await read('Hc', members, first.seq)
    expect(await pushQueue.client.xLen(pushQueue.queue.keys.requests)).equals(0)

    // A wake marks Hc woken at its seq, and their read clears it elsewhere.
    const made = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('two'))
    )
    expect(sent.filter(item => item.to.userId === fixture.id('Hc'))).length(5)
    expect(await pushQueue.queue.wokenAt(fixture.id('Hc'), members)).equals(
      made.seq
    )
    await next('a wake to every device of Hc’s')
    await read('Hc', members, made.seq)
    await pushQueue.drain(senderDeps(fixture.db, transports))
    const clear = { t: 'read', u: fixture.id('Hc'), c: members, seq: made.seq }
    expect(sent.map(item => item.to.id).sort()).deep.equals(
      Object.values(others).sort()
    )
    for (const { to, message } of sent)
      switch (message.platform) {
        case 'ios': {
          expect(keptFor(message)).closeTo(8 * 60 * 60, 5)
          const { expiration: _kept, ...rest } = message
          expect(rest).deep.equals({
            platform: 'ios',
            pushType: 'background',
            priority: 5,
            payload: { aps: { 'content-available': 1 }, ...clear }
          })
          break
        }
        case 'android':
          expect(message).deep.equals({
            platform: 'android',
            priority: 'normal',
            ttlSeconds: 8 * 60 * 60,
            data: { payload: JSON.stringify(clear) }
          })
          break
        case 'web':
          expect([others.chrome, others.edge]).includes(to.id)
          expect(message).deep.equals({
            platform: 'web',
            payload: JSON.stringify(clear),
            urgency: 'normal',
            ttlSeconds: 8 * 60 * 60
          })
      }
    // Cleared once: the mark is gone, and the next read queues nothing.
    expect(await pushQueue.queue.wokenAt(fixture.id('Hc'), members)).equals(
      null
    )
    await next('a read clears the other devices')
    const third = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('three'))
    )
    await pushQueue.client.del(
      pushQueue.queue.keys.woken(fixture.id('Hc'), members)
    )
    await next('a wake, its mark taken away')
    await read('Hc', members, third.seq)
    expect(await pushQueue.client.xLen(pushQueue.queue.keys.requests)).equals(0)
  })

  it('clears nothing while a later wake is unread, and keeps its mark', async function () {
    await register('Hc', 'android', CHROME, await otherSession('Hc'))
    const one = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('one'))
    )
    const two = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('two'))
    )
    await next('two wakes')
    await read('Hc', members, one.seq)
    await pushQueue.drain(senderDeps(fixture.db, transports))
    expect(sent).deep.equals([])
    expect(await pushQueue.queue.wokenAt(fixture.id('Hc'), members)).equals(
      two.seq
    )
    // A device it fails to reach keeps the mark for the next try.
    await read('Hc', members, two.seq)
    const said: string[] = []
    await pushQueue.drain(
      senderDeps(
        fixture.db,
        {
          android: {
            send: async () => ({ status: 'failed', reason: 'down' })
          }
        },
        { log: line => said.push(line) }
      )
    )
    expect(
      said.some(line => /read request \S+ \(attempt 1\) failed/.test(line))
    ).equals(true)
    expect(await pushQueue.queue.wokenAt(fixture.id('Hc'), members)).equals(
      two.seq
    )
    await pushQueue.client.del(pushQueue.queue.keys.later)
  })

  it('marks whom a wake goes to before sending it, so a read while it is on its way clears their other devices', async function () {
    const reading = await register('Hc', 'android')
    const other = await register(
      'Hc',
      'android',
      CHROME,
      await otherSession('Hc')
    )
    // Safari is woken for no group message, so never marked for one.
    await register('B', 'web', SAFARI)
    await fixture.db
      .deleteFrom('chat_read_cursors')
      .where('user_id', '=', fixture.id('Hc'))
      .where('conversation_id', '=', members)
      .execute()
    queueOnly = true
    const made = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('on its way'))
    )
    // Hc reads on one phone while the wake is still going to the other.
    let readOnTheWay = false
    const slow: PushTransports = {
      android: {
        async send(to, message) {
          if (to.id === other && !readOnTheWay) {
            readOnTheWay = true
            await read('Hc', members, made.seq)
          }
          sent.push({ to, message })
          return { status: 'sent' }
        }
      }
    }
    await pushQueue.drain(senderDeps(fixture.db, slow))
    expect(readOnTheWay).equals(true)
    expect(await pushQueue.queue.wokenAt(fixture.id('B'), members)).equals(null)
    // Both phones were woken, then the other told to take it down.
    const [last] = sent.slice(-1)
    expect(sent.map(item => item.to.id).sort()).deep.equals(
      [reading, other, other].sort()
    )
    expect(last.to.id).equals(other)
    expect(JSON.parse((last.message as FcmMessage).data.payload)).deep.equals({
      t: 'read',
      u: fixture.id('Hc'),
      c: members,
      seq: made.seq
    })
    expect(await pushQueue.queue.wokenAt(fixture.id('Hc'), members)).equals(
      null
    )
  })

  it('takes back the mark of a member who reads after it is made and before their cursor is looked at, and wakes nobody', async function () {
    await register('Hc', 'android')
    await register('Hc', 'android', CHROME, await otherSession('Hc'))
    await fixture.db
      .deleteFrom('chat_read_cursors')
      .where('user_id', '=', fixture.id('Hc'))
      .where('conversation_id', '=', members)
      .execute()
    queueOnly = true
    const made = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('read in the window'))
    )
    // Hc reads the moment the mark is made, before the sender looks at
    // their cursor: the read finds the mark, and queues a clear.
    const queue = pushQueue.queue
    const mark = queue.markWoken.bind(queue)
    let readInWindow = false
    queue.markWoken = async (userIds, conversationId, seq) => {
      const fresh = await mark(userIds, conversationId, seq)
      if (!readInWindow && userIds.includes(fixture.id('Hc'))) {
        readInWindow = true
        await read('Hc', members, seq)
      }
      return fresh
    }
    try {
      await pushQueue.drain(senderDeps(fixture.db, transports))
    } finally {
      Reflect.deleteProperty(queue, 'markWoken')
    }
    expect(readInWindow).equals(true)
    // Seen, so woken nowhere; the mark is gone, and the clear found nothing.
    expect(sent).deep.equals([])
    expect(await queue.wokenAt(fixture.id('Hc'), members)).equals(null)
    expect(await pushQueue.client.xLen(queue.keys.requests)).equals(0)
    expect(made.seq).greaterThan(0)
  })

  it('wakes a member who reads just after their cursor is looked at, then clears their other devices', async function () {
    const reading = await register('Hc', 'android')
    const other = await register(
      'Hc',
      'android',
      CHROME,
      await otherSession('Hc')
    )
    await fixture.db
      .deleteFrom('chat_read_cursors')
      .where('user_id', '=', fixture.id('Hc'))
      .where('conversation_id', '=', members)
      .execute()
    queueOnly = true
    const made = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('read after the look'))
    )
    // Hc reads as soon as the sender has read the cursors, before it sends.
    const executor = fixture.db.getExecutor()
    const cursorReads = new Set<unknown>()
    let readAfterLook = false
    const looking = fixture.db.withPlugin({
      transformQuery(args) {
        if (
          executor
            .compileQuery(args.node, args.queryId)
            .sql.includes('"chat_read_cursors"')
        )
          cursorReads.add(args.queryId)
        return args.node
      },
      async transformResult(args) {
        if (!readAfterLook && cursorReads.has(args.queryId)) {
          readAfterLook = true
          await read('Hc', members, made.seq)
        }
        return args.result
      }
    })
    await pushQueue.drain(senderDeps(looking, transports))
    expect(readAfterLook).equals(true)
    // Both phones were woken, then the other told to take it down.
    expect(sent.map(item => item.to.id).sort()).deep.equals(
      [reading, other, other].sort()
    )
    expect(readOf(sent.at(-1)!.message)).deep.equals({
      t: 'read',
      u: fixture.id('Hc'),
      c: members,
      seq: made.seq
    })
    expect(await pushQueue.queue.wokenAt(fixture.id('Hc'), members)).equals(
      null
    )
  })

  it('keeps the mark while a device’s clear fails, and sends it again to that device alone', async function () {
    await register('Hc', 'android')
    const elsewhere = await otherSession('Hc')
    const phone = await register('Hc', 'android', CHROME, elsewhere)
    const ipad = await register('Hc', 'ios', CHROME, elsewhere)
    await fixture.db
      .deleteFrom('chat_read_cursors')
      .where('user_id', '=', fixture.id('Hc'))
      .where('conversation_id', '=', members)
      .execute()
    const made = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('clear me twice'))
    )
    expect(sent.filter(item => item.to.userId === fixture.id('Hc'))).length(3)
    await next('a wake to Hc’s phone, other phone and iPad')
    await read('Hc', members, made.seq)
    // The phone takes the clear; the iPad's send fails.
    let ipadDown = true
    const flaky: PushTransports = {
      ...transports,
      ios: {
        async send(to, message) {
          if (ipadDown) return { status: 'failed', reason: 'APNs is slow' }
          sent.push({ to, message })
          return { status: 'sent' }
        }
      }
    }
    await pushQueue.drain(senderDeps(fixture.db, flaky))
    expect(sent.map(item => item.to.id)).deep.equals([phone])
    // Hc counts as reached, but the mark stays, for the iPad's retry.
    expect(await pushQueue.queue.wokenAt(fixture.id('Hc'), members)).equals(
      made.seq
    )
    const [retry] = (
      await pushQueue.client.zRange(pushQueue.queue.keys.later, 0, -1)
    ).map(raw => JSON.parse(raw) as Record<string, unknown>)
    expect(retry).to.include({ t: 'read', attempt: 2 })
    expect(retry.devices).deep.equals([ipad])
    await next('the phone cleared, the iPad not')
    ipadDown = false
    await pushQueue.queue.promote(Date.now() + 10_000)
    await pushQueue.drain(senderDeps(fixture.db, flaky))
    expect(sent.map(item => item.to.id)).deep.equals([ipad])
    expect(readOf(sent[0].message)).to.include({ t: 'read', seq: made.seq })
    expect(await pushQueue.queue.wokenAt(fixture.id('Hc'), members)).equals(
      null
    )
    expect(await pushQueue.client.zCard(pushQueue.queue.keys.later)).equals(0)
  })

  it('tries a read again on a device whose send threw, still on it alone when the registrations cannot be read', async function () {
    await register('Hc', 'android')
    const elsewhere = await otherSession('Hc')
    const ipad = await register('Hc', 'ios', CHROME, elsewhere)
    await fixture.db
      .deleteFrom('chat_read_cursors')
      .where('user_id', '=', fixture.id('Hc'))
      .where('conversation_id', '=', members)
      .execute()
    const made = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('throw on the clear'))
    )
    await next('a wake to Hc’s phone and iPad')
    await read('Hc', members, made.seq)
    const throwing: PushTransports = {
      ...transports,
      ios: {
        async send() {
          throw new Error('APNs went away')
        }
      }
    }
    await pushQueue.drain(senderDeps(fixture.db, throwing))
    const later = async (): Promise<Array<Record<string, unknown>>> =>
      (await pushQueue.client.zRange(pushQueue.queue.keys.later, 0, -1)).map(
        raw => JSON.parse(raw) as Record<string, unknown>
      )
    expect((await later())[0].devices).deep.equals([ipad])
    expect(await pushQueue.queue.wokenAt(fixture.id('Hc'), members)).equals(
      made.seq
    )
    // Its retry cannot read the registrations: tried again, on the iPad still.
    await pushQueue.queue.promote(Date.now() + 10_000)
    const executor = fixture.db.getExecutor()
    const away = fixture.db.withPlugin({
      transformQuery(args) {
        if (
          executor
            .compileQuery(args.node, args.queryId)
            .sql.includes('"push_registrations"')
        )
          throw new Error('the database is away')
        return args.node
      },
      async transformResult(args) {
        return args.result
      }
    })
    const said: string[] = []
    await pushQueue.drain(
      senderDeps(away, transports, { log: line => said.push(line) })
    )
    const [retry] = await later()
    expect(retry).to.include({ t: 'read', attempt: 3 })
    expect(retry.devices).deep.equals([ipad])
    expect(
      said.some(line => line.includes('reading registrations failed'))
    ).equals(true)
    expect(await pushQueue.queue.wokenAt(fixture.id('Hc'), members)).equals(
      made.seq
    )
    await pushQueue.client.del(pushQueue.queue.keys.later)
  })

  it('wakes as before when marking or unmarking fails, and says so', async function () {
    await register('Hc', 'android')
    queueOnly = true
    const made = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('marks are down'))
    )
    const queue = pushQueue.queue
    queue.markWoken = async () => {
      throw new Error('Valkey is away')
    }
    const said: string[] = []
    try {
      await pushQueue.drain(
        senderDeps(fixture.db, transports, { log: line => said.push(line) })
      )
    } finally {
      Reflect.deleteProperty(queue, 'markWoken')
    }
    expect(sent.map(item => wakeOf(item).seq)).deep.equals([made.seq])
    expect(said).include(
      `push: marking ${members} seq ${made.seq} woken failed: Error: Valkey is away`
    )
    await next('a wake with the mark failing')
    // Read already, and its fresh mark cannot be taken back: nothing is sent.
    const seen = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('read before the look'))
    )
    await read('Hc', members, seen.seq)
    queue.readPast = async () => {
      throw new Error('Valkey is away')
    }
    try {
      await pushQueue.drain(
        senderDeps(fixture.db, transports, { log: line => said.push(line) })
      )
    } finally {
      Reflect.deleteProperty(queue, 'readPast')
    }
    expect(sent).deep.equals([])
    expect(said).include(
      `push: unmarking ${members} seq ${seen.seq} woken failed: Error: Valkey is away`
    )
  })

  it('wakes a refused phone once, then only the member’s other devices', async function () {
    const refused = await register('Hc', 'ios')
    const good = await register('Hc', 'android')
    refusing.add(refused)
    await post('P', members, seal('P', members, membersKey, 'post', text('1')))
    expect(sent.map(item => item.to.id).sort()).deep.equals(
      [refused, good].sort()
    )
    await next('a refused phone, sent to once')
    // Refused for good, and not tried again: the next wake skips it.
    expect(await pushQueue.client.zCard(pushQueue.queue.keys.later)).equals(0)
    await post('P', members, seal('P', members, membersKey, 'post', text('2')))
    expect(sent.map(item => item.to.id)).deep.equals([good])
  })

  it('answers a read whatever happens to its clear', async function () {
    failReads = true
    const made = await post(
      'P',
      members,
      seal('P', members, membersKey, 'post', text('read me'))
    )
    const answer = ok(
      await fixture.call('Hc', 'PUT', `/chat/conversations/${members}/read`, {
        seq: made.seq
      })
    )
    expect(answer).deep.equals({ seq: made.seq })
    expect(readsTold).equals(1)
    // Not moved: told nothing.
    failReads = false
    ok(
      await fixture.call('Hc', 'PUT', `/chat/conversations/${members}/read`, {
        seq: made.seq
      })
    )
    expect(readsTold).equals(1)
  })
})
