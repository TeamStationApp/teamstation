import { type ChildProcess, fork } from 'node:child_process'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'
import { join } from 'node:path'

import { expect } from 'chai'
import { type Kysely, sql } from 'kysely'
import { after, before, describe, it } from 'mocha'
import { Pool } from 'pg'
import WebSocket from 'ws'

import { utf8 } from '../../common/chatCrypto/bytes'
import { newEpochKey } from '../../common/chatCrypto/keys'
import { newMessageId } from '../../common/chatCrypto/messageIds'
import { sealMessage } from '../../common/chatCrypto/seal'
import type { GameSocketReply } from '../../common/gameSocket'
import { makeId } from '../../common/ids'
import { testDatabaseUrl } from '../../migrate/testDatabase'
import { FEED_APPLICATION_NAME, PostgresFeed } from '../changeFeed/postgresFeed'
import { b64, ChatDevices, ok, type TestKeys } from '../chat/chatTestDevices'
import { type ChatFixture, openChatFixture } from '../chat/chatTestFixture'
import { notifyChat, notifyChatUser } from '../chat/membershipLog'
import { mayPost } from '../chat/messages'
import type { Database } from '../db/database'
import {
  ChatFanout,
  type ChatSubscriber,
  type MemberReader,
  readMembers
} from './chatFanout'
import { attachGameSocket, type GameSocketHandle } from './gameSocket'

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/** A `ws` client that keeps every frame it is sent. */
interface Socket {
  ws: WebSocket
  frames: GameSocketReply[]
  send: (frame: unknown) => void
  /** The first frame from `from` on that matches. */
  next: (
    match: (frame: GameSocketReply) => boolean,
    from?: number,
    ms?: number
  ) => Promise<GameSocketReply>
  /** The frames from `from` on that match. */
  all: (match: (frame: GameSocketReply) => boolean, from?: number) => unknown[]
}

const isChat = (frame: GameSocketReply): boolean =>
  frame.type === 'chat' ||
  frame.type === 'chatUser' ||
  frame.type === 'chatTyping' ||
  frame.type === 'resync'

/**
 * U9: chat on `/socket`, on real HTTP servers and a scratch database. Worker
 * A runs in this process; worker B is another process
 * (`chatSocketTestWorker.ts`) with its own `LISTEN chat_changes`. Posts go
 * through the chat routes in this process.
 */
describe('chat on the socket (U9)', function () {
  this.timeout(120000)
  let fixture: ChatFixture
  let db: Kysely<Database>
  let devices: ChatDevices
  let adminPool: Pool
  let serverA: Server
  let socketA: GameSocketHandle
  let urlA = ''
  let urlB = ''
  let workerB: ChildProcess | undefined
  /** Worker A's clock: the fixture's now, moved on by the typing tests. */
  let ahead = 0
  const failingTyping = new Set<string>()
  const logged: string[] = []
  let reads = 0
  const opened: Socket[] = []
  let held: { device: unknown; keys: TestKeys }
  let members = ''
  let fans = ''
  let announcements = ''
  let epochKey: Uint8Array

  before(async function () {
    const made = await openChatFixture('socket')
    if (made == null) {
      this.skip()
      return
    }
    fixture = made
    db = fixture.db
    devices = new ChatDevices(fixture)
    adminPool = new Pool({ connectionString: testDatabaseUrl })

    const counting: MemberReader = async (reader, conversationId) => {
      reads++
      return await readMembers(reader, conversationId)
    }
    serverA = createServer()
    socketA = attachGameSocket(serverA, db, fixture.url, {
      stopSignals: null,
      clock: () => fixture.now.getTime() + ahead,
      log: message => logged.push(message),
      chat: {
        readMembers: counting,
        log: message => logged.push(message)
      },
      checkTyping: async (conversationId, check) => {
        if (failingTyping.has(conversationId))
          throw new Error('out of connections')
        return await check()
      }
    })
    await socketA.chat.listening
    await new Promise<void>(resolve => serverA.listen(0, '127.0.0.1', resolve))
    urlA = `ws://127.0.0.1:${(serverA.address() as AddressInfo).port}/socket`

    workerB = fork(join(__dirname, 'chatSocketTestWorker.ts'), [fixture.url], {
      execArgv: ['-r', 'sucrase/register'],
      stdio: ['ignore', 'ignore', 'pipe', 'ipc']
    })
    // Its own log (a lost listen, below) is kept, and shown only if it dies.
    let saidB = ''
    workerB.stderr?.on('data', (data: Buffer) => {
      saidB += data.toString('utf8')
    })
    const port = await new Promise<number>((resolve, reject) => {
      workerB?.once('message', message => {
        resolve((message as { port: number }).port)
      })
      workerB?.once('exit', code => {
        reject(new Error(`worker B exited with ${String(code)}: ${saidB}`))
      })
    })
    urlB = `ws://127.0.0.1:${port}/socket`

    const list = ok(
      await fixture.call('Hc', 'GET', '/chat/conversations')
    ) as Array<{ id: string; title: string }>
    members = list.find(chat => chat.title === 'Hawks Members')?.id ?? ''
    fans = list.find(chat => chat.title === 'Hawks Fans')?.id ?? ''
    const parents = ok(
      await fixture.call('A', 'GET', '/chat/conversations')
    ) as Array<{ id: string; title: string }>
    announcements =
      parents.find(chat => chat.title === 'QPLL Spring 2027 Announcements')
        ?.id ?? ''
    expect(members).not.equals('')
    expect(fans).not.equals('')
    expect(announcements).not.equals('')
  })

  after(async function () {
    for (const socket of opened) socket.ws.terminate()
    if (workerB != null && workerB.exitCode == null) {
      const exited = new Promise(resolve => workerB?.once('exit', resolve))
      workerB.send('close')
      await exited
    }
    await socketA?.close()
    serverA?.close()
    await adminPool?.end()
    await fixture?.close()
  })

  async function connect(url: string, who: string): Promise<Socket> {
    const ws = new WebSocket(url, {
      headers: { authorization: `Bearer ${fixture.tokenOf(who)}` }
    })
    const frames: GameSocketReply[] = []
    ws.on('message', data => {
      frames.push(
        JSON.parse((data as Buffer).toString('utf8')) as GameSocketReply
      )
    })
    await new Promise<void>((resolve, reject) => {
      ws.once('open', () => {
        resolve()
      })
      ws.once('error', reject)
    })
    const socket: Socket = {
      ws,
      frames,
      send: frame => {
        ws.send(JSON.stringify(frame))
      },
      next: async (match, from = 0, ms = 3000) => {
        const deadline = Date.now() + ms
        for (;;) {
          const found = frames.slice(from).find(match)
          if (found != null) return found
          if (Date.now() > deadline)
            throw new Error(`No such frame in ${JSON.stringify(frames)}`)
          await wait(20)
        }
      },
      all: (match, from = 0) => frames.slice(from).filter(match)
    }
    opened.push(socket)
    return socket
  }

  /** A message hint, as the writer's transaction sends it. */
  async function hint(
    conversationId: string,
    kind: 'message' | 'members' | 'read' = 'message',
    seq?: number
  ): Promise<void> {
    await db.transaction().execute(async trx => {
      await notifyChat(trx, conversationId, kind, seq)
    })
  }

  /** Sends a typing hint and waits for its answer. */
  async function typing(
    socket: Socket,
    conversationId: string
  ): Promise<GameSocketReply> {
    const id = `t${Math.random()}`
    const from = socket.frames.length
    socket.send({ type: 'typing', conversationId, id })
    return await socket.next(frame => 'id' in frame && frame.id === id, from)
  }

  async function counts(): Promise<Record<string, number>> {
    const { rows } = await sql<Record<string, number>>`
      select
        (select count(*)::int from chat_messages) as messages,
        (select count(*)::int from chat_membership_log) as log,
        (select count(*)::int from chat_dirty) as dirty,
        (select count(*)::int from audit_log) as audit
    `.execute(db)
    return rows[0]
  }

  describe('the two workers', function () {
    it('passes a post on worker A to a member on worker B, and never to anybody else', async function () {
      held = await devices.enrol('Hc')
      epochKey = newEpochKey()
      const recipients = await devices.recipients('Hc', members, 'eligible')
      ok(
        await fixture.call(
          'Hc',
          'POST',
          `/chat/conversations/${members}/epochs`,
          devices.epochBody({
            conversationId: members,
            epoch: 1,
            creator: held.keys,
            epochKey,
            previousEpochKey: null,
            recipients
          })
        ),
        201
      )

      const coachOnB = await connect(urlB, 'Hc')
      const fanOnB = await connect(urlB, 'F')
      const parentOnA = await connect(urlA, 'B')
      const fanOnA = await connect(urlA, 'F')

      const id = newMessageId()
      const sealed = sealMessage({
        conversationId: members,
        epoch: 1,
        messageId: id,
        senderUserId: held.keys.userId,
        kind: 'post',
        epochKey,
        plaintext: utf8(
          JSON.stringify({
            type: 'text',
            body: 'over the wire',
            mentions: [],
            attachments: []
          })
        ),
        identitySecretKey: held.keys.identity.secretKey
      })
      const posted = ok(
        await fixture.call(
          'Hc',
          'POST',
          `/chat/conversations/${members}/messages`,
          {
            id,
            epoch: 1,
            kind: 'post',
            senderIdentityId: held.keys.identityId,
            nonce: b64(sealed.nonce),
            ciphertext: b64(sealed.ciphertext),
            signature: b64(sealed.signature)
          }
        ),
        201
      )
      const isPost = (frame: GameSocketReply): boolean =>
        frame.type === 'chat' &&
        frame.conversationId === members &&
        frame.kind === 'message'
      const onB = await coachOnB.next(isPost)
      expect(onB).deep.include({
        type: 'chat',
        conversationId: members,
        kind: 'message',
        seq: posted.seq
      })
      expect(Number.isNaN(Date.parse((onB as { at: string }).at))).equals(false)
      // Worker A's own member hears it too.
      expect(await parentOnA.next(isPost)).deep.include({ seq: posted.seq })
      // Nothing of the message itself travels.
      expect(JSON.stringify(coachOnB.frames)).not.include(
        b64(sealed.ciphertext)
      )

      // The fan's sockets work, on both workers: Hawks Fans reaches them.
      await hint(fans, 'message', 1)
      const isFans = (frame: GameSocketReply): boolean =>
        frame.type === 'chat' && frame.conversationId === fans
      await fanOnB.next(isFans)
      await fanOnA.next(isFans)
      // ...and the post in Hawks Members never did.
      expect(fanOnB.all(frame => isPost(frame))).deep.equals([])
      expect(fanOnA.all(frame => isPost(frame))).deep.equals([])
      // The coach is in Hawks Fans as staff; the parent is not.
      await coachOnB.next(isFans)
      expect(parentOnA.all(isFans)).deep.equals([])
    })

    it('tells a user their own devices and links changed, on every worker', async function () {
      const onA = await connect(urlA, 'Hc')
      const onB = await connect(urlB, 'Hc')
      const other = await connect(urlA, 'B')
      await db.transaction().execute(async trx => {
        await notifyChatUser(trx, fixture.id('Hc'), 'devices')
        await notifyChatUser(trx, fixture.id('Hc'), 'link')
      })
      const isUser = (frame: GameSocketReply): boolean =>
        frame.type === 'chatUser'
      await onA.next(
        frame => frame.type === 'chatUser' && frame.kind === 'link'
      )
      await onB.next(
        frame => frame.type === 'chatUser' && frame.kind === 'link'
      )
      expect(onA.all(isUser)).deep.equals([
        { type: 'chatUser', kind: 'devices' },
        { type: 'chatUser', kind: 'link' }
      ])
      expect(other.all(isUser)).deep.equals([])
    })
  })

  describe('registration', function () {
    it('registers a signed-in socket and lets it go on close, but not a machine token', async function () {
      const before = socketA.chat.size()
      const signedIn = await connect(urlA, 'C')
      expect(socketA.chat.size()).equals(before + 1)
      await fixture.apiToken('C-machine', 'C')
      const machine = await connect(urlA, 'C-machine')
      expect(socketA.chat.size()).equals(before + 1)
      const answer = await typing(machine, members)
      expect(answer).deep.include({
        type: 'error',
        conversationId: members,
        code: 'forbidden'
      })
      // The game protocol is unchanged on it.
      machine.send({ type: 'ping', id: 'p1' })
      await machine.next(frame => frame.type === 'pong')
      signedIn.ws.close()
      for (let i = 0; i < 100 && socketA.chat.size() > before; i++)
        await wait(20)
      expect(socketA.chat.size()).equals(before)
    })
  })

  describe('member sets', function () {
    it('reads a conversation once, and again after a members hint', async function () {
      const hearer = await connect(urlA, 'C')
      const isMembers = (seq: number) => (frame: GameSocketReply) =>
        frame.type === 'chat' &&
        frame.conversationId === members &&
        'seq' in frame &&
        frame.seq === seq
      reads = 0
      await hint(members, 'read', 101)
      await hearer.next(isMembers(101))
      await hint(members, 'read', 102)
      await hearer.next(isMembers(102))
      expect(reads).lessThanOrEqual(1)
      expect(socketA.chat.cached()).include(members)

      // D, not on Hawks, is connected and hears nothing of it yet.
      const newcomer = await connect(urlA, 'D')
      await hint(members, 'read', 103)
      await hearer.next(isMembers(103))
      await wait(100)
      expect(newcomer.all(isChat)).deep.equals([])

      // D joins Hawks: the reconciler's join notifies `members`, which drops
      // the set, so D hears the next hint.
      const hawks = fixture.seed.teams.hawks
      await db
        .insertInto('memberships')
        .values({
          id: makeId('membership'),
          user_id: fixture.id('D'),
          team_id: hawks,
          role: 'member',
          is_player: false,
          jersey: null,
          joined_at: new Date(),
          granted_by_link_id: null
        })
        .execute()
      const from = hearer.frames.length
      reads = 0
      await fixture.drain()
      const joined = await hearer.next(
        frame =>
          frame.type === 'chat' &&
          frame.conversationId === members &&
          frame.kind === 'members',
        from
      )
      expect(joined).not.have.property('seq')
      // D is a member by the time the hint is read, so hears it too.
      await newcomer.next(
        frame =>
          frame.type === 'chat' &&
          frame.conversationId === members &&
          frame.kind === 'members'
      )
      await hint(members, 'read', 104)
      await newcomer.next(isMembers(104))
      expect(reads).greaterThanOrEqual(1)
    })
  })

  describe('typing', function () {
    it('relays typing to the other members only, at most once in three seconds per socket, and stores nothing', async function () {
      const typist = await connect(urlA, 'Hc')
      const typistOnB = await connect(urlB, 'Hc')
      const parentOnB = await connect(urlB, 'B')
      const parentOnA = await connect(urlA, 'C')
      const fan = await connect(urlB, 'F')
      ahead += 10_000
      const was = await counts()
      expect(await typing(typist, members)).deep.include({
        type: 'typed',
        conversationId: members
      })
      const typed = {
        type: 'chatTyping',
        conversationId: members,
        userId: fixture.id('Hc')
      }
      const isTyping = (frame: GameSocketReply): boolean =>
        frame.type === 'chatTyping'
      expect(await parentOnB.next(isTyping)).deep.equals(typed)
      expect(await parentOnA.next(isTyping)).deep.equals(typed)
      await wait(150)
      // Never to the typist, on any of their sockets, nor to a non-member.
      expect(typist.all(isTyping)).deep.equals([])
      expect(typistOnB.all(isTyping)).deep.equals([])
      expect(fan.all(isTyping)).deep.equals([])
      // Not stored: no message, log row, mark or audit row.
      expect(await counts()).deep.equals(was)

      // Again within three seconds from the same socket: refused, unsent.
      ahead += 2_999
      expect(await typing(typist, members)).deep.include({
        type: 'error',
        conversationId: members,
        code: 'tooMany'
      })
      // Another socket of the same person has its own allowance.
      expect(await typing(typistOnB, members)).deep.include({ type: 'typed' })
      ahead += 1
      expect(await typing(typist, members)).deep.include({ type: 'typed' })
      await wait(150)
      expect(parentOnB.all(isTyping)).lengthOf(3)
    })

    it('refuses Announcement readers, non-members and closed chats, and lets season staff type', async function () {
      const reader = await connect(urlA, 'A')
      const staff = await connect(urlA, 'S')
      const fan = await connect(urlA, 'F')
      ahead += 10_000
      expect(await typing(reader, announcements)).deep.include({
        type: 'error',
        conversationId: announcements,
        code: 'forbidden'
      })
      expect(
        await mayPost(db, announcements, fixture.id('A'), new Date())
      ).equals('reader')
      expect(await typing(staff, announcements)).deep.include({
        type: 'typed'
      })
      expect(
        await reader.next(
          frame =>
            frame.type === 'chatTyping' &&
            frame.conversationId === announcements
        )
      ).deep.include({ userId: fixture.id('S') })
      // A fan is in no Announcements chat, nor in Hawks Members.
      expect(await typing(fan, members)).deep.include({
        type: 'error',
        code: 'notFound'
      })
      ahead += 3_000
      expect(await typing(fan, 'cnv_nothing_here')).deep.include({
        type: 'error',
        code: 'notFound'
      })
      expect(
        await mayPost(db, 'cnv_nothing_here', fixture.id('F'), new Date())
      ).equals('stranger')

      // A closed DM: its members may read it, not type in it.
      const dm = ok(
        await fixture.call('Hc', 'POST', '/chat/dms', {
          userIds: [fixture.id('B')]
        }),
        201
      ) as { id: string }
      await db
        .updateTable('chat_conversations')
        .set({ closed_at: new Date() })
        .where('id', '=', dm.id)
        .execute()
      const parent = await connect(urlA, 'B')
      expect(await typing(parent, dm.id)).deep.include({
        type: 'error',
        code: 'forbidden'
      })
    })

    it('answers a check that fails with internal, and keeps going', async function () {
      const typist = await connect(urlA, 'Hk')
      ahead += 10_000
      failingTyping.add(members)
      expect(await typing(typist, members)).deep.include({
        type: 'error',
        code: 'internal'
      })
      failingTyping.delete(members)
      expect(logged.some(line => line.includes('out of connections'))).equals(
        true
      )
      ahead += 3_000
      expect(await typing(typist, members)).deep.include({ type: 'typed' })
      // A frame that does not read is refused as before.
      typist.send({ type: 'typing', id: 'x' })
      await typist.next(
        frame => frame.type === 'error' && frame.code === 'malformed'
      )
    })
  })

  describe('a lost listen', function () {
    it('tells the worker’s chat sockets to resync once the feed returns, a second later', async function () {
      const hearer = await connect(urlA, 'C')
      const onB = await connect(urlB, 'C')
      await hint(members, 'read', 201)
      await hearer.next(frame => 'seq' in frame && frame.seq === 201)
      const from = hearer.frames.length
      const cutAt = Date.now()
      await adminPool.query(
        `select pg_terminate_backend(pid) from pg_stat_activity
         where datname = $1 and application_name = $2`,
        [fixture.url.replace(/.*\//, ''), FEED_APPLICATION_NAME]
      )
      await hearer.next(frame => frame.type === 'resync', from)
      const returnedAt = Date.now()
      expect(returnedAt - cutAt).greaterThanOrEqual(700)
      expect(returnedAt - cutAt).lessThan(3000)
      // Every set was dropped: a members hint may have been missed.
      expect(socketA.chat.cached()).deep.equals([])
      expect(logged.some(line => line.includes('lost the feed'))).equals(true)
      await onB.next(frame => frame.type === 'resync')
      // Back in place, the next hint is heard.
      await hint(members, 'read', 301)
      await hearer.next(frame => 'seq' in frame && frame.seq === 301)
    })
  })

  describe('the fanout alone', function () {
    const subscriber = (
      userId: string
    ): ChatSubscriber & { sent: unknown[] } => {
      const sent: unknown[] = []
      return { userId, sent, send: frame => sent.push(frame) }
    }
    let feed: PostgresFeed

    before(function () {
      feed = new PostgresFeed({
        databaseUrl: fixture.url,
        log: () => undefined
      })
    })

    after(async function () {
      await feed.close()
    })

    it('reads nothing with nobody connected, keeps no failed read, and keeps a bounded cache', async function () {
      let calls = 0
      let fail = false
      const lines: string[] = []
      const fanout = new ChatFanout({
        db,
        feed,
        cacheSize: 1,
        log: line => lines.push(line),
        readMembers: async (reader, conversationId) => {
          calls++
          if (fail) throw new Error('database away')
          return await readMembers(reader, conversationId)
        },
        now: () => new Date('2027-04-10T12:00:00Z')
      })
      await fanout.listening
      await fanout.deliver(JSON.stringify({ c: members, k: 'message', seq: 1 }))
      expect(calls).equals(0)

      const coach = subscriber(fixture.id('Hc'))
      fanout.add(coach)
      fanout.add(coach)
      expect(fanout.size()).equals(1)
      fail = true
      fanout.notified(JSON.stringify({ c: members, k: 'message', seq: 2 }))
      for (let i = 0; i < 50 && lines.length === 0; i++) await wait(10)
      expect(lines[0]).match(/database away/)
      expect(fanout.cached()).deep.equals([])
      fail = false
      await fanout.deliver(JSON.stringify({ c: members, k: 'message', seq: 3 }))
      expect(coach.sent).deep.equals([
        {
          type: 'chat',
          conversationId: members,
          kind: 'message',
          seq: 3,
          at: '2027-04-10T12:00:00.000Z'
        }
      ])
      await fanout.deliver(JSON.stringify({ c: fans, k: 'epoch' }))
      expect(fanout.cached()).deep.equals([fans])
      await fanout.deliver(JSON.stringify({ c: fans, k: 'grant' }))
      expect(calls).equals(3)
      expect(coach.sent.slice(1)).deep.equals([
        {
          type: 'chat',
          conversationId: fans,
          kind: 'epoch',
          at: '2027-04-10T12:00:00.000Z'
        },
        {
          type: 'chat',
          conversationId: fans,
          kind: 'grant',
          at: '2027-04-10T12:00:00.000Z'
        }
      ])

      await fanout.deliver('not json')
      await fanout.deliver(JSON.stringify({ c: members, k: 'weather' }))
      await fanout.deliver(JSON.stringify({ c: members, k: 'typing' }))
      expect(lines.filter(line => line.includes('ignoring'))).lengthOf(3)
      fanout.notified(undefined)

      fanout.remove(coach)
      fanout.remove(coach)
      expect(fanout.size()).equals(0)
      await fanout.close()
      fanout.notified(JSON.stringify({ c: members, k: 'message', seq: 4 }))
      expect(coach.sent).lengthOf(3)
    })

    describe('with no connection to be had in time', function () {
      const poolTimeout = new Error('timeout exceeded when trying to connect')
      /** A fan-out whose reads fail until `recover` is called. */
      const starved = (
        failure: Error = poolTimeout
      ): {
        fanout: ChatFanout
        lines: string[]
        calls: () => number
        recover: () => void
      } => {
        let failing = true
        let calls = 0
        const lines: string[] = []
        const fanout = new ChatFanout({
          db,
          feed,
          retryMs: 20,
          log: line => lines.push(line),
          readMembers: async (reader, conversationId) => {
            calls++
            if (failing) throw failure
            return await readMembers(reader, conversationId)
          }
        })
        return {
          fanout,
          lines,
          calls: () => calls,
          recover: () => {
            failing = false
          }
        }
      }

      it('tells the conversation’s members to resync once it can read them, and nobody else', async function () {
        const f = starved()
        await f.fanout.listening
        const coach = subscriber(fixture.id('Hc'))
        const stranger = subscriber('someone-not-in-it')
        f.fanout.add(coach)
        f.fanout.add(stranger)
        await f.fanout.deliver(
          JSON.stringify({ c: members, k: 'message', seq: 1 })
        )
        // A second hint while one is owed adds no second resync.
        await f.fanout.deliver(
          JSON.stringify({ c: members, k: 'message', seq: 2 })
        )
        expect(coach.sent).deep.equals([])
        expect(f.lines.filter(line => line.includes('owing'))).to.have.length(1)
        // Still failing: it goes on trying.
        const before = f.calls()
        for (let i = 0; i < 100 && f.calls() < before + 2; i++) await wait(10)
        expect(f.calls()).greaterThanOrEqual(before + 2)
        f.recover()
        for (let i = 0; i < 100 && coach.sent.length === 0; i++) await wait(10)
        expect(coach.sent).deep.equals([{ type: 'resync' }])
        expect(stranger.sent).deep.equals([])
        await f.fanout.close()
      })

      it('owes nothing for a typing hint', async function () {
        const f = starved()
        await f.fanout.listening
        const coach = subscriber(fixture.id('Hc'))
        f.fanout.add(coach)
        await f.fanout.deliver(
          JSON.stringify({ c: members, k: 'typing', u: fixture.id('Hc') })
        )
        f.recover()
        await wait(60)
        expect(coach.sent).deep.equals([])
        await f.fanout.close()
      })

      it('stops owing when closed', async function () {
        const f = starved()
        await f.fanout.listening
        f.fanout.add(subscriber(fixture.id('Hc')))
        await f.fanout.deliver(JSON.stringify({ c: members, k: 'read' }))
        await f.fanout.close()
        const counted = f.calls()
        await wait(60)
        expect(f.calls()).equals(counted)
      })

      it('still throws any other failure, owing nothing', async function () {
        const f = starved(new Error('database away'))
        await f.fanout.listening
        const coach = subscriber(fixture.id('Hc'))
        f.fanout.add(coach)
        let failure: unknown
        await f.fanout
          .deliver(JSON.stringify({ c: members, k: 'read' }))
          .catch((error: unknown) => {
            failure = error
          })
        expect(String(failure)).contains('database away')
        expect(f.lines.filter(line => line.includes('owing'))).deep.equals([])
        await f.fanout.close()
      })

      it('logs a failure of another kind while paying, and stops', async function () {
        let reads = 0
        const lines: string[] = []
        const fanout = new ChatFanout({
          db,
          feed,
          retryMs: 20,
          log: line => lines.push(line),
          readMembers: async () => {
            reads++
            throw reads === 1 ? poolTimeout : new Error('database away')
          }
        })
        await fanout.listening
        fanout.add(subscriber(fixture.id('Hc')))
        await fanout.deliver(JSON.stringify({ c: members, k: 'read' }))
        await wait(100)
        expect(reads).equals(2)
        expect(lines.some(line => line.includes('database away'))).equals(true)
        const counted = reads
        await wait(60)
        expect(reads).equals(counted)
        await fanout.close()
      })
    })

    it('logs to the console unless told otherwise', async function () {
      const fanout = new ChatFanout({ db, feed })
      await fanout.listening
      const had = console.error
      const seen: string[] = []
      console.error = (line: string) => seen.push(line)
      try {
        await fanout.deliver('nonsense')
      } finally {
        console.error = had
      }
      expect(seen[0]).match(/^chat socket: ignoring/)
      await fanout.close()
    })
  })
})

describe('the chat socket tests’ second worker', function () {
  this.timeout(60000)

  it('says why and exits with a failure when it cannot start', async function () {
    const worker = fork(
      join(__dirname, 'chatSocketTestWorker.ts'),
      [testDatabaseUrl],
      {
        execArgv: [
          '-r',
          'sucrase/register',
          '-r',
          join(__dirname, '../../test/refuseListen.cjs')
        ],
        stdio: ['ignore', 'ignore', 'pipe', 'ipc']
      }
    )
    let said = ''
    worker.stderr?.on('data', (data: Buffer) => {
      said += data.toString('utf8')
    })
    const code = await new Promise<number | null>(resolve => {
      worker.once('exit', resolve)
    })
    expect(code).equals(1)
    expect(said).contains('listen refused by the test')
  })
})
