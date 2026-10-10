import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, before, describe, it } from 'mocha'

import {
  type AckStatus,
  buildAssignment,
  type Credentials,
  decode,
  encode,
  keyBytes
} from './codec'
import {
  type Desired,
  DirectorSession,
  Link,
  main,
  RevisionCounter,
  run,
  type Step
} from './director'
import { fixtureCredentials } from './fixtures'
import { listen, Receiver } from './peer'

const one = fixtureCredentials('one')
const desiredA: Desired = {
  revision: 100n,
  assignment: buildAssignment(
    'gam_demoA',
    'Visitors at Pioneers',
    new Date('2026-09-21T18:00:00Z')
  )
}
const desiredB: Desired = {
  revision: 200n,
  assignment: buildAssignment(
    'gam_demoB',
    'Pioneers at Comets',
    new Date('2026-09-22T01:30:00Z')
  )
}

const makeReceiver = (
  overrides: Partial<ConstructorParameters<typeof Receiver>[0]> = {}
): Receiver =>
  new Receiver({
    instanceId: Buffer.alloc(16, 0xe1),
    credentials: one,
    consent: true,
    apply: () => 'applied',
    autoExpire: false,
    ...overrides
  })

/** A session talking straight to a receiver. */
class Pair {
  closed = false
  constructor(
    readonly session: DirectorSession,
    readonly receiver: Receiver,
    readonly connection = 1
  ) {}

  async pump(first: Step): Promise<void> {
    let step = first
    while (step.send.length > 0) {
      const next: Step = { send: [], close: false }
      for (const payload of step.send) {
        const reply = await this.receiver.handle(
          payload,
          this.connection,
          '192.0.2.10'
        )
        for (const answer of reply.replies) {
          const made = this.session.receive(answer)
          next.send.push(...made.send)
          next.close ||= made.close
        }
        if (reply.close) this.closed = true
      }
      if (next.close) this.closed = true
      step = next
    }
  }
}

const session = (
  desired: Desired | undefined,
  credentials: Credentials = one,
  instance = 0xd1
): DirectorSession =>
  new DirectorSession({
    instanceId: Buffer.alloc(16, instance),
    credentials,
    desired
  })

describe('the Director session', function () {
  it('discovers, assigns, renews, changes and releases', async function () {
    const receiver = makeReceiver()
    const pair = new Pair(session(desiredA), receiver)
    expect(pair.session.state).equals('discovering')
    await pair.pump(pair.session.begin())
    expect(pair.session.state).equals('applied')
    expect(pair.session.ackedRevision).equals(100n)
    expect(pair.session.consent).equals(true)
    expect(pair.session.holdsLease).equals(true)
    expect(pair.session.peerInstance).equals('e1'.repeat(16))
    await pair.pump(pair.session.tick())
    expect(pair.session.lastStatus).equals('applied')
    await pair.pump(pair.session.setDesired(desiredB))
    expect(receiver.override?.revision).equals(200n)
    await pair.pump(pair.session.setDesired(undefined))
    expect(pair.session.state).equals('released')
    expect(receiver.override).equals(undefined)
    await pair.pump(pair.session.tick())
    expect(pair.session.state).equals('released')
  })

  it('stays connected with nothing to assign until asked', async function () {
    const pair = new Pair(session(undefined), makeReceiver())
    await pair.pump(pair.session.begin())
    expect(pair.session.state).equals('connected')
    expect(pair.session.isBound).equals(true)
    await pair.pump(pair.session.tick())
    expect(pair.session.state).equals('connected')
    await pair.pump(pair.session.setDesired(desiredA))
    expect(pair.session.state).equals('applied')
  })

  it('asks a disabled peer again each tick, and a busy one once the other lets go', async function () {
    const receiver = makeReceiver({ consent: false })
    const first = new Pair(session(desiredA), receiver)
    await first.pump(first.session.begin())
    expect(first.session.state).equals('disabled')
    receiver.setConsent(true)
    await first.pump(first.session.tick())
    expect(first.session.state).equals('applied')
    const second = new Pair(session(desiredB, one, 0xd2), receiver, 2)
    await second.pump(second.session.begin())
    expect(second.session.state).equals('busy')
    await first.pump(first.session.finish(true))
    await second.pump(second.session.tick())
    expect(second.session.state).equals('applied')
  })

  it('leaves another account alone and reports a rotated key', async function () {
    const other = new Pair(session(desiredA), makeReceiver({ credentials: fixtureCredentials('two') }))
    await other.pump(other.session.begin())
    expect(other.session.state).equals('otherAccount')
    expect(other.closed).equals(true)
    const rotated = fixtureCredentials('oneRotated')
    const stale = new Pair(session(desiredA), makeReceiver({ credentials: rotated }))
    await stale.pump(stale.session.begin())
    expect(stale.session.state).equals('keyMismatch')
    expect(stale.session.peerKeyId).equals(rotated.keyId)
  })

  it('finds its own lease after reconnecting and only renews', async function () {
    let applies = 0
    const receiver = makeReceiver({
      apply: () => {
        applies++
        return 'applied'
      }
    })
    const first = new Pair(session(desiredA), receiver)
    await first.pump(first.session.begin())
    const again = new Pair(session(desiredA), receiver, 2)
    await again.pump(again.session.begin())
    expect(again.session.holdsLease).equals(true)
    await again.pump(again.session.tick())
    expect(applies).equals(1)
    // A lease taken away underneath comes back expired and is assigned again.
    receiver.setConsent(false)
    receiver.setConsent(true)
    await again.pump(again.session.tick())
    expect(again.session.state).equals('applied')
    expect(applies).equals(2)
    // And a release nobody holds still ends released.
    receiver.setConsent(false)
    receiver.setConsent(true)
    await again.pump(again.session.setDesired(undefined))
    expect(again.session.state).equals('released')
  })

  it('gives up after three failures, counting timeouts', async function () {
    const pair = new Pair(session(desiredA), makeReceiver({ apply: () => 'failed' }))
    await pair.pump(pair.session.begin())
    await pair.pump(pair.session.tick())
    expect(pair.session.state).equals('assigning')
    await pair.pump(pair.session.tick())
    expect(pair.session.state).equals('failed')
    const lonely = session(desiredA)
    expect(lonely.replyTimedOut()).deep.equals({ send: [], close: false })
    lonely.begin()
    expect(lonely.awaitingRequestId).equals(1n)
    expect(lonely.replyTimedOut()).deep.equals({ send: [], close: true })
    lonely.begin()
    lonely.replyTimedOut()
    lonely.begin()
    expect(lonely.replyTimedOut().close).equals(true)
    expect(lonely.state).equals('failed')
  })

  it('ignores replies to anything but the outstanding request, and refuses forgeries', async function () {
    const receiver = makeReceiver()
    const mine = session(desiredA)
    const discover = mine.begin().send[0]
    const announce = (await receiver.handle(discover, 1, '192.0.2.10')).replies[0]
    const stranger = session(desiredA)
    stranger.begin()
    expect(stranger.receive(announce)).deep.equals({ send: [], close: false })
    expect(mine.receive(announce).send).has.length(1)
    expect(mine.receive(announce)).deep.equals({ send: [], close: false })
    expect(mine.receive(Buffer.from([1, 2, 3])).close).equals(true)
    expect(mine.state).equals('invalid')

    const tampered = session(desiredA)
    const hello = (await receiver.handle(tampered.begin().send[0], 2, '192.0.2.10')).replies[0]
    const flipped = Buffer.from(hello)
    flipped[flipped.length - 1] ^= 1
    expect(tampered.receive(flipped).close).equals(true)

    const bound = session(desiredA)
    const opening = (await receiver.handle(bound.begin().send[0], 3, '192.0.2.10')).replies[0]
    const assign = bound.receive(opening).send[0]
    const asked = decode(assign).message.header
    const own = keyBytes(one)
    const forged = encode(
      {
        header: { ...asked, sender: Buffer.alloc(16, 0xe1), receiverNonce: Buffer.alloc(16) },
        body: { type: 'ack', status: 'applied', revision: 100n }
      },
      own.key
    )
    expect(bound.receive(forged).close).equals(true)

    const order = session(desiredA)
    const first = (await receiver.handle(order.begin().send[0], 4, '192.0.2.10')).replies[0]
    const next = decode(order.receive(first).send[0]).message.header
    const misplaced = encode(
      {
        header: { ...next, sender: Buffer.alloc(16, 0xe1) },
        body: { type: 'announce', consent: true, lease: 'free', leaseRevision: 0n }
      },
      own.key
    )
    expect(order.receive(misplaced).close).equals(true)
    const notAReply = encode(
      { header: { ...next, sender: Buffer.alloc(16, 0xe1) }, body: { type: 'renew', revision: 1n } },
      own.key
    )
    expect(order.receive(notAReply)).deep.equals({ send: [], close: false })
  })

  it('ends on the answers that say so', function () {
    const answered = (status: AckStatus): string => {
      const made = new DirectorSession({
        instanceId: Buffer.alloc(16, 0xd1),
        credentials: one,
        desired: desiredA,
        challenge: Buffer.alloc(16)
      })
      made.begin()
      const own = keyBytes(one)
      made.receive(
        encode(
          {
            header: {
              sender: Buffer.alloc(16, 0xe1),
              requestId: 1n,
              accountTag: own.accountTag,
              keyId: own.keyId,
              challenge: Buffer.alloc(16),
              receiverNonce: Buffer.alloc(0)
            },
            body: { type: 'ack', status, revision: 0n }
          },
          own.key
        )
      )
      return made.state
    }
    expect(answered('unsupported')).equals('unsupported')
    expect(answered('keyMismatch')).equals('keyMismatch')
    expect(answered('wrongAccount')).equals('otherAccount')
    expect(answered('invalid')).equals('discovering')
    expect(answered('stale')).equals('assigning')
  })

  it('makes revisions that only go up', function () {
    const counter = new RevisionCounter()
    expect(counter.next(1790013600000)).equals(1790013600000n)
    expect(counter.next(1790013600000)).equals(1790013600001n)
    expect(counter.next(5)).equals(1790013600002n)
    expect(new RevisionCounter(9n).next(-1)).equals(10n)
    expect(new RevisionCounter().next() > 0n).equals(true)
  })
})

describe('the Director emitter against a peer over TCP', function () {
  let server: Server | undefined
  let port = 0
  let receiver: Receiver
  const peerLines: Array<Record<string, unknown>> = []

  before(async function () {
    receiver = new Receiver({
      instanceId: Buffer.alloc(16, 0xe1),
      credentials: one,
      consent: true,
      apply: () => 'applied'
    })
    const listening = await listen(receiver, [0], line => peerLines.push(line), '127.0.0.1')
    server = listening.server
    port = (server.address() as { port: number }).port
  })

  after(function () {
    server?.close()
  })

  const go = async (
    mode: 'valid' | 'tamper' | 'replay' | 'wrongKey' | 'staleRevision',
    holdMs = 0
  ): Promise<{ status: AckStatus | undefined; lines: Array<Record<string, unknown>> }> => {
    const lines: Array<Record<string, unknown>> = []
    const status = await run({
      credentials: one,
      host: '127.0.0.1',
      port,
      desired: desiredA,
      mode,
      holdMs,
      renewMs: 30,
      replyTimeoutMs: 500,
      log: line => lines.push(line)
    })
    return { status, lines }
  }

  it('assigns, renews while holding, and releases', async function () {
    const { status, lines } = await go('valid', 100)
    expect(status).equals('applied')
    const out = lines.filter(line => line.event === 'out').map(line => line.type)
    expect(out[0]).equals('discover')
    expect(out[1]).equals('assign')
    expect(out).includes('renew')
    expect(out[out.length - 1]).equals('release')
    expect(lines[lines.length - 1]).includes({ event: 'done', state: 'released' })
    expect(receiver.override).equals(undefined)
    // No credential ever reaches a frame or the log.
    expect(JSON.stringify(lines)).not.includes(one.key)
    const assign = lines.find(line => line.event === 'out' && line.type === 'assign')
    expect(assign).includes({
      gameId: 'gam_demoA',
      title: 'Visitors at Pioneers',
      startAt: '2026-09-21T18:00:00Z'
    })
  })

  it('reports a refusing peer in its own state', async function () {
    receiver.setConsent(false)
    const { status, lines } = await go('valid')
    receiver.setConsent(true)
    expect(status).equals('disabled')
    expect(lines[lines.length - 1]).includes({ event: 'done', state: 'disabled' })
  })

  it('a tampered assign is refused and the connection closed', async function () {
    expect((await go('tamper')).status).equals('invalid')
    expect(receiver.override).equals(undefined)
  })

  it('a replayed assign on a new connection is refused', async function () {
    const { status, lines } = await go('replay')
    expect(status).equals('invalid')
    expect(lines.some(line => line.event === 'reconnecting')).equals(true)
    expect(receiver.override).equals(undefined)
  })

  it('a frame signed with the wrong key is refused', async function () {
    expect((await go('wrongKey')).status).equals('invalid')
  })

  it('a stale revision is refused and the newer one kept', async function () {
    expect((await go('staleRevision')).status).equals('stale')
    expect(receiver.override).equals(undefined)
  })

  it('stops when a hold loses the lease', async function () {
    // Another Director takes over between renewals.
    const lines: Array<Record<string, unknown>> = []
    const running = run({
      credentials: one,
      host: '127.0.0.1',
      port,
      desired: desiredA,
      mode: 'valid',
      holdMs: 2000,
      renewMs: 50,
      log: line => lines.push(line)
    })
    await new Promise(resolve => setTimeout(resolve, 20))
    receiver.setConsent(false)
    expect(await running).equals('disabled')
    receiver.setConsent(true)
  })

  it('says so when the peer closes without a word', async function () {
    const silent = createServer(socket => {
      socket.on('data', () => socket.destroy())
    })
    await new Promise<void>(resolve => silent.listen(0, '127.0.0.1', resolve))
    const lines: Array<Record<string, unknown>> = []
    const status = await run({
      credentials: one,
      host: '127.0.0.1',
      port: (silent.address() as { port: number }).port,
      desired: desiredA,
      mode: 'valid',
      holdMs: 0,
      log: line => lines.push(line)
    })
    silent.close()
    expect(status).equals(undefined)
    expect(lines.map(line => line.event)).includes('noReply')
  })

  it('times a link out, and fails to open one nobody answers', async function () {
    const quiet = createServer(() => undefined)
    await new Promise<void>(resolve => quiet.listen(0, '127.0.0.1', resolve))
    const link = await Link.open('127.0.0.1', (quiet.address() as { port: number }).port)
    expect(await link.next(30)).equals(undefined)
    link.close()
    quiet.close()
    let refused: unknown
    try {
      await Link.open('127.0.0.1', 1)
    } catch (error) {
      refused = error
    }
    expect(refused).instanceOf(Error)
    let timedOut: unknown
    try {
      await Link.open('192.0.2.1', 47614, 50)
    } catch (error) {
      timedOut = error
    }
    expect(String(timedOut)).matches(/no connection|EHOSTUNREACH|ENETUNREACH/)
  })

  it('runs from the command line', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'director-'))
    const tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, 'tok_one\n')
    const fetcher = (async () =>
      new Response(JSON.stringify(one), { status: 200 })) as unknown as typeof fetch
    const lines: Array<Record<string, unknown>> = []
    const status = await main(
      [
        '--server', 'http://127.0.0.1:9',
        '--token-file', tokenFile,
        '--peer', `127.0.0.1:${port}`,
        '--game', ' gam_demoB ',
        '--title', 'Pioneers at Comets',
        '--start', '2026-09-22T01:30:00Z',
        '--hold', '0.05'
      ],
      line => lines.push(line),
      fetcher,
      20
    )
    expect(status).equals('applied')
    expect(lines[0]).deep.include({
      assignment: {
        gameId: 'gam_demoB',
        title: 'Pioneers at Comets',
        startAt: '2026-09-22T01:30:00Z'
      }
    })
    expect(
      await main(
        ['--server', 'http://127.0.0.1:9', '--token-file', tokenFile, '--peer', `127.0.0.1:${port}`, '--game', 'g', '--tamper'],
        () => undefined,
        fetcher
      )
    ).equals('invalid')
    let both: unknown
    try {
      await main(['--tamper', '--replay'], () => undefined, fetcher)
    } catch (error) {
      both = error
    }
    expect(String(both)).matches(/at most one/)
    const refusing = (async () =>
      new Response(JSON.stringify({ error: 'deviceEventControlUnavailable' }), {
        status: 503
      })) as unknown as typeof fetch
    let unavailable: unknown
    try {
      await main(
        ['--server', 'http://127.0.0.1:9', '--token-file', tokenFile, '--peer', `127.0.0.1:${port}`, '--game', 'g'],
        () => undefined,
        refusing
      )
    } catch (error) {
      unavailable = error
    }
    expect(String(unavailable)).matches(/503: deviceEventControlUnavailable/)
  })
})
