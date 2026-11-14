import { type ChildProcess, spawn } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import { utf8 } from '../../../common/chatCrypto/bytes'
import { newEpochKey } from '../../../common/chatCrypto/keys'
import { newMessageId } from '../../../common/chatCrypto/messageIds'
import { sealMessage } from '../../../common/chatCrypto/seal'
import { makeId } from '../../../common/ids'
import type { ChatWake, EventReminder } from '../../../common/push'
import { type TestPushQueue, testPushQueue } from '../../../test/pushQueueKit'
import { testRedisUrl } from '../../../test/scoreboardKit'
import { b64, ChatDevices, ok, type TestKeys } from '../../chat/chatTestDevices'
import { type ChatFixture, openChatFixture } from '../../chat/chatTestFixture'
import type { ChatMessageView } from '../../chat/messages'
import type { PushLogRecord } from '../log'
import { chatRequestOf, PUSH_GROUP } from '../queue'
import { firstTry } from '../requests'
import { dueReminders } from '../rsvpReminders'

/**
 * The push sender as the server forks it (`start.ts`), in its own process,
 * on the chat fixture's database and the test Valkey: it drains a chat
 * request the message route queued and a reminder request the sweep queued
 * into the log transport, settles both, and stops on SIGTERM.
 */
const ROOT = resolve(__dirname, '../../../..')

describe('the push sender process', function () {
  this.timeout(120000)
  let fixture: ChatFixture
  let pushQueue: TestPushQueue
  let dir = ''
  const held: Record<string, TestKeys> = {}

  before(async function () {
    pushQueue = await testPushQueue()
    const opened = await openChatFixture('sender', {
      wakes: async message => await pushQueue.add(chatRequestOf(message))
    })
    if (opened == null) {
      this.skip()
      return
    }
    fixture = opened
    const devices = new ChatDevices(fixture)
    for (const key of ['Hc', 'B']) held[key] = (await devices.enrol(key)).keys
    dir = mkdtempSync(join(tmpdir(), 'ts-push-sender-'))
  })

  after(async function () {
    if (dir !== '') rmSync(dir, { recursive: true, force: true })
    await pushQueue?.close()
    await fixture?.close()
  })

  let members: { id: string; key: Uint8Array } | undefined

  /** Hawks Members, with an epoch B and Hc both hold. */
  async function membersChat(): Promise<{ id: string; key: Uint8Array }> {
    if (members != null) return members
    const list = ok(
      await fixture.call('Hc', 'GET', '/chat/conversations')
    ) as Array<{ id: string; title: string | null }>
    const id = list.find(item => item.title === 'Hawks Members')!.id
    const devices = new ChatDevices(fixture)
    const key = newEpochKey()
    ok(
      await fixture.call(
        'Hc',
        'POST',
        `/chat/conversations/${id}/epochs`,
        devices.epochBody({
          conversationId: id,
          epoch: 1,
          creator: held.Hc,
          epochKey: key,
          previousEpochKey: null,
          recipients: await devices.recipients('Hc', id, 'eligible')
        })
      ),
      201
    )
    members = { id, key }
    return members
  }

  /** B posts `body` to Hawks Members; answers the stored message. */
  async function post(body: string): Promise<ChatMessageView> {
    const chat = await membersChat()
    const messageId = newMessageId()
    const sealed = sealMessage({
      conversationId: chat.id,
      epoch: 1,
      messageId,
      senderUserId: held.B.userId,
      kind: 'post',
      epochKey: chat.key,
      plaintext: utf8(
        JSON.stringify({ type: 'text', body, mentions: [], attachments: [] })
      ),
      identitySecretKey: held.B.identity.secretKey
    })
    return ok(
      await fixture.call(
        'B',
        'POST',
        `/chat/conversations/${chat.id}/messages`,
        {
          id: messageId,
          epoch: 1,
          kind: 'post',
          senderIdentityId: held.B.identityId,
          nonce: b64(sealed.nonce),
          ciphertext: b64(sealed.ciphertext),
          signature: b64(sealed.signature)
        }
      ),
      201
    ) as ChatMessageView
  }

  it('drains chat and reminder requests into the log transport, and stops on SIGTERM', async function () {
    const logFile = join(dir, 'push.jsonl')
    writeFileSync(
      join(dir, 'serverConfig.json'),
      JSON.stringify({
        databaseUrl: fixture.url,
        workDir: join(dir, 'work'),
        redis: { url: testRedisUrl, prefix: pushQueue.prefix, caFile: '' },
        // A second's hold, from the config, as an end-to-end stack sets it.
        push: { logFile, chatHoldSeconds: 1 }
      })
    )
    const hc = fixture.id('Hc')
    await fixture.db
      .insertInto('user_notification_settings')
      .values({ user_id: hc, messages: true, rsvp_events: true })
      .execute()
    await fixture.db
      .insertInto('push_registrations')
      .values({
        id: makeId('pushRegistration'),
        user_id: hc,
        session_id: fixture.sessionOf('Hc'),
        platform: 'android',
        address_key: `android-Hc-${'0'.repeat(32)}`,
        address: `android-Hc-${'0'.repeat(32)}`,
        environment: 'production'
      })
      .execute()

    // B posts to Hawks Members; the route queues the chat request.
    const chat = await membersChat()
    const messageId = newMessageId()
    const sealed = sealMessage({
      conversationId: chat.id,
      epoch: 1,
      messageId,
      senderUserId: held.B.userId,
      kind: 'post',
      epochKey: chat.key,
      plaintext: utf8(
        JSON.stringify({
          type: 'text',
          body: 'warm up at five',
          mentions: [],
          attachments: []
        })
      ),
      identitySecretKey: held.B.identity.secretKey
    })
    const posted = ok(
      await fixture.call(
        'B',
        'POST',
        `/chat/conversations/${chat.id}/messages`,
        {
          id: messageId,
          epoch: 1,
          kind: 'post',
          senderIdentityId: held.B.identityId,
          nonce: b64(sealed.nonce),
          ciphertext: b64(sealed.ciphertext),
          signature: b64(sealed.signature)
        }
      ),
      201
    ) as ChatMessageView

    // Hc said yes to a practice in an hour; the sweep queues its start.
    const eventId = makeId('teamEvent')
    await fixture.db
      .insertInto('team_events')
      .values({
        id: eventId,
        team_id: fixture.seed.teams.hawks,
        title: 'Batting cage',
        start_at: new Date(Date.now() + 60 * 60 * 1000),
        timezone: 'America/Los_Angeles',
        status: 'scheduled'
      })
      .execute()
    await fixture.db
      .insertInto('team_event_rsvps')
      .values({ event_id: eventId, user_id: hc, response: 'yes' })
      .execute()
    for (const request of await dueReminders(fixture.db, new Date()))
      await pushQueue.add(request)
    expect(await pushQueue.client.xLen(pushQueue.queue.keys.requests)).at.least(
      2
    )

    const sender: ChildProcess = spawn(
      process.execPath,
      ['-r', 'sucrase/register', join(ROOT, 'src/server/push/sender/start.ts')],
      {
        cwd: dir,
        env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') },
        stdio: ['ignore', 'pipe', 'pipe']
      }
    )
    let said = ''
    const hear = (chunk: Buffer): void => {
      said += chunk.toString('utf8')
    }
    sender.stdout?.on('data', hear)
    sender.stderr?.on('data', hear)
    const exited = new Promise<number | null>(resolve => {
      sender.once('exit', code => {
        resolve(code)
      })
    })
    const records = (): PushLogRecord[] => {
      let text = ''
      try {
        text = readFileSync(logFile, 'utf8')
      } catch {
        return []
      }
      return text
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as PushLogRecord)
    }
    try {
      const deadline = Date.now() + 30000
      while (records().length < 2) {
        if (Date.now() > deadline)
          throw new Error(`the sender sent ${records().length}: ${said}`)
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const payloads = records().map(record => {
        expect(record.userId).equals(hc)
        if (record.message.platform !== 'android')
          throw new Error('not an Android message')
        return JSON.parse(record.message.data.payload) as
          ChatWake | EventReminder
      })
      const wake = payloads.find(payload => payload.t === 'chat')!
      expect(wake).include({ u: hc, c: chat.id, dm: false })
      // Sent once its hold was over, and Hc marked woken for it.
      expect(await pushQueue.queue.wokenAt(hc, chat.id)).equals(posted.seq)
      const reminder = payloads.find(payload => payload.t === 'event')!
      expect(reminder).include({
        u: hc,
        title: 'Batting cage',
        tag: `event:${eventId}`
      })
      // Both settled: nothing left in the stream or pending.
      const settled = Date.now() + 10000
      while ((await pushQueue.client.xLen(pushQueue.queue.keys.requests)) > 0) {
        if (Date.now() > settled) throw new Error('never settled')
        await new Promise(resolve => setTimeout(resolve, 100))
      }
      const pending = await pushQueue.client.xPending(
        pushQueue.queue.keys.requests,
        PUSH_GROUP
      )
      expect(Number(pending.pending)).equals(0)
    } finally {
      sender.kill('SIGTERM')
    }
    const stoppedBy = Date.now()
    expect(await exited).equals(0)
    expect(Date.now() - stoppedBy).lessThan(7000)
    expect(said).match(/push sender: started/)
    expect(said).match(/push sender: sent 1 RSVP reminder\(s\) for teamEvent /)
    expect(said).match(/push sender: stopped on SIGTERM/)
  })

  it('lets go of a chat request too old to wake anybody, and of a reminder for an event already started', async function () {
    const stale = await testPushQueue()
    const home = mkdtempSync(join(tmpdir(), 'ts-push-sender-stale-'))
    const logFile = join(home, 'push.jsonl')
    const hc = fixture.id('Hc')
    try {
      writeFileSync(
        join(home, 'serverConfig.json'),
        JSON.stringify({
          databaseUrl: fixture.url,
          workDir: join(home, 'work'),
          redis: { url: testRedisUrl, prefix: stale.prefix, caFile: '' },
          push: { logFile, chatHoldSeconds: 0 }
        })
      )
      await fixture.db
        .insertInto('user_notification_settings')
        .values({ user_id: hc, messages: true, rsvp_events: true })
        .onConflict(oc => oc.doNothing())
        .execute()
      await fixture.db
        .insertInto('push_registrations')
        .values({
          id: makeId('pushRegistration'),
          user_id: hc,
          session_id: fixture.sessionOf('Hc'),
          platform: 'android',
          address_key: `android-Hc-${'0'.repeat(32)}`,
          address: `android-Hc-${'0'.repeat(32)}`,
          environment: 'production'
        })
        .onConflict(oc => oc.doNothing())
        .execute()
      const hour = 60 * 60 * 1000
      // Queued two hours ago, while the sender was down.
      const late = await post('queued long ago')
      await stale.client.xAdd(
        stale.queue.keys.requests,
        `${Date.now() - 2 * hour}-0`,
        { r: JSON.stringify(firstTry(chatRequestOf(late))) }
      )
      // Queued now, for a post made two hours ago.
      const old = await post('posted long ago')
      await fixture.db
        .updateTable('chat_messages')
        .set({ created_at: new Date(Date.now() - 2 * hour) })
        .where('id', '=', old.id)
        .execute()
      await stale.add(chatRequestOf(old))
      // A practice that started ten minutes ago, which Hc said yes to.
      const started = makeId('teamEvent')
      const startAt = new Date(Date.now() - 10 * 60 * 1000)
      await fixture.db
        .insertInto('team_events')
        .values({
          id: started,
          team_id: fixture.seed.teams.hawks,
          title: 'Long toss',
          start_at: startAt,
          timezone: 'America/Los_Angeles',
          status: 'scheduled'
        })
        .execute()
      await fixture.db
        .insertInto('team_event_rsvps')
        .values({ event_id: started, user_id: hc, response: 'yes' })
        .execute()
      await stale.add({
        t: 'reminder',
        kind: 'teamEvent',
        eventId: started,
        startAt: startAt.toISOString()
      })
      // And a fresh post, which does wake Hc.
      const fresh = await post('just now')
      await stale.add(chatRequestOf(fresh))

      const sender = spawn(
        process.execPath,
        [
          '-r',
          'sucrase/register',
          join(ROOT, 'src/server/push/sender/start.ts')
        ],
        {
          cwd: home,
          env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      let said = ''
      const hear = (chunk: Buffer): void => {
        said += chunk.toString('utf8')
      }
      sender.stdout.on('data', hear)
      sender.stderr.on('data', hear)
      const exited = new Promise<number | null>(resolve => {
        sender.once('exit', resolve)
      })
      try {
        const deadline = Date.now() + 30000
        while ((await stale.client.xLen(stale.queue.keys.requests)) > 0) {
          if (Date.now() > deadline) throw new Error(`never drained: ${said}`)
          await new Promise(resolve => setTimeout(resolve, 100))
        }
      } finally {
        sender.kill('SIGTERM')
      }
      expect(await exited).equals(0)
      const records = readFileSync(logFile, 'utf8')
        .split('\n')
        .filter(line => line !== '')
        .map(line => JSON.parse(line) as PushLogRecord)
      // Only the fresh post woke anybody.
      expect(
        records.map(record =>
          record.message.platform === 'android'
            ? (JSON.parse(record.message.data.payload) as ChatWake).seq
            : null
        )
      ).deep.equals([fresh.seq])
      // Let go of, not given up on: nothing dead, nothing to try again.
      expect(await stale.client.xLen(stale.queue.keys.dead)).equals(0)
      expect(await stale.client.zCard(stale.queue.keys.later)).equals(0)
      expect(
        Number(
          (await stale.client.xPending(stale.queue.keys.requests, PUSH_GROUP))
            .pending
        )
      ).equals(0)
      expect(said).match(
        /push sender: let go of \d+-0, queued \S+: too old to wake anybody/
      )
      expect(said).include(
        `push: no wake for ${old.conversationId} seq ${old.seq}, posted `
      )
      expect(
        await fixture.db
          .selectFrom('push_reminders_sent')
          .select('user_id')
          .where('event_id', '=', started)
          .execute()
      ).deep.equals([])
    } finally {
      rmSync(home, { recursive: true, force: true })
      await stale.close()
    }
  })

  it('exits 1 when it cannot start, for its supervisor to start it again', async function () {
    const broken = mkdtempSync(join(tmpdir(), 'ts-push-sender-broken-'))
    try {
      writeFileSync(
        join(broken, 'serverConfig.json'),
        JSON.stringify({
          databaseUrl: fixture.url,
          workDir: join(broken, 'work'),
          redis: {
            url: testRedisUrl,
            prefix: pushQueue.prefix,
            caFile: join(broken, 'no-such-ca.pem')
          }
        })
      )
      const sender = spawn(
        process.execPath,
        [
          '-r',
          'sucrase/register',
          join(ROOT, 'src/server/push/sender/start.ts')
        ],
        {
          cwd: broken,
          env: { ...process.env, NODE_PATH: join(ROOT, 'node_modules') },
          stdio: ['ignore', 'pipe', 'pipe']
        }
      )
      let said = ''
      sender.stderr.on('data', (chunk: Buffer) => {
        said += chunk.toString('utf8')
      })
      const code = await new Promise<number | null>(resolve => {
        sender.once('exit', resolve)
      })
      expect(code).equals(1)
      expect(said).match(/push sender: Error: redis\.caFile .* cannot be read/)
    } finally {
      rmSync(broken, { recursive: true, force: true })
    }
  })
})
