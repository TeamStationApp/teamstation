import { connect as tcpConnect, type Socket } from 'node:net'

import {
  type AckStatus,
  type Assignment,
  type Body,
  buildAssignment,
  constantTimeEqual,
  type Credentials,
  decode,
  encode,
  frame,
  FrameReader,
  isAuthentic,
  isFromDirector,
  keyBytes,
  type MessageType,
  random,
  RENEW_MS
} from './codec'
import {
  fetchCredentials,
  type Log,
  parseArgs,
  parseEndpoint,
  printLog,
  readToken,
  redacted,
  required
} from './cli'
import { summary } from './peer'

/**
 * A Director's side of event control: the reference for the Director state
 * machine (README.md beside the Swift package, "Director"), and an emitter to
 * drive any receiver with.
 *
 *   node -r sucrase/register tools/eventControl/director.ts --server <url> \
 *     --token-file <file> --peer <ip:port> --game <id> [--title <t>] \
 *     [--start <iso>] [--hold <seconds>] \
 *     [--tamper | --replay | --wrong-key | --stale-revision]
 *
 * It fetches its own key with its own token, then runs discover → assign →
 * renew every 5 s for `--hold` seconds → release, logging every frame. The
 * bad-frame modes send the named frame instead and log what the receiver
 * answers.
 */

export type PeerState =
  | 'connecting'
  | 'discovering'
  | 'connected'
  | 'assigning'
  | 'applied'
  | 'disabled'
  | 'busy'
  | 'otherAccount'
  | 'keyMismatch'
  | 'unsupported'
  | 'invalid'
  | 'failed'
  | 'released'
  | 'unreachable'

export interface Desired {
  revision: bigint
  assignment: Assignment
}

export interface Step {
  send: Buffer[]
  close: boolean
}

interface Pending {
  requestId: bigint
  type: MessageType
  revision: bigint
}

/** Revisions that only go up: the clock in ms, or one more than the last. */
export class RevisionCounter {
  last: bigint
  constructor(last = 0n) {
    this.last = last
  }

  next(now = Date.now()): bigint {
    const clock = BigInt(Math.max(0, Math.floor(now)))
    this.last = this.last + 1n > clock ? this.last + 1n : clock
    return this.last
  }
}

/** The Director's side of one connection, as the Swift session. */
export class DirectorSession {
  state: PeerState = 'discovering'
  peerInstance: string | undefined
  consent: boolean | undefined
  ackedRevision: bigint | undefined
  lastStatus: AckStatus | undefined
  peerKeyId: string | undefined
  readonly challenge: Buffer
  private readonly instanceId: Buffer
  private readonly credentials: Credentials
  private readonly maxFailures: number
  private desired: Desired | undefined
  private nextRequestId = 1n
  private nonce: Buffer | undefined
  private pending: Pending | undefined
  private held: bigint | undefined
  private failures = 0

  constructor(options: {
    instanceId: Buffer
    credentials: Credentials
    desired?: Desired
    challenge?: Buffer
    maxFailures?: number
  }) {
    this.instanceId = options.instanceId
    this.credentials = options.credentials
    this.desired = options.desired
    this.challenge = options.challenge ?? random(16)
    this.maxFailures = options.maxFailures ?? 3
  }

  get awaitingRequestId(): bigint | undefined {
    return this.pending?.requestId
  }

  get isBound(): boolean {
    return this.nonce != null
  }

  get holdsLease(): boolean {
    return this.held != null
  }

  begin(): Step {
    this.state = 'discovering'
    return { send: [this.request('discover', 0n)], close: false }
  }

  setDesired(next: Desired | undefined): Step {
    this.desired = next
    if (!this.isBound || this.pending != null) return { send: [], close: false }
    return this.nextRequest(false)
  }

  tick(): Step {
    if (!this.isBound || this.pending != null) return { send: [], close: false }
    if (
      ['applied', 'assigning', 'disabled', 'busy', 'connected', 'released'].includes(
        this.state
      )
    )
      return this.nextRequest(true)
    return { send: [], close: false }
  }

  replyTimedOut(): Step {
    if (this.pending == null) return { send: [], close: false }
    this.pending = undefined
    return this.failed() ?? { send: [], close: true }
  }

  finish(release: boolean): Step {
    this.desired = undefined
    const step: Step = { send: [], close: true }
    if (release && this.isBound && this.held != null) {
      step.send.push(this.request('release', this.held))
      this.held = undefined
    }
    this.state = 'released'
    return step
  }

  receive(payload: Buffer): Step {
    let decoded
    try {
      decoded = decode(payload)
    } catch {
      return this.stop('invalid')
    }
    const { header, body } = decoded.message
    const awaited = this.pending
    if (
      awaited == null ||
      header.requestId !== awaited.requestId ||
      !constantTimeEqual(header.challenge, this.challenge) ||
      isFromDirector(body.type)
    )
      return { send: [], close: false }
    this.peerInstance = header.sender.toString('hex')
    const own = keyBytes(this.credentials)
    if (!header.keyId.equals(own.keyId)) {
      this.peerKeyId = header.keyId.toString('hex')
      this.lastStatus = 'keyMismatch'
      return this.stop('keyMismatch')
    }
    if (!header.accountTag.equals(own.accountTag)) {
      this.lastStatus = 'wrongAccount'
      return this.stop('otherAccount')
    }
    if (!isAuthentic(decoded, own.key)) return this.stop('invalid')
    if (this.nonce != null && !constantTimeEqual(this.nonce, header.receiverNonce))
      return this.stop('invalid')
    this.pending = undefined
    if (body.type === 'announce') {
      if (awaited.type !== 'discover' || header.receiverNonce.length !== 16)
        return this.stop('invalid')
      this.nonce = header.receiverNonce
      this.consent = body.consent
      if (
        body.lease === 'heldBySender' &&
        this.desired?.revision === body.leaseRevision
      ) {
        this.held = body.leaseRevision
        this.ackedRevision = body.leaseRevision
      }
      this.state = body.consent ? 'connected' : 'disabled'
      return this.nextRequest(false)
    }
    if (body.type === 'ack') return this.acknowledged(body.status, awaited)
    return this.stop('invalid')
  }

  /** The signed payload for a request, recorded as outstanding. */
  request(type: MessageType, revision: bigint): Buffer {
    const requestId = this.nextRequestId++
    this.pending = { requestId, type, revision }
    let body: Body
    if (type === 'assign' && this.desired != null) {
      body = { type, revision, ...this.desired.assignment }
    } else if (type === 'renew' || type === 'release') {
      body = { type, revision }
    } else {
      body = { type: 'discover' }
    }
    const own = keyBytes(this.credentials)
    return encode(
      {
        header: {
          sender: this.instanceId,
          requestId,
          accountTag: own.accountTag,
          keyId: own.keyId,
          challenge: this.challenge,
          receiverNonce: this.nonce ?? Buffer.alloc(0)
        },
        body
      },
      own.key
    )
  }

  private acknowledged(status: AckStatus, awaited: Pending): Step {
    this.lastStatus = status
    switch (status) {
      case 'applied':
        this.failures = 0
        if (awaited.type === 'release') {
          this.held = undefined
          this.state = 'released'
          return this.nextRequest(false)
        }
        this.held = awaited.revision
        this.consent = true
        this.ackedRevision = awaited.revision
        this.state = 'applied'
        return this.nextRequest(false)
      case 'disabled':
        this.held = undefined
        this.consent = false
        this.state = 'disabled'
        return { send: [], close: false }
      case 'busy':
        this.held = undefined
        this.state = 'busy'
        return { send: [], close: false }
      case 'expired':
      case 'stale':
        this.held = undefined
        if (awaited.type === 'release') {
          this.state = 'released'
          return this.nextRequest(false)
        }
        return this.failed() ?? this.nextRequest(true)
      case 'invalid':
      case 'failed':
        this.held = undefined
        return this.failed() ?? { send: [], close: false }
      case 'wrongAccount':
        return this.stop('otherAccount')
      case 'unsupported':
        return this.stop('unsupported')
      case 'keyMismatch':
        return this.stop('keyMismatch')
    }
  }

  private nextRequest(retry: boolean): Step {
    const desired = this.desired
    if (desired == null) {
      if (this.held == null) {
        if (this.state !== 'disabled' && this.state !== 'released')
          this.state = 'connected'
        return { send: [], close: false }
      }
      return { send: [this.request('release', this.held)], close: false }
    }
    if (this.held === desired.revision) {
      if (!retry) return { send: [], close: false }
      return { send: [this.request('renew', desired.revision)], close: false }
    }
    this.state = 'assigning'
    return { send: [this.request('assign', desired.revision)], close: false }
  }

  private failed(): Step | undefined {
    this.failures++
    if (this.failures < this.maxFailures) return undefined
    return this.stop('failed')
  }

  private stop(state: PeerState): Step {
    this.pending = undefined
    this.held = undefined
    this.state = state
    return { send: [], close: true }
  }
}

/** One framed TCP connection, read a reply at a time. */
export class Link {
  private readonly socket: Socket
  private readonly reader = new FrameReader()
  private readonly waiting: Array<(payload: Buffer | undefined) => void> = []
  private readonly arrived: Buffer[] = []
  private ended = false

  private constructor(socket: Socket) {
    this.socket = socket
    socket.on('data', chunk => {
      let payloads: Buffer[]
      try {
        payloads = this.reader.push(chunk)
      } catch {
        socket.destroy()
        return
      }
      for (const payload of payloads) {
        const waiter = this.waiting.shift()
        if (waiter != null) waiter(payload)
        else this.arrived.push(payload)
      }
    })
    socket.on('close', () => {
      this.ended = true
      for (const waiter of this.waiting.splice(0)) waiter(undefined)
    })
    socket.on('error', () => undefined)
  }

  static async open(
    host: string,
    port: number,
    timeoutMs = 2000
  ): Promise<Link> {
    return await new Promise((resolve, reject) => {
      const socket = tcpConnect({ host, port })
      const timer = setTimeout(() => {
        socket.destroy()
        reject(new Error(`no connection to ${host}:${port} in ${timeoutMs} ms`))
      }, timeoutMs)
      socket.once('connect', () => {
        clearTimeout(timer)
        socket.setNoDelay(true)
        resolve(new Link(socket))
      })
      socket.once('error', error => {
        clearTimeout(timer)
        reject(error)
      })
    })
  }

  send(payload: Buffer): void {
    this.socket.write(frame(payload))
  }

  /** The next payload, or undefined when the connection has closed or nothing came in time. */
  async next(timeoutMs = 3000): Promise<Buffer | undefined> {
    const ready = this.arrived.shift()
    if (ready != null) return ready
    if (this.ended) return undefined
    return await new Promise(resolve => {
      const timer = setTimeout(() => {
        const at = this.waiting.indexOf(done)
        if (at >= 0) this.waiting.splice(at, 1)
        resolve(undefined)
      }, timeoutMs)
      const done = (payload: Buffer | undefined): void => {
        clearTimeout(timer)
        resolve(payload)
      }
      this.waiting.push(done)
    })
  }

  close(): void {
    this.socket.end()
  }
}

export type Mode = 'valid' | 'tamper' | 'replay' | 'wrongKey' | 'staleRevision'

export interface RunOptions {
  credentials: Credentials
  host: string
  port: number
  desired: Desired
  mode: Mode
  holdMs: number
  renewMs?: number
  log: Log
  instanceId?: Buffer
  replyTimeoutMs?: number
}

/** Sends a step, logging each frame. */
function sendStep(link: Link, step: Step, log: Log): void {
  for (const payload of step.send) {
    log({ event: 'out', ...summary(payload) })
    link.send(payload)
  }
}

/** Sends and logs whatever reply comes, feeding it to the session. */
async function exchange(
  link: Link,
  session: DirectorSession,
  step: Step,
  log: Log,
  timeoutMs: number
): Promise<Step> {
  sendStep(link, step, log)
  if (step.send.length === 0) return { send: [], close: step.close }
  const reply = await link.next(timeoutMs)
  if (reply == null) {
    log({ event: 'noReply' })
    return session.replyTimedOut()
  }
  log({ event: 'in', ...summary(reply) })
  const next = session.receive(reply)
  log({ event: 'state', state: session.state, lastStatus: session.lastStatus })
  return next
}

/** Drives a session until it has nothing more to send. */
async function settle(
  link: Link,
  session: DirectorSession,
  first: Step,
  log: Log,
  timeoutMs: number
): Promise<void> {
  let step = first
  while (step.send.length > 0) {
    const closing = step.close
    step = await exchange(link, session, step, log, timeoutMs)
    if (closing) break
  }
}

/** Sends one hand-made payload and logs the reply, or that the connection closed. */
async function probe(
  link: Link,
  payload: Buffer,
  log: Log,
  timeoutMs: number
): Promise<AckStatus | undefined> {
  log({ event: 'out', ...summary(payload) })
  link.send(payload)
  const reply = await link.next(timeoutMs)
  if (reply == null) {
    log({ event: 'closedWithoutReply' })
    return undefined
  }
  log({ event: 'in', ...summary(reply) })
  const { body } = decode(reply).message
  return body.type === 'ack' ? body.status : undefined
}

/** A short pause. */
const pause = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

/**
 * One run against a receiver. Answers the last status the receiver gave, which
 * for the bad-frame modes is the answer to the bad frame (undefined when it
 * closed the connection without one).
 */
export async function run(options: RunOptions): Promise<AckStatus | undefined> {
  const { log, mode } = options
  const timeoutMs = options.replyTimeoutMs ?? 3000
  const instanceId = options.instanceId ?? random(16)
  const credentials =
    mode === 'wrongKey'
      ? { ...options.credentials, key: random(32).toString('hex') }
      : options.credentials
  const session = new DirectorSession({
    instanceId,
    credentials,
    desired: options.desired
  })
  log({
    event: 'start',
    mode,
    peer: `${options.host}:${options.port}`,
    instanceId: instanceId.toString('hex'),
    revision: options.desired.revision.toString(),
    assignment: options.desired.assignment,
    credentials: redacted(options.credentials)
  })
  const link = await Link.open(options.host, options.port)

  if (mode === 'wrongKey') {
    const status = await probe(link, session.begin().send[0], log, timeoutMs)
    link.close()
    return status
  }

  // Discover, and stop before the assignment the session would send next.
  const discover = session.begin()
  sendStep(link, discover, log)
  const announce = await link.next(timeoutMs)
  if (announce == null) {
    log({ event: 'noReply' })
    link.close()
    return undefined
  }
  log({ event: 'in', ...summary(announce) })
  const first = session.receive(announce)
  log({ event: 'state', state: session.state })

  if (mode === 'tamper') {
    const assign = first.send[0] ?? session.request('assign', options.desired.revision)
    const tampered = Buffer.from(assign)
    tampered[tampered.length - 1] ^= 0x01
    const status = await probe(link, tampered, log, timeoutMs)
    link.close()
    return status
  }

  // A valid assignment first, for every remaining mode.
  await settle(link, session, first, log, timeoutMs)
  const applied = first.send[0]
  let status = session.lastStatus

  if (mode === 'staleRevision') {
    const older = options.desired.revision - 1n
    const answer = await probe(
      link,
      session.request('assign', older),
      log,
      timeoutMs
    )
    await settle(link, session, session.finish(true), log, timeoutMs)
    link.close()
    return answer
  }

  if (mode === 'replay') {
    await settle(link, session, session.finish(true), log, timeoutMs)
    link.close()
    log({ event: 'reconnecting', note: 'replaying the first assign on a new connection' })
    const second = await Link.open(options.host, options.port)
    const fresh = new DirectorSession({ instanceId, credentials, desired: undefined })
    await settle(second, fresh, fresh.begin(), log, timeoutMs)
    const answer = await probe(second, applied, log, timeoutMs)
    second.close()
    return answer
  }

  // Valid: hold, renewing, then release.
  const renewMs = options.renewMs ?? RENEW_MS
  const until = Date.now() + options.holdMs
  while (Date.now() + renewMs <= until) {
    await pause(renewMs)
    await settle(link, session, session.tick(), log, timeoutMs)
    status = session.lastStatus
    if (session.state !== 'applied') break
  }
  // A peer that refused (another account, consent off) keeps its own state.
  const reached = session.state
  await settle(link, session, session.finish(true), log, timeoutMs)
  log({
    event: 'done',
    state: reached === 'applied' ? session.state : reached,
    lastStatus: session.lastStatus
  })
  link.close()
  return status
}

const MODES: Record<string, Mode> = {
  tamper: 'tamper',
  replay: 'replay',
  'wrong-key': 'wrongKey',
  'stale-revision': 'staleRevision'
}

export async function main(
  argv: string[],
  log: Log = printLog,
  fetcher: typeof fetch = fetch,
  renewMs = RENEW_MS
): Promise<AckStatus | undefined> {
  const args = parseArgs(argv, Object.keys(MODES))
  const modes = Object.keys(MODES).filter(name => args.get(name) === true)
  if (modes.length > 1) throw new Error('give at most one bad-frame mode')
  const token = readToken(required(args, 'token-file'))
  const credentials = await fetchCredentials(required(args, 'server'), token, fetcher)
  const { host, port } = parseEndpoint(required(args, 'peer'))
  const start = args.get('start')
  const title = args.get('title')
  const assignment = buildAssignment(
    required(args, 'game'),
    typeof title === 'string' ? title : 'Visitors at Home',
    typeof start === 'string' ? new Date(start) : new Date()
  )
  const hold = args.get('hold')
  return await run({
    credentials,
    host,
    port,
    desired: { revision: new RevisionCounter().next(), assignment },
    mode: modes.length === 0 ? 'valid' : MODES[modes[0]],
    holdMs: typeof hold === 'string' ? Number(hold) * 1000 : 0,
    renewMs,
    log
  })
}

if (require.main === module) {
  main(process.argv.slice(2)).then(
    status => {
      printLog({ event: 'exit', status: status ?? null })
    },
    (error: unknown) => {
      console.error(String(error))
      process.exit(1)
    }
  )
}
