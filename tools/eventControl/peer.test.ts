import { mkdtempSync, writeFileSync } from 'node:fs'
import { createServer, type Server, Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { expect } from 'chai'
import { after, describe, it } from 'mocha'

import {
  type AckStatus,
  type Body,
  type Credentials,
  decode,
  encode,
  frame,
  FrameReader,
  isAuthentic,
  keyBytes
} from './codec'
import { fixture, fixtureCredentials } from './fixtures'
import {
  listen,
  main,
  plainHost,
  Receiver,
  type ReceiverEvent,
  serveSocket,
  summary
} from './peer'

type Step = Record<string, unknown> & {
  expect?: Record<string, unknown>
}
interface DuringApply {
  op: string
  key?: string
  value?: boolean
}

interface Scenario {
  name: string
  consent?: boolean
  apply?: AckStatus
  /** One op, or a list run in order. */
  duringApply?: DuringApply | DuringApply[]
  steps: Step[]
}
interface ScenarioFile {
  instances: Record<string, string>
  hosts: Record<string, string>
  challenges: Record<string, string>
  nonces: string[]
  forgedKey: string
  clockStartMs: number
  assignments: Record<string, { gameId: string; title: string; startAt: string }>
  scenarios: Scenario[]
}

const file = fixture<ScenarioFile>('scenarios.json')

function credentialsNamed(name: string): Credentials {
  if (name !== 'forged') return fixtureCredentials(name)
  return { ...fixtureCredentials('one'), key: file.forgedKey }
}

async function runScenario(scenario: Scenario): Promise<void> {
  let clock = file.clockStartMs
  const nonces = file.nonces.map(hex => Buffer.from(hex, 'hex'))
  const events: ReceiverEvent[] = []
  let applies = 0
  let receiver: Receiver | undefined
  receiver = new Receiver({
    instanceId: Buffer.from(file.instances.receiver, 'hex'),
    credentials: fixtureCredentials('one'),
    consent: scenario.consent ?? true,
    apply: () => {
      applies++
      const hooks = scenario.duringApply ?? []
      for (const hook of Array.isArray(hooks) ? hooks : [hooks]) {
        if (hook.op === 'setConsent') receiver?.setConsent(hook.value === true)
        else receiver?.setCredentials(credentialsNamed(hook.key ?? 'one'))
      }
      return scenario.apply ?? 'applied'
    },
    now: () => clock,
    random: () => nonces.shift() ?? Buffer.alloc(16),
    autoExpire: false,
    onEvent: event => events.push(event)
  })

  const sent: Buffer[] = []
  const replies: Array<Buffer | undefined> = []
  const nonceOf = new Map<number, Buffer>()
  for (const [index, step] of scenario.steps.entries()) {
    const label = `${scenario.name} step ${index}`
    const expected = step.expect ?? {}
    if (typeof step.op === 'string') {
      if (step.op === 'advance') {
        clock += step.ms as number
        receiver.expireIfDue()
      } else if (step.op === 'setConsent') {
        receiver.setConsent(step.value as boolean)
      } else if (step.op === 'setCredentials') {
        receiver.setCredentials(
          step.key == null ? undefined : credentialsNamed(step.key as string)
        )
      } else if (step.op === 'restart') {
        receiver.restart()
      } else {
        receiver.connectionClosed(step.connection as number)
      }
      sent.push(Buffer.alloc(0))
      replies.push(undefined)
      check(expected, receiver, events, applies, label)
      continue
    }
    const connection = step.connection as number
    const director = step.director as string
    const key = credentialsNamed((step.key as string | undefined) ?? 'one')
    const own = keyBytes(key)
    let payload: Buffer
    if (step.send === 'raw') payload = Buffer.from(step.hex as string, 'hex')
    else if (step.send === 'replay') payload = sent[step.fromStep as number]
    else {
      const revision = BigInt((step.revision as string | undefined) ?? '0')
      let body: Body
      if (step.send === 'assign')
        body = {
          type: 'assign',
          revision,
          ...file.assignments[step.assignment as string]
        }
      else if (step.send === 'renew' || step.send === 'release')
        body = { type: step.send, revision }
      else if (step.send === 'ack')
        body = { type: 'ack', status: step.status as AckStatus, revision }
      else body = { type: 'discover' }
      payload = encode(
        {
          header: {
            sender: Buffer.from(file.instances[director], 'hex'),
            requestId: BigInt((step.requestId as string | undefined) ?? '0'),
            accountTag: own.accountTag,
            keyId: own.keyId,
            challenge: Buffer.from(file.challenges[String(connection)], 'hex'),
            receiverNonce:
              typeof step.nonce === 'string'
                ? Buffer.from(step.nonce, 'hex')
                : (nonceOf.get(connection) ?? Buffer.alloc(0))
          },
          body
        },
        own.key
      )
    }
    if (step.tamper === true) {
      payload = Buffer.from(payload)
      payload[payload.length - 1] ^= 1
    }
    sent.push(payload)
    const reply = await receiver.handle(
      payload,
      connection,
      file.hosts[director]
    )
    expect(reply.replies.length, label).lessThanOrEqual(1)
    const answer = reply.replies[0]
    replies.push(answer)
    if (typeof expected.close === 'boolean')
      expect(reply.close, label).equals(expected.close)
    if (typeof expected.sameReplyAs === 'number')
      expect(answer, label).deep.equals(replies[expected.sameReplyAs])
    if ('reply' in expected) {
      const wanted = expected.reply as Record<string, unknown> | null
      if (wanted == null) {
        expect(answer, label).equals(undefined)
      } else {
        expect(answer, label).not.equals(undefined)
        const decoded = decode(answer as Buffer)
        const replyKey = credentialsNamed(
          (expected.replyKey as string | undefined) ?? 'one'
        )
        expect(isAuthentic(decoded, keyBytes(replyKey).key), label).equals(
          true
        )
        let asked
        try {
          asked = decode(payload).message.header
        } catch {
          asked = undefined
        }
        const header = decoded.message.header
        expect(header.requestId.toString(), label).equals(
          (wanted.requestId as string | undefined) ??
            asked?.requestId.toString()
        )
        if (wanted.status === 'unsupported')
          expect(header.challenge.equals(Buffer.alloc(16)), label).equals(true)
        else
          expect(header.challenge.toString('hex'), label).equals(
            asked?.challenge.toString('hex')
          )
        const body = decoded.message.body
        const shown: Record<string, unknown> = { type: body.type }
        if (body.type === 'announce') {
          shown.consent = body.consent
          shown.lease = body.lease
          shown.leaseRevision = body.leaseRevision.toString()
          nonceOf.set(connection, header.receiverNonce)
        } else if (body.type === 'ack') {
          shown.status = body.status
          shown.revision = body.revision.toString()
        }
        const { requestId, ...rest } = wanted
        expect(shown, label).deep.equals(rest)
      }
    }
    check(expected, receiver, events, applies, label)
  }
}

function check(
  expected: Record<string, unknown>,
  receiver: Receiver,
  events: ReceiverEvent[],
  applies: number,
  label: string
): void {
  if (typeof expected.applies === 'number')
    expect(applies, label).equals(expected.applies)
  if ('lease' in expected) {
    const wanted = expected.lease as Record<string, string> | null
    const held = receiver.override
    if (wanted == null) expect(held, label).equals(undefined)
    else {
      expect(held?.owner, label).equals(file.instances[wanted.owner])
      expect(held?.revision.toString(), label).equals(wanted.revision)
      expect(held?.ownerHost, label).equals(wanted.ownerHost)
      expect(held?.assignment, label).deep.equals(
        file.assignments[wanted.assignment]
      )
    }
  }
  if (typeof expected.ended === 'string') {
    const ended = events.filter(event => event.event === 'overrideEnded')
    const last = ended[ended.length - 1]
    expect(last != null && 'reason' in last ? last.reason : undefined, label).equals(
      expected.ended
    )
  }
  if (typeof expected.keyMismatch === 'string') {
    expect(events, label).deep.include({
      event: 'keyMismatch',
      peerKeyId: credentialsNamed(expected.keyMismatch).keyId
    })
  }
}

describe('receiver scenarios from the shared fixtures', function () {
  it('has them all', function () {
    expect(file.scenarios.length).greaterThan(19)
  })
  for (const scenario of file.scenarios) {
    it(scenario.name, async function () {
      await runScenario(scenario)
    })
  }
})

const one = fixtureCredentials('one')

const makeReceiver = (
  overrides: Partial<ConstructorParameters<typeof Receiver>[0]> = {}
): Receiver =>
  new Receiver({
    instanceId: Buffer.alloc(16, 0xe1),
    credentials: one,
    consent: true,
    apply: () => 'applied',
    ...overrides
  })

describe('the receiver over TCP', function () {
  const servers: Server[] = []
  after(function () {
    for (const server of servers) server.close()
  })

  it('takes the next port when the first is taken, and says when all are', async function () {
    const blocker = createServer()
    await new Promise<void>(resolve => blocker.listen(0, '127.0.0.1', resolve))
    servers.push(blocker)
    const taken = (blocker.address() as { port: number }).port
    const lines: Array<Record<string, unknown>> = []
    const first = await listen(makeReceiver(), [taken, 0], line => lines.push(line), '127.0.0.1')
    servers.push(first.server)
    expect(first.port).equals(0)
    let refused: unknown
    try {
      await listen(makeReceiver(), [taken], () => undefined, '127.0.0.1')
    } catch (error) {
      refused = error
    }
    expect(String(refused)).matches(/every port is taken/)
  })

  it('serves frames, refuses an oversized one and logs both', async function () {
    const lines: Array<Record<string, unknown>> = []
    const receiver = makeReceiver()
    const { server } = await listen(receiver, [0], line => lines.push(line), '127.0.0.1')
    servers.push(server)
    const port = (server.address() as { port: number }).port
    const socket = new Socket()
    await new Promise<void>(resolve => socket.connect(port, '127.0.0.1', resolve))
    const reader = new FrameReader()
    const got: Buffer[] = []
    socket.on('data', chunk => got.push(...reader.push(chunk)))
    const own = keyBytes(one)
    socket.write(
      frame(
        encode(
          {
            header: {
              sender: Buffer.alloc(16, 0xd1),
              requestId: 1n,
              accountTag: own.accountTag,
              keyId: own.keyId,
              challenge: Buffer.alloc(16, 0xc1),
              receiverNonce: Buffer.alloc(0)
            },
            body: { type: 'discover' }
          },
          own.key
        )
      )
    )
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(got).has.length(1)
    expect(decode(got[0]).message.body.type).equals('announce')
    socket.write(Buffer.from([0, 0, 0x10, 0x01]))
    await new Promise(resolve => socket.on('close', resolve))
    expect(lines.map(line => line.event)).includes.members([
      'connected',
      'in',
      'out',
      'refusedFrame',
      'disconnected'
    ])
  })

  it('closes after a reply that says so', async function () {
    const lines: Array<Record<string, unknown>> = []
    const receiver = makeReceiver()
    const server = createServer(socket => {
      serveSocket(receiver, socket, 1, line => lines.push(line))
    })
    servers.push(server)
    await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
    const socket = new Socket()
    await new Promise<void>(resolve =>
      socket.connect((server.address() as { port: number }).port, '127.0.0.1', resolve)
    )
    socket.resume()
    // Two frames at once: the first closes the connection, the second is never answered.
    socket.write(Buffer.concat([frame(Buffer.from([1, 1])), frame(Buffer.from([1, 1]))]))
    await new Promise(resolve => socket.on('close', resolve))
    expect(lines.filter(line => line.event === 'out')).has.length(1)
  })

  it('logs what it cannot decode', function () {
    expect(summary(Buffer.from([9, 1]))).deep.equals({
      undecodable: 'unsupportedVersion(9)',
      bytes: 2
    })
    expect(summary(Buffer.from([9]))).deep.equals({
      undecodable: 'tooShort',
      bytes: 1
    })
    expect(plainHost('::ffff:192.0.2.4')).equals('192.0.2.4')
    expect(plainHost(undefined)).equals('')
  })

  /** A discover and an assign at revision 5 from one Director on connection 1. */
  const holdALease = async (receiver: Receiver): Promise<void> => {
    const own = keyBytes(one)
    const header = {
      sender: Buffer.alloc(16, 0xd1),
      requestId: 1n,
      accountTag: own.accountTag,
      keyId: own.keyId,
      challenge: Buffer.alloc(16, 0xc1),
      receiverNonce: Buffer.alloc(0)
    }
    const announce = await receiver.handle(
      encode({ header, body: { type: 'discover' } }, own.key),
      1,
      '192.0.2.10'
    )
    const nonce = decode(announce.replies[0]).message.header.receiverNonce
    await receiver.handle(
      encode(
        {
          header: { ...header, requestId: 2n, receiverNonce: nonce },
          body: {
            type: 'assign',
            revision: 5n,
            gameId: 'gam_demoA',
            title: 'Visitors at Pioneers',
            startAt: '2026-09-21T18:00:00Z'
          }
        },
        own.key
      ),
      1,
      '192.0.2.10'
    )
    expect(receiver.override?.revision).equals(5n)
  }

  it('expires on its own when nobody renews', async function () {
    const events: ReceiverEvent[] = []
    const receiver = makeReceiver({
      leaseMs: 10,
      onEvent: event => events.push(event)
    })
    await holdALease(receiver)
    expect(receiver.leaseExpiresAt).greaterThan(performance.now() - 1)
    await new Promise(resolve => setTimeout(resolve, 40))
    expect(receiver.override).equals(undefined)
    expect(events.map(event => event.event)).deep.equals([
      'overrideChanged',
      'overrideEnded',
      'overrideChanged'
    ])
  })

  it('still ends a lease when the clock steps back after its timer was set', async function () {
    // The clock follows real time from an offset the test moves. The timer is
    // set for 20 ms; the clock then steps back 100 ms, so when the timer fires
    // the lease has 100 ms left. The receiver must wait for that, not stop
    // watching and keep the lease for ever.
    let offset = 0
    const receiver = makeReceiver({
      leaseMs: 20,
      now: () => performance.now() + offset
    })
    await holdALease(receiver)
    offset = -100
    await new Promise(resolve => setTimeout(resolve, 50))
    expect(receiver.override?.revision).equals(5n)
    await new Promise(resolve => setTimeout(resolve, 200))
    expect(receiver.override).equals(undefined)
  })

  it('measures leases on the monotonic clock by default', async function () {
    const receiver = makeReceiver({ autoExpire: false })
    const before = performance.now()
    await holdALease(receiver)
    expect(receiver.leaseExpiresAt).within(before + 15_000, performance.now() + 15_000)
  })

  it('runs from the command line with its own key', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'peer-'))
    const tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, 'tok_one\n')
    const asked: string[] = []
    const fetcher = (async (url: string, init?: RequestInit) => {
      asked.push(`${url} ${JSON.stringify(init?.headers)}`)
      return new Response(JSON.stringify({ version: 2, ...one }), { status: 200 })
    }) as typeof fetch
    const lines: Array<Record<string, unknown>> = []
    const started = await main(
      [
        '--server',
        'http://127.0.0.1:9/api/v1/',
        '--token-file',
        tokenFile,
        '--port',
        '0',
        '--host',
        '127.0.0.1',
        '--instance',
        'e1'.repeat(16),
        '--apply',
        'failed',
        '--disabled'
      ],
      line => lines.push(line),
      fetcher
    )
    servers.push(started.server)
    expect(asked[0]).equals(
      'http://127.0.0.1:9/api/v1/device-event-control/key {"authorization":"Bearer tok_one"}'
    )
    const listening = lines.find(line => line.event === 'listening')
    expect(listening?.consent).equals(false)
    expect(JSON.stringify(lines)).not.includes(one.key)
    expect(JSON.stringify(lines)).not.includes('tok_one')
    started.receiver.setConsent(true)
    const own = keyBytes(one)
    const header = {
      sender: Buffer.alloc(16, 0xd1),
      requestId: 1n,
      accountTag: own.accountTag,
      keyId: own.keyId,
      challenge: Buffer.alloc(16, 0xc1),
      receiverNonce: Buffer.alloc(0)
    }
    const hello = await started.receiver.handle(
      encode({ header, body: { type: 'discover' } }, own.key),
      9,
      '192.0.2.10'
    )
    const nonce = decode(hello.replies[0]).message.header.receiverNonce
    const reply = await started.receiver.handle(
      encode(
        {
          header: { ...header, requestId: 2n, receiverNonce: nonce },
          body: {
            type: 'assign',
            revision: 5n,
            gameId: 'gam_demoA',
            title: 'Visitors at Pioneers',
            startAt: '2026-09-21T18:00:00Z'
          }
        },
        own.key
      ),
      9,
      '192.0.2.10'
    )
    const body = decode(reply.replies[0]).message.body
    expect(body.type === 'ack' && body.status).equals('failed')
    expect(lines.some(line => line.event === 'apply')).equals(true)
  })

  it('logs lease changes with their revision as text', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'peer-'))
    const tokenFile = join(dir, 'token')
    writeFileSync(tokenFile, 'tok_one')
    const fetcher = (async () =>
      new Response(JSON.stringify({ version: 2, ...one }), { status: 200 })) as unknown as typeof fetch
    const lines: Array<Record<string, unknown>> = []
    const started = await main(
      ['--server', 'http://127.0.0.1:9', '--token-file', tokenFile, '--port', '0', '--host', '127.0.0.1'],
      line => lines.push(line),
      fetcher
    )
    servers.push(started.server)
    const own = keyBytes(one)
    const header = {
      sender: Buffer.alloc(16, 0xd1),
      requestId: 1n,
      accountTag: own.accountTag,
      keyId: own.keyId,
      challenge: Buffer.alloc(16, 0xc1),
      receiverNonce: Buffer.alloc(0)
    }
    const hello = await started.receiver.handle(
      encode({ header, body: { type: 'discover' } }, own.key),
      3,
      '192.0.2.10'
    )
    const nonce = decode(hello.replies[0]).message.header.receiverNonce
    await started.receiver.handle(
      encode(
        {
          header: { ...header, requestId: 2n, receiverNonce: nonce },
          body: {
            type: 'assign',
            revision: 7n,
            gameId: 'gam_demoA',
            title: 'Visitors at Pioneers',
            startAt: '2026-09-21T18:00:00Z'
          }
        },
        own.key
      ),
      3,
      '192.0.2.10'
    )
    started.receiver.restart()
    const changed = lines.find(
      line => line.event === 'overrideChanged' && line.override != null
    )
    expect((changed?.override as { revision: string }).revision).equals('7')
    expect(lines.some(line => line.event === 'overrideEnded')).equals(true)
  })
})
