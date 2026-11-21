import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import { createServer } from 'node:http'
import type { AddressInfo } from 'node:net'

import { WebSocketServer } from 'ws'

import {
  type FakeAnswer,
  type FakeAnthropic,
  fakeAnthropic,
  type ScriptEntry
} from '../../src/test/fakeAnthropic'

/**
 * The services a stack's server calls that a test scripts: Tess's model and
 * dictation's recogniser, each on a loopback port of its own, and what the
 * fault server does on the way to the API for them, a read delay and a log
 * of the requests it forwarded. The fault server hosts them; `stackConfig.ts`
 * points the server at their ports.
 */

/** Where the scripted model listens: Tess's and dictation's Anthropic. */
export const MODEL_PORT = 9301
/** Where the speech recogniser listens: dictation's xAI STT socket. */
export const SPEECH_PORT = 9302
/** The path the recogniser answers on, as xAI's does. */
export const SPEECH_PATH = '/v1/stt'
/** What the recogniser hears until a test says otherwise. */
export const DEFAULT_HEARD = 'Where are my team settings?'
/** How many forwarded requests the log keeps. */
const LOG_LIMIT = 5000

/** A script entry as JSON carries it: the pattern by its source and flags. */
export interface WireScriptEntry {
  match: { source: string; flags: string }
  rounds: FakeAnswer[]
}

/**
 * A script for the wire: its patterns written out. An answer that takes no
 * argument is one that only waited for something the script's maker knows
 * by now, such as the origin, and is written as what it answers; one that
 * reads the request cannot go.
 */
export function toWire(entries: readonly ScriptEntry[]): WireScriptEntry[] {
  return entries.map(entry => ({
    match: { source: entry.match.source, flags: entry.match.flags },
    rounds: entry.rounds.map(round => {
      if (typeof round !== 'function') return round
      if (round.length === 0) return (round as () => FakeAnswer)()
      throw new Error(
        `the script for /${entry.match.source}/ answers from the request, which a stack cannot run`
      )
    })
  }))
}

/** A script read off the wire, or an error saying what is wrong with it. */
export function fromWire(value: unknown): ScriptEntry[] {
  if (!Array.isArray(value)) throw new Error('the script is not a list')
  return value.map((row, index) => {
    const entry = row as Partial<WireScriptEntry>
    if (
      typeof entry.match?.source !== 'string' ||
      typeof entry.match.flags !== 'string' ||
      !Array.isArray(entry.rounds)
    ) {
      throw new Error(
        `script entry ${index} needs match.source, match.flags and rounds`
      )
    }
    return {
      match: new RegExp(entry.match.source, entry.match.flags),
      rounds: entry.rounds
    }
  })
}

/** The recogniser: what it says it heard, and what it was asked to hear. */
export interface Speech {
  heard: string
  /** Utterances started: audio after the last one ended. */
  begun: number
  /** What each finished utterance was heard as. */
  said: string[]
}

/**
 * xAI's STT socket, as `src/server/dictation/stt.ts` speaks to it: a socket
 * is ready once it says `transcript.created`; audio starts an utterance;
 * `finalize` ends it, answered with one `transcript.partial` flagged
 * `speech_final` carrying what the recogniser hears; `audio.done` ends the
 * socket.
 */
export async function startSpeech(
  speech: Speech,
  host: string,
  port: number
): Promise<{ server: Server; url: string }> {
  const server = createServer((_req, res) => {
    res.writeHead(404)
    res.end()
  })
  const sockets = new WebSocketServer({ server, path: SPEECH_PATH })
  sockets.on('connection', socket => {
    let speaking = false
    socket.send(JSON.stringify({ type: 'transcript.created' }))
    socket.on('message', (data, binary) => {
      if (binary) {
        if (!speaking) speech.begun++
        speaking = true
        return
      }
      let message: { type?: unknown }
      try {
        message = JSON.parse((data as Buffer).toString()) as { type?: unknown }
      } catch {
        return
      }
      if (message.type === 'finalize') {
        speaking = false
        speech.said.push(speech.heard)
        socket.send(
          JSON.stringify({
            type: 'transcript.partial',
            text: speech.heard,
            speech_final: true
          })
        )
      } else if (message.type === 'audio.done') {
        socket.close()
      }
    })
  })
  await listen(server, host, port)
  return { server, url: `ws://${host}:${portOf(server)}${SPEECH_PATH}` }
}

/** The API requests the fault server forwarded, newest last. */
export interface Forwarded {
  at: number
  method: string
  path: string
}

export interface StandIns {
  model: FakeAnthropic
  speech: Speech
  /** API reads held back, by path prefix, and for how long. */
  delay: { prefix: string; ms: number } | null
  /** Hits on `/__tess/beacon`, which a remote load from rich HTML makes. */
  beaconHits: number
  forwarded: Forwarded[]
  speechUrl: string
  close: () => Promise<void>
}

/** The scripted model and the recogniser, on their loopback ports. */
export async function startStandIns(
  options: { host?: string; modelPort?: number; speechPort?: number } = {}
): Promise<StandIns> {
  const host = options.host ?? '127.0.0.1'
  const model = await fakeAnthropic({
    host,
    port: options.modelPort ?? MODEL_PORT,
    cacheTokens: { write: 300, read: 900 }
  })
  const speech: Speech = { heard: DEFAULT_HEARD, begun: 0, said: [] }
  const recogniser = await startSpeech(
    speech,
    host,
    options.speechPort ?? SPEECH_PORT
  )
  const standIns: StandIns = {
    model,
    speech,
    delay: null,
    beaconHits: 0,
    forwarded: [],
    speechUrl: recogniser.url,
    close: async () => {
      await model.close()
      await new Promise<void>(resolve => {
        recogniser.server.close(() => {
          resolve()
        })
        recogniser.server.closeAllConnections()
      })
    }
  }
  return standIns
}

/** How long the proxy holds a request for `path` before it forwards it. */
export function delayFor(standIns: StandIns, path: string): number {
  const delay = standIns.delay
  return delay != null && path.startsWith(delay.prefix) ? delay.ms : 0
}

/** Logs a request the proxy forwards, keeping the newest. */
export function logForwarded(
  standIns: StandIns,
  method: string,
  path: string,
  at = Date.now()
): void {
  standIns.forwarded.push({ at, method, path })
  if (standIns.forwarded.length > LOG_LIMIT) standIns.forwarded.shift()
}

function json(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' })
  res.end(JSON.stringify(body))
}

async function bodyOf(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = []
  for await (const chunk of req) chunks.push(chunk as Buffer)
  const text = Buffer.concat(chunks).toString()
  return text === '' ? undefined : JSON.parse(text)
}

/**
 * The stand-ins' routes. `/__tess/beacon` is public, as the scripted HTML
 * reaches it; the rest are under `/__e2e/` and the caller has checked the
 * token:
 *
 *   PUT /__e2e/model/script  [{ match: { source, flags }, rounds }]
 *   GET /__e2e/model/calls   { calls, totals }
 *   PUT /__e2e/speech        { heard }
 *   GET /__e2e/speech        { heard, begun, said }
 *   PUT /__e2e/delay         { prefix, ms } | null
 *   GET /__e2e/beacon        { hits }
 *   GET /__e2e/requests?since=<ms>&path=<prefix>  { requests }
 *
 * Answers true when the route was one of these.
 */
export function standInRoute(
  standIns: StandIns,
  route: string,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL
): boolean {
  const put = (apply: (body: unknown) => unknown): void => {
    bodyOf(req)
      .then(body => {
        json(res, 200, apply(body))
      })
      .catch((error: unknown) => {
        json(res, 400, {
          error: error instanceof Error ? error.message : String(error)
        })
      })
  }
  if (route === 'model/script' && req.method === 'PUT') {
    put(body => {
      standIns.model.setScript(fromWire(body))
      return { entries: (body as unknown[]).length }
    })
  } else if (route === 'model/calls' && req.method === 'GET') {
    json(res, 200, {
      calls: standIns.model.calls,
      totals: standIns.model.totals()
    })
  } else if (route === 'speech' && req.method === 'PUT') {
    put(body => {
      const heard = (body as { heard?: unknown } | undefined)?.heard
      if (typeof heard !== 'string') throw new Error('heard is a string')
      standIns.speech.heard = heard
      return { heard }
    })
  } else if (route === 'speech' && req.method === 'GET') {
    json(res, 200, standIns.speech)
  } else if (route === 'delay' && req.method === 'PUT') {
    put(body => {
      if (body == null) {
        standIns.delay = null
        return { delay: null }
      }
      const { prefix, ms } = body as { prefix?: unknown; ms?: unknown }
      if (
        typeof prefix !== 'string' ||
        !prefix.startsWith('/') ||
        typeof ms !== 'number' ||
        ms < 0 ||
        ms > 60000
      ) {
        throw new Error('the delay is null or { prefix: "/…", ms: 0 to 60000 }')
      }
      standIns.delay = { prefix, ms }
      return { delay: standIns.delay }
    })
  } else if (route === 'beacon' && req.method === 'GET') {
    json(res, 200, { hits: standIns.beaconHits })
  } else if (route === 'requests' && req.method === 'GET') {
    const since = Number(url.searchParams.get('since') ?? 0)
    const prefix = url.searchParams.get('path') ?? '/'
    json(res, 200, {
      requests: standIns.forwarded.filter(
        row => row.at >= since && row.path.startsWith(prefix)
      )
    })
  } else {
    return false
  }
  return true
}

/** Answers and counts `/__tess/beacon`; true when the request was it. */
export function beaconRoute(
  standIns: StandIns,
  req: IncomingMessage,
  res: ServerResponse
): boolean {
  const path = new URL(req.url ?? '/', 'http://faults').pathname
  if (path !== '/__tess/beacon') return false
  standIns.beaconHits++
  res.writeHead(204)
  res.end()
  return true
}

async function listen(
  server: Server,
  host: string,
  port: number
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(port, host, () => {
      server.off('error', reject)
      resolve()
    })
  })
}

function portOf(server: Server): number {
  return (server.address() as AddressInfo).port
}
