import { createServer, type Server, type Socket } from 'node:net'

import {
  type AckStatus,
  type Assignment,
  type Body,
  CodecError,
  constantTimeEqual,
  type Credentials,
  decode,
  describe,
  encode,
  frame,
  FrameReader,
  type Header,
  isAuthentic,
  isFromDirector,
  keyBytes,
  LEASE_MS,
  type LeaseState,
  PORTS,
  random,
  VERSION,
  wireAssignment
} from './codec'
import {
  fetchCredentials,
  type Log,
  parseArgs,
  printLog,
  readToken,
  redacted,
  required
} from './cli'

/**
 * A generic event-control receiver: the reference for the receiving end's
 * state machine (README.md beside the Swift package, "Receiver"), and a peer
 * a Director can be pointed at on any machine.
 *
 *   node -r sucrase/register tools/eventControl/peer.ts --server <url> \
 *     --token-file <file> [--port 47614] [--disabled] [--apply failed]
 *
 * It fetches its own key with the bearer token in `--token-file`, listens on
 * `--port` (or the first free of 47614 and 47615), and prints every frame in
 * and out, every lease change, and every assignment it applies, as JSON lines.
 * `--disabled` leaves "Allow Director Override" off; `--apply <status>`
 * answers every assignment with that status instead of applying it.
 */

export interface Override {
  owner: string
  ownerHost: string
  revision: bigint
  assignment: Assignment
}

export interface ApplyContext {
  owner: string
  ownerHost: string
  revision: bigint
}

export type ReceiverEvent =
  | { event: 'overrideChanged'; override: Override | null }
  | { event: 'overrideEnded'; override: Override; reason: EndReason }
  | { event: 'keyMismatch'; peerKeyId: string }

export type EndReason =
  | 'released'
  | 'expired'
  | 'consentOff'
  | 'accountChanged'
  | 'restarted'

export interface ReceiverOptions {
  instanceId: Buffer
  credentials?: Credentials
  consent: boolean
  apply: (
    assignment: Assignment,
    context: ApplyContext
  ) => Promise<AckStatus> | AckStatus
  /**
   * Milliseconds on the clock leases are measured on: `performance.now()`,
   * which setting the wall clock does not move. Tests drive it by hand.
   */
  now?: () => number
  random?: (bytes: number) => Buffer
  /** End a lease on its own when it runs out. Off in tests that drive `now`. */
  autoExpire?: boolean
  /** 15 s, the protocol's; only tests shorten it. */
  leaseMs?: number
  onEvent?: (event: ReceiverEvent) => void
}

export interface Reply {
  replies: Buffer[]
  close: boolean
}

interface Binding {
  director: Buffer
  challenge: Buffer
  nonce: Buffer
  lastRequestId: bigint
  lastReply?: Buffer
}

/** The receiving end's state machine, as in the Swift `EventControlReceiver`. */
export class Receiver {
  readonly instanceId: Buffer
  private credentials: Credentials | undefined
  private consent: boolean
  private readonly applyAssignment: ReceiverOptions['apply']
  private readonly now: () => number
  private readonly random: (bytes: number) => Buffer
  private readonly autoExpire: boolean
  private readonly leaseMs: number
  private readonly onEvent: (event: ReceiverEvent) => void
  private lease: Override | undefined
  private leaseExpiry: number | undefined
  private applying: string | undefined
  private generation = 0
  private interruption: AckStatus = 'expired'
  private readonly bindings = new Map<number, Binding>()
  private expiryTimer: ReturnType<typeof setTimeout> | undefined

  constructor(options: ReceiverOptions) {
    this.instanceId = options.instanceId
    this.credentials = options.credentials
    this.consent = options.consent
    this.applyAssignment = options.apply
    this.now = options.now ?? (() => performance.now())
    this.random = options.random ?? random
    this.autoExpire = options.autoExpire ?? true
    this.leaseMs = options.leaseMs ?? LEASE_MS
    this.onEvent = options.onEvent ?? (() => undefined)
  }

  get override(): Override | undefined {
    return this.lease
  }

  get leaseExpiresAt(): number | undefined {
    return this.leaseExpiry
  }

  setConsent(allowed: boolean): void {
    if (allowed === this.consent) return
    this.consent = allowed
    if (allowed) return
    this.interrupt('disabled')
    this.endLease('consentOff')
  }

  setCredentials(next: Credentials | undefined): void {
    const current = this.credentials
    if (
      current != null &&
      next != null &&
      current.issuer === next.issuer &&
      current.userId === next.userId &&
      current.accountTag === next.accountTag &&
      current.keyId === next.keyId &&
      current.key === next.key
    )
      return
    this.credentials = next
    this.interrupt('wrongAccount')
    this.bindings.clear()
    this.endLease('accountChanged')
  }

  restart(): void {
    this.interrupt('expired')
    this.bindings.clear()
    this.endLease('restarted')
  }

  expireIfDue(): void {
    if (this.leaseExpiry != null && this.now() >= this.leaseExpiry)
      this.endLease('expired')
  }

  connectionClosed(connection: number): void {
    this.bindings.delete(connection)
  }

  /** Everything a receiver does with one payload from `connection`. */
  async handle(
    payload: Buffer,
    connection: number,
    remoteHost: string
  ): Promise<Reply> {
    const credentials = this.credentials
    if (credentials == null) return { replies: [], close: true }
    const own = keyBytes(credentials)
    if (payload.length > 0 && payload[0] !== VERSION) {
      const header: Header = {
        sender: this.instanceId,
        requestId: 0n,
        accountTag: own.accountTag,
        keyId: own.keyId,
        challenge: Buffer.alloc(16),
        receiverNonce: Buffer.alloc(0)
      }
      const body: Body = { type: 'ack', status: 'unsupported', revision: 0n }
      return { replies: [encode({ header, body }, own.key)], close: true }
    }
    let decoded
    try {
      decoded = decode(payload)
    } catch {
      return { replies: [], close: true }
    }
    if (!isFromDirector(decoded.message.body.type))
      return { replies: [], close: true }
    const header = decoded.message.header
    const unbound = (status: AckStatus): Reply => ({
      replies: [this.ack(status, 0n, header, Buffer.alloc(0), credentials)],
      close: true
    })
    if (!header.keyId.equals(own.keyId)) {
      this.onEvent({
        event: 'keyMismatch',
        peerKeyId: header.keyId.toString('hex')
      })
      return unbound('keyMismatch')
    }
    if (!header.accountTag.equals(own.accountTag))
      return unbound('wrongAccount')
    if (!isAuthentic(decoded, own.key)) return unbound('invalid')
    this.expireIfDue()

    const body = decoded.message.body
    if (body.type === 'discover')
      return this.discover(header, connection, credentials)
    const binding = this.bindings.get(connection)
    if (
      binding == null ||
      !binding.director.equals(header.sender) ||
      !constantTimeEqual(binding.challenge, header.challenge) ||
      !constantTimeEqual(binding.nonce, header.receiverNonce)
    ) {
      this.bindings.delete(connection)
      return unbound('invalid')
    }
    const revision = 'revision' in body ? body.revision : 0n
    if (
      header.requestId === binding.lastRequestId &&
      binding.lastReply != null
    ) {
      return { replies: [binding.lastReply], close: false }
    }
    if (header.requestId <= binding.lastRequestId) {
      return {
        replies: [
          this.ack('stale', revision, header, binding.nonce, credentials)
        ],
        close: false
      }
    }
    binding.lastRequestId = header.requestId
    binding.lastReply = undefined

    let status: AckStatus
    const sender = header.sender.toString('hex')
    if (body.type === 'assign') {
      status = await this.assign(body, sender, remoteHost)
    } else if (body.type === 'renew') {
      status = this.renew(body.revision, sender)
    } else if (body.type === 'release') {
      status = this.release(sender)
    } else {
      status = 'invalid'
    }
    const reply = this.ack(status, revision, header, binding.nonce, credentials)
    const current = this.bindings.get(connection)
    if (current?.lastRequestId === header.requestId) current.lastReply = reply
    return { replies: [reply], close: false }
  }

  private discover(
    header: Header,
    connection: number,
    credentials: Credentials
  ): Reply {
    const nonce = this.random(16)
    let lease: LeaseState = 'free'
    if (this.lease != null)
      lease =
        this.lease.owner === header.sender.toString('hex')
          ? 'heldBySender'
          : 'heldByOther'
    const payload = encode(
      {
        header: this.replyHeader(header, nonce, credentials),
        body: {
          type: 'announce',
          consent: this.consent,
          lease,
          leaseRevision:
            lease === 'heldBySender' ? (this.lease?.revision ?? 0n) : 0n
        }
      },
      keyBytes(credentials).key
    )
    this.bindings.set(connection, {
      director: header.sender,
      challenge: header.challenge,
      nonce,
      lastRequestId: header.requestId,
      lastReply: payload
    })
    return { replies: [payload], close: false }
  }

  private async assign(
    body: Extract<Body, { type: 'assign' }>,
    director: string,
    host: string
  ): Promise<AckStatus> {
    let assignment: Assignment
    try {
      assignment = wireAssignment(body.gameId, body.title, body.startAt)
    } catch {
      return 'invalid'
    }
    if (!this.consent) return 'disabled'
    if (this.lease != null && this.lease.owner !== director) return 'busy'
    if (this.applying != null) return 'busy'
    if (this.lease != null) {
      if (body.revision < this.lease.revision) return 'stale'
      if (body.revision === this.lease.revision) {
        const held = this.lease.assignment
        if (
          held.gameId !== assignment.gameId ||
          held.title !== assignment.title ||
          held.startAt !== assignment.startAt
        )
          return 'invalid'
        this.extend()
        return 'applied'
      }
    }
    const started = this.generation
    this.applying = director
    const status = await this.applyAssignment(assignment, {
      owner: director,
      ownerHost: host,
      revision: body.revision
    })
    this.applying = undefined
    if (this.generation !== started) return this.interruption
    if (status !== 'applied') return status
    this.lease = {
      owner: director,
      ownerHost: host,
      revision: body.revision,
      assignment
    }
    this.extend()
    this.onEvent({ event: 'overrideChanged', override: this.lease })
    return 'applied'
  }

  private renew(revision: bigint, director: string): AckStatus {
    if (!this.consent) return 'disabled'
    if (this.lease == null) return 'expired'
    if (this.lease.owner !== director) return 'busy'
    if (revision !== this.lease.revision) return 'stale'
    this.extend()
    return 'applied'
  }

  private release(director: string): AckStatus {
    if (this.lease == null) return 'expired'
    if (this.lease.owner !== director) return 'busy'
    this.endLease('released')
    return 'applied'
  }

  private interrupt(status: AckStatus): void {
    this.generation++
    this.interruption = status
  }

  private extend(): void {
    this.leaseExpiry = this.now() + this.leaseMs
    this.armExpiryTimer()
  }

  private armExpiryTimer(): void {
    if (!this.autoExpire || this.leaseExpiry == null) return
    clearTimeout(this.expiryTimer)
    this.expiryTimer = setTimeout(
      () => {
        this.expiryTimerFired()
      },
      Math.max(0, this.leaseExpiry - this.now())
    )
    this.expiryTimer.unref()
  }

  /**
   * The timer ran out: end the lease if it is due, or wait again for what is
   * left of it. A timer can wake before `now` says the lease is over (it runs
   * on another clock, or a test moved `now` back); it must not then stop
   * watching a lease that is still held.
   */
  private expiryTimerFired(): void {
    this.expiryTimer = undefined
    this.expireIfDue()
    if (this.leaseExpiry != null) this.armExpiryTimer()
  }

  private endLease(reason: EndReason): void {
    clearTimeout(this.expiryTimer)
    this.expiryTimer = undefined
    this.leaseExpiry = undefined
    const ended = this.lease
    if (ended == null) return
    this.lease = undefined
    this.onEvent({ event: 'overrideEnded', override: ended, reason })
    this.onEvent({ event: 'overrideChanged', override: null })
  }

  private replyHeader(
    header: Header,
    nonce: Buffer,
    credentials: Credentials
  ): Header {
    const own = keyBytes(credentials)
    return {
      sender: this.instanceId,
      requestId: header.requestId,
      accountTag: own.accountTag,
      keyId: own.keyId,
      challenge: header.challenge,
      receiverNonce: nonce
    }
  }

  private ack(
    status: AckStatus,
    revision: bigint,
    header: Header,
    nonce: Buffer,
    credentials: Credentials
  ): Buffer {
    return encode(
      {
        header: this.replyHeader(header, nonce, credentials),
        body: { type: 'ack', status, revision }
      },
      keyBytes(credentials).key
    )
  }
}

/** `::ffff:192.0.2.10` as `192.0.2.10`. */
export function plainHost(address: string | undefined): string {
  return (address ?? '').replace(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/, '$1')
}

/** Serves one TCP connection with `receiver`, logging every frame. */
export function serveSocket(
  receiver: Receiver,
  socket: Socket,
  connection: number,
  log: Log
): void {
  const reader = new FrameReader()
  const host = plainHost(socket.remoteAddress)
  let queue = Promise.resolve()
  let closed = false
  log({ event: 'connected', connection, from: host })
  socket.on('data', chunk => {
    let payloads: Buffer[]
    try {
      payloads = reader.push(chunk)
    } catch (error) {
      log({
        event: 'refusedFrame',
        connection,
        error: (error as CodecError).code
      })
      socket.destroy()
      return
    }
    for (const payload of payloads) {
      queue = queue.then(async () => {
        if (closed) return
        log({ event: 'in', connection, from: host, ...summary(payload) })
        const reply = await receiver.handle(payload, connection, host)
        for (const answer of reply.replies) {
          log({ event: 'out', connection, ...summary(answer) })
          socket.write(frame(answer))
        }
        if (reply.close) {
          closed = true
          socket.end()
        }
      })
    }
  })
  socket.on('close', () => {
    closed = true
    receiver.connectionClosed(connection)
    log({ event: 'disconnected', connection })
  })
  socket.on('error', () => undefined)
}

/** A payload decoded for the log, or why it could not be. */
export function summary(payload: Buffer): Record<string, unknown> {
  try {
    return describe(decode(payload).message)
  } catch (error) {
    return {
      undecodable: error instanceof CodecError ? error.message : String(error),
      bytes: payload.length
    }
  }
}

/** Listens on the first of `ports` that is free. */
export async function listen(
  receiver: Receiver,
  ports: number[],
  log: Log,
  host = '0.0.0.0'
): Promise<{ server: Server; port: number }> {
  let next = 1
  for (const port of ports) {
    const server = createServer(socket => {
      serveSocket(receiver, socket, next++, log)
    })
    const bound = await new Promise<boolean>(resolve => {
      server.once('error', () => {
        resolve(false)
      })
      server.listen(port, host, () => {
        resolve(true)
      })
    })
    if (bound) return { server, port }
  }
  throw new Error(`every port is taken: ${ports.join(', ')}`)
}

export async function main(
  argv: string[],
  log: Log = printLog,
  fetcher: typeof fetch = fetch
): Promise<{ server: Server; port: number; receiver: Receiver }> {
  const args = parseArgs(argv, ['disabled'])
  const token = readToken(required(args, 'token-file'))
  const credentials = await fetchCredentials(
    required(args, 'server'),
    token,
    fetcher
  )
  const instance = args.get('instance')
  const instanceId =
    typeof instance === 'string' ? Buffer.from(instance, 'hex') : random(16)
  const answer = args.get('apply')
  const receiver = new Receiver({
    instanceId,
    credentials,
    consent: args.get('disabled') !== true,
    apply: assignment => {
      const status = typeof answer === 'string' ? (answer as AckStatus) : 'applied'
      log({ event: 'apply', ...assignment, status })
      return status
    },
    onEvent: event => {
      const out: Record<string, unknown> = { ...event }
      if ('override' in event && event.override != null)
        out.override = {
          ...event.override,
          revision: event.override.revision.toString()
        }
      log(out)
    }
  })
  const port = args.get('port')
  const listening = await listen(
    receiver,
    typeof port === 'string' ? [Number(port)] : PORTS,
    log,
    typeof args.get('host') === 'string' ? (args.get('host') as string) : undefined
  )
  log({
    event: 'listening',
    port: listening.port,
    instanceId: instanceId.toString('hex'),
    consent: args.get('disabled') !== true,
    credentials: redacted(credentials)
  })
  return { ...listening, receiver }
}

if (require.main === module) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(String(error))
    process.exit(1)
  })
}
