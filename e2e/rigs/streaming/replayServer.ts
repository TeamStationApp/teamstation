import { readFileSync } from 'node:fs'
import {
  createServer,
  type IncomingMessage,
  type ServerResponse
} from 'node:http'
import { connect as netConnect } from 'node:net'
import { join } from 'node:path'

import {
  FlvReader,
  type FlvTag,
  MSG,
  parseRtmpUrl,
  RtmpPublisher,
  type RtmpSocket,
  type RtmpTarget
} from './rtmpPublish'

/**
 * The synthetic cameras of a stack, replayed from a publisher droplet of its
 * own: each angle's pre-encoded fixture (renderFixture.ts) is sent over RTMP
 * as a camera sends it, each tag when its time comes, and from the start
 * again at its end. Nothing is encoded here, so a droplet of any size keeps
 * up.
 *
 *   node -r sucrase/register e2e/rigs/streaming/replayServer.ts \
 *     --fixtures <dir of <label>.flv> --token-file <file> [--port 9400] [--host 127.0.0.1]
 *
 * Its routes, each but health needing the token as a bearer:
 *
 *   PUT    /__e2e/publishers/<label>      { url }  starts the angle at its beginning
 *   POST   /__e2e/publishers/<label>/cut  { seconds, discontinuity? }
 *   DELETE /__e2e/publishers/<label>      stops it
 *   GET    /__e2e/publishers              every angle's state
 *   GET    /__e2e/health                  {"status":"ok"}
 *
 * An angle's clock reads zero at `startedAtMs` and again every `loopMs`: a
 * cut resumes where the stream would have been, so the loops keep their
 * places. The RTMP URL, key and all, lives only in this process.
 */

/** A fixture as it is replayed: the tags each connection opens with, and the rest. */
export interface Fixture {
  label: string
  /** The metadata and the video and audio sequence headers. */
  config: FlvTag[]
  media: FlvTag[]
  loopMs: number
}

const FRAME_MS = Math.round(1000 / 30)

/**
 * What a video tag carries: a picture, the sequence's end, or anything else
 * (its header). A legacy AVC or HEVC tag says so in its second byte (1 a
 * picture, 2 the end); an enhanced one, its first byte's high bit set, in that
 * byte's low four bits (1 or 3 a picture, 2 the end).
 */
function videoPacket(tag: FlvTag): 'picture' | 'end' | 'other' {
  const first = tag.data[0]
  const enhanced = (first & 0x80) !== 0
  const type = enhanced ? first & 0x0f : tag.data[1]
  if (type === 2) return 'end'
  return type === 1 || (enhanced && type === 3) ? 'picture' : 'other'
}

/** A picture that starts a picture group: the frame type in its first byte is 1. */
export function isKeyframe(tag: FlvTag): boolean {
  return (
    tag.type === MSG.video &&
    ((tag.data[0] >> 4) & 0x7) === 1 &&
    videoPacket(tag) === 'picture'
  )
}

/** A fixture from its FLV: the first data, video and audio tags configure a connection. */
export function readFixture(label: string, flv: Buffer): Fixture {
  const tags = new FlvReader().push(flv)
  const config: FlvTag[] = []
  const media: FlvTag[] = []
  const seen = new Set<number>()
  for (const tag of tags) {
    if (!seen.has(tag.type)) {
      seen.add(tag.type)
      config.push(tag)
    } else if (tag.type !== MSG.video || videoPacket(tag) !== 'end') {
      // The muxer's end of sequence, at the file's end, would end the stream
      // mid-loop and could be resumed on: left out.
      media.push(tag)
    }
  }
  if (media.length === 0 || !media.some(isKeyframe)) {
    throw new Error(`the ${label} fixture has no keyframes`)
  }
  // Folded, not spread: a 30-minute fixture has some 100 000 tags.
  const last = media.reduce((most, tag) => Math.max(most, tag.timestamp), 0)
  return { label, config, media, loopMs: last + FRAME_MS }
}

export type AngleState = 'live' | 'cut' | 'ended' | 'refused'

export interface ReplayDeps {
  connect: (host: string, port: number) => RtmpSocket
  now: () => number
  setInterval: (fn: () => void, ms: number) => unknown
  clearInterval: (handle: unknown) => void
  sleep: (ms: number) => Promise<void>
  log: (line: string) => void
}

const nodeDeps: ReplayDeps = {
  connect: (host, port) => netConnect({ host, port }),
  now: Date.now,
  setInterval: (fn, ms) => setInterval(fn, ms),
  clearInterval: handle => {
    clearInterval(handle as NodeJS.Timeout)
  },
  sleep: async ms => {
    await new Promise(resolve => setTimeout(resolve, ms))
  },
  log: line => {
    console.log(line)
  }
}

/** How often the pump looks for tags that are due. */
export const TICK_MS = 10

/** One camera, replaying its fixture to the ingest. */
export class AngleReplay {
  state: AngleState = 'ended'
  startedAtMs = 0
  /** Why the ingest will not take it, once it has refused. */
  reason: string | null = null
  private rtmp: RtmpPublisher | null = null
  private timer: unknown = null
  private target: RtmpTarget | null = null
  /** The next tag to send: its loop and its place in the fixture's media. */
  private loop = 0
  private index = 0
  /** Subtracted from every timestamp sent: a discontinuity starts them from zero. */
  private tsShift = 0
  private reopening: Promise<void> | null = null
  /** Moved by each stop and cut: a cut whose sleep outlived it does not reopen. */
  private generation = 0

  constructor(
    readonly fixture: Fixture,
    private readonly deps: ReplayDeps = nodeDeps
  ) {}

  /** Starts at the fixture's beginning, its clock reading zero now. */
  async start(url: string): Promise<void> {
    await this.stop()
    this.target = parseRtmpUrl(url)
    this.reason = null
    this.startedAtMs = this.deps.now()
    this.loop = 0
    this.index = 0
    this.tsShift = 0
    await this.open()
  }

  /** Where the stream is now, in ms since it started. */
  private position(): number {
    return this.deps.now() - this.startedAtMs
  }

  /** Points the next tag at the first keyframe at or after the stream's position. */
  private seekToNow(): void {
    const at = this.position()
    this.loop = Math.floor(at / this.fixture.loopMs)
    const within = at - this.loop * this.fixture.loopMs
    const next = this.fixture.media.findIndex(
      tag => isKeyframe(tag) && tag.timestamp >= within
    )
    if (next < 0) {
      this.loop += 1
      this.index = this.fixture.media.findIndex(isKeyframe)
    } else this.index = next
  }

  private async open(): Promise<void> {
    const target = this.target!
    const rtmp = new RtmpPublisher(
      this.deps.connect(target.host, target.port),
      target
    )
    try {
      await rtmp.open()
    } catch (error) {
      rtmp.close()
      throw new Error(this.redact((error as Error).message))
    }
    this.rtmp = rtmp
    this.state = 'live'
    // At 0, as an encoder opens every connection: a metadata tag stamped
    // later reads to the ingest's FFmpeg as a second, data, stream.
    for (const tag of this.fixture.config)
      rtmp.sendTag({ ...tag, timestamp: 0 })
    this.timer = this.deps.setInterval(() => {
      this.pump()
    }, TICK_MS)
  }

  /** Sends every tag whose time has come. */
  pump(): void {
    const rtmp = this.rtmp
    if (rtmp == null) return
    if (rtmp.closed) {
      this.lost()
      return
    }
    const due = this.position()
    const { media, loopMs } = this.fixture
    for (;;) {
      const tag = media[this.index]
      const at = this.loop * loopMs + tag.timestamp
      if (at > due) return
      try {
        rtmp.sendTag({ ...tag, timestamp: at - this.tsShift })
      } catch {
        this.lost()
        return
      }
      this.index += 1
      if (this.index === media.length) {
        this.index = 0
        this.loop += 1
      }
    }
  }

  /** Drops the connection, as a camera that lost its link. */
  private drop(): void {
    if (this.timer != null) this.deps.clearInterval(this.timer)
    this.timer = null
    this.rtmp?.close()
    this.rtmp = null
  }

  /** The ingest closed the connection: one try to come back, which a refusal ends. */
  private lost(): void {
    if (this.reopening != null) return
    this.deps.log(
      `${this.fixture.label}: the ingest closed the connection; reconnecting once`
    )
    this.drop()
    this.state = 'cut'
    this.reopening = (async () => {
      await this.deps.sleep(5000)
      try {
        this.seekToNow()
        await this.open()
        this.deps.log(`${this.fixture.label}: back on the ingest`)
      } catch (error) {
        this.refuse(error as Error)
      }
    })().finally(() => {
      this.reopening = null
    })
  }

  private refuse(error: Error): void {
    this.state = 'refused'
    this.reason = error.message
    this.deps.log(`${this.fixture.label}: down: ${error.message}`)
  }

  /**
   * Drops the camera for `seconds`, then brings it back where the stream would
   * have been: its timestamps carry on, or start from zero with `discontinuity`.
   */
  async cut(seconds: number, discontinuity = false): Promise<void> {
    await this.reopening
    if (this.state === 'refused') {
      throw new Error(
        `the ${this.fixture.label} camera is down: the ingest refused it (${this.reason})`
      )
    }
    if (this.state !== 'live')
      throw new Error(`the ${this.fixture.label} camera is not running`)
    this.drop()
    this.state = 'cut'
    const cutAs = ++this.generation
    await this.deps.sleep(seconds * 1000)
    // A start, a stop or another cut came while it was away: that one owns the stream now.
    if (this.generation !== cutAs || this.target == null) return
    this.seekToNow()
    this.tsShift = discontinuity
      ? this.loop * this.fixture.loopMs +
        this.fixture.media[this.index].timestamp
      : this.tsShift
    for (let attempt = 1; ; attempt++) {
      try {
        await this.open()
        return
      } catch (error) {
        const message = (error as Error).message
        if (attempt === 3 || message.includes('refused')) {
          this.refuse(error as Error)
          throw error
        }
        this.deps.log(
          `${this.fixture.label}: could not reconnect (${message}); trying again`
        )
        await this.deps.sleep(10_000)
        // As after the cut: a start or stop meanwhile owns the stream now.
        if (this.generation !== cutAs || this.target == null) return
        this.seekToNow()
      }
    }
  }

  /** Ends the stream, as a camera that stopped. */
  async stop(): Promise<void> {
    await this.reopening
    this.generation++
    this.drop()
    this.target = null
    if (this.state !== 'refused') this.state = 'ended'
  }

  /** What the routes answer about it. */
  describe(): Record<string, unknown> {
    return {
      label: this.fixture.label,
      state: this.state,
      startedAtMs: this.startedAtMs,
      loopMs: this.fixture.loopMs,
      ...(this.reason == null ? {} : { reason: this.reason })
    }
  }

  private redact(line: string): string {
    const target = this.target
    if (target == null) return line
    let out = line
    for (const secret of [target.key, target.tcUrl]) {
      if (secret !== '') out = out.split(secret).join('[redacted]')
    }
    return out
  }
}

const ROUTE = /^\/__e2e\/publishers(?:\/([A-Za-z0-9]+)(\/cut)?)?$/

async function bodyOf(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  if (chunks.length === 0) return {}
  return JSON.parse(Buffer.concat(chunks).toString('utf8')) as Record<
    string,
    unknown
  >
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

/** The routes, over `angles`, behind `token`. */
export function replayHandler(
  angles: Map<string, AngleReplay>,
  token: string
): (req: IncomingMessage, res: ServerResponse) => Promise<void> {
  return async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://replay')
    if (url.pathname === '/__e2e/health' && req.method === 'GET') {
      json(res, 200, { status: 'ok' })
      return
    }
    if (req.headers.authorization !== `Bearer ${token}`) {
      json(res, 401, { error: 'the token is missing or wrong' })
      return
    }
    const match = ROUTE.exec(url.pathname)
    if (match == null) {
      json(res, 404, { error: `no route ${req.method} ${url.pathname}` })
      return
    }
    const [, label, cut] = match
    if (label == null) {
      if (req.method !== 'GET') {
        json(res, 405, { error: `${req.method} is not a method here` })
        return
      }
      json(res, 200, {
        publishers: [...angles.values()].map(angle => angle.describe())
      })
      return
    }
    const angle = angles.get(label)
    if (angle == null) {
      json(res, 404, { error: `no fixture for ${label}` })
      return
    }
    try {
      const body = await bodyOf(req)
      if (cut != null && req.method === 'POST') {
        await angle.cut(Number(body.seconds), body.discontinuity === true)
      } else if (cut == null && req.method === 'PUT') {
        if (typeof body.url !== 'string') {
          json(res, 400, { error: 'PUT wants { url }' })
          return
        }
        await angle.start(body.url)
      } else if (cut == null && req.method === 'DELETE') {
        await angle.stop()
      } else {
        json(res, 405, { error: `${req.method} is not a method here` })
        return
      }
      json(res, 200, angle.describe())
    } catch (error) {
      json(res, 502, { error: (error as Error).message, ...angle.describe() })
    }
  }
}

/** The command line's options. */
export function parseReplayArgs(argv: string[]): {
  fixtures: string
  tokenFile: string
  port: number
  /** Where it listens: the loopback, unless a stack's droplets are to reach it. */
  host: string
  labels: string[]
} {
  const values: Record<string, string> = {}
  for (let i = 0; i < argv.length; i += 2) {
    if (!argv[i].startsWith('--') || argv[i + 1] == null) {
      throw new Error(`unknown or empty option ${argv[i]}`)
    }
    values[argv[i].slice(2)] = argv[i + 1]
  }
  for (const flag of ['fixtures', 'token-file']) {
    if (values[flag] == null) throw new Error(`--${flag} is needed`)
  }
  return {
    fixtures: values.fixtures,
    tokenFile: values['token-file'],
    port: Number(values.port ?? 9400),
    host: values.host ?? '127.0.0.1',
    labels: (values.labels ?? 'SynthA,SynthB,SynthC,SynthD,Synthetic').split(
      ','
    )
  }
}

if (require.main === module) {
  const options = parseReplayArgs(process.argv.slice(2))
  const angles = new Map(
    options.labels.map(label => [
      label,
      new AngleReplay(
        readFixture(label, readFileSync(join(options.fixtures, `${label}.flv`)))
      )
    ])
  )
  const token = readFileSync(options.tokenFile, 'utf8').trim()
  const handle = replayHandler(angles, token)
  createServer((req, res) => {
    handle(req, res).catch((error: unknown) => {
      json(res, 500, { error: String(error) })
    })
  }).listen(options.port, options.host, () => {
    console.log(
      `replaying ${options.labels.join(', ')} on ${options.host}:${options.port}`
    )
  })
}
