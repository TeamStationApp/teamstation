import { randomUUID } from 'node:crypto'
import type { IncomingMessage, Server } from 'node:http'
import type { Duplex } from 'node:stream'

import type { Kysely } from 'kysely'
import { type RawData, type WebSocket, WebSocketServer } from 'ws'

import {
  asDictationUp,
  DICTATION_MODEL_NAMES,
  type DictationModel,
  type DictationReply,
  type DictationStart,
  type DictationUp
} from '../../common/api'
import { HttpError } from '../../common/errors'
import { type Actor, actorForToken } from '../auth/sessions'
import { sessionToken } from '../auth/tokens'
import type { Database } from '../db/database'
import {
  type AskOption,
  Interpretation,
  type InterpreterConfig,
  type Turn
} from './interpreter'
import { endpointFor, type ProviderKeys } from './models'
import { type Scope, SCOPES } from './scopes'
import { type SttHandlers, SttSession } from './stt'

/**
 * `WS /api/v1/dictation` — one socket for everything a person says to
 * GameStation.
 *
 * It never touches a game. It turns speech into a transcript and a transcript
 * into actions, and sends the actions back; the client applies them through
 * the same reducer a tap goes through, and that is what saves. A connection
 * holds only its recogniser, the utterance in flight, and — while the LLM is
 * asking the scorer something — that utterance's conversation.
 */

export const DICTATION_PATH = '/api/v1/dictation'

export interface DictationConfig extends ProviderKeys {
  sttUrl: string
  sttModel: string
  /** The LLM an utterance goes to when the scorer picked none. */
  model: string
}

/** The recogniser, as the route drives it. */
export type Recogniser = Pick<
  SttSession,
  'retarget' | 'begin' | 'write' | 'end' | 'close'
>

/** One utterance's conversation with the LLM, as the route drives it. */
export type Conversation = Pick<Interpretation, 'start' | 'answer'>

export interface DictationOptions {
  db: Kysely<Database>
  config: DictationConfig
  scopes?: ReadonlyMap<string, Scope>
  /** Swapped out in tests. */
  openRecogniser?: (handlers: SttHandlers) => Recogniser
  /** Swapped out in tests. */
  converse?: (
    config: InterpreterConfig,
    context: string,
    transcript: string
  ) => Conversation
  log?: (message: string) => void
  /**
   * The pages that may open the socket, checked against a browser's `Origin`
   * the way `withCors` checks the HTTP routes: a browser sends the session
   * cookie to any same-site page's socket, and SameSite=Lax makes every
   * gamestation.co host same-site. A request with no `Origin` — the phone, a
   * script — is not a browser page and is admitted on its token alone.
   * Absent, any origin is admitted.
   */
  allowedOrigins?: readonly string[]
  /**
   * False when the server's one upgrade listener (`bindUpgrades`) calls
   * `acceptUpgrade`. Default true: the route listens for upgrades itself and
   * leaves every other path to whatever else listens there.
   */
  listenForUpgrades?: boolean
}

type Phase = 'authorising' | 'holding' | 'released' | 'interpreting' | 'asking'

interface InFlight {
  start: DictationStart
  /** The LLM this utterance goes to. */
  model: string
  scope: Scope
  phase: Phase
  /** Audio that arrived while the `start` was being authorised. */
  held: Buffer[]
  releasedEarly: boolean
  audioBytes: number
  startedAt: number
  transcript: string
  conversation?: Conversation
  options?: AskOption[]
}

/**
 * Mounts the route on the HTTP server's upgrade. Every other path is left for
 * whatever else listens there. `acceptUpgrade` takes a dictation upgrade, for
 * a server whose one listener asks each socket in turn.
 */
export function attachDictation(
  server: Server,
  options: DictationOptions
): {
  acceptUpgrade: (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ) => boolean
  close: () => void
} {
  const wss = new WebSocketServer({ noServer: true })
  const listens = options.listenForUpgrades !== false
  // Node hands a request carrying `Upgrade` to the upgrade listeners, and
  // only to them, once there are any — including a plain request asking for
  // h2c. Only the dictation path is claimed as an upgrade; everything else is
  // an ordinary request for express, or for another upgrade listener. Node
  // before 24.9 has no such hook, and every upgrade reaches the listeners.
  const upgradable = server as Server & {
    shouldUpgradeCallback?: (request: IncomingMessage) => boolean
  }
  const previous = upgradable.shouldUpgradeCallback
  const claimsOnlyItsOwn = listens && typeof previous === 'function'
  if (claimsOnlyItsOwn)
    upgradable.shouldUpgradeCallback = request =>
      pathOf(request.url) === DICTATION_PATH ||
      server.listenerCount('upgrade') > 1
  // Takes the socket — accepting or answering it — only for the dictation
  // path; any other is left as it arrived.
  const acceptUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): boolean => {
    if (pathOf(request.url) !== DICTATION_PATH) return false
    const origin = request.headers.origin
    if (
      origin != null &&
      options.allowedOrigins != null &&
      !options.allowedOrigins.some(
        allowed => allowed.replace(/\/+$/, '') === origin.replace(/\/+$/, '')
      )
    ) {
      refuse(socket, 403, 'Forbidden')
      return true
    }
    admit(options.db, request).then(
      actor => {
        if (actor == null) {
          refuse(socket, 401, 'Unauthorized')
          return
        }
        wss.handleUpgrade(request, socket, head, ws => {
          serve(ws, actor, options)
        })
      },
      (error: unknown) => {
        ;(options.log ?? console.error)(
          `dictation: could not read the actor: ${String(error)}`
        )
        refuse(socket, 500, 'Internal Server Error')
      }
    )
    return true
  }
  const onUpgrade = (
    request: IncomingMessage,
    socket: Duplex,
    head: Buffer
  ): void => {
    if (acceptUpgrade(request, socket, head)) return
    // Another listener's path. Without the hook, a request nobody else
    // listens for would hang where express would have answered it.
    if (!claimsOnlyItsOwn && server.listenerCount('upgrade') === 1)
      refuse(socket, 404, 'Not Found')
  }
  if (listens) server.on('upgrade', onUpgrade)
  return {
    acceptUpgrade,
    close: () => {
      if (listens) server.off('upgrade', onUpgrade)
      if (claimsOnlyItsOwn) upgradable.shouldUpgradeCallback = previous
      for (const client of wss.clients) client.close(1001, 'Server stopping')
      wss.close()
    }
  }
}

/** The actor, read the way `withActor` reads it: a bearer token or the session cookie. */
async function admit(
  db: Kysely<Database>,
  request: IncomingMessage
): Promise<Actor | undefined> {
  const token = sessionToken(
    request.headers.authorization,
    request.headers.cookie
  )
  if (token == null) return undefined
  return await actorForToken(db, token)
}

function refuse(socket: Duplex, status: number, reason: string): void {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`
  )
}

function pathOf(url: string | undefined): string {
  const path = (url ?? '').split('?')[0]
  return path.replace(/\/+$/, '')
}

/** One browser's dictation, from enabling it to switching it off. */
function serve(ws: WebSocket, actor: Actor, options: DictationOptions): void {
  // One scorer's sentences reach the provider server holding the cached
  // prompt; different scorers are spread across servers.
  const cacheKey = randomUUID()
  const { config } = options
  const scopes = options.scopes ?? SCOPES
  const log =
    options.log ??
    ((message: string) => {
      console.log(message)
    })
  let current: InFlight | null = null
  let closed = false

  const send = (reply: DictationReply): void => {
    if (!closed) ws.send(JSON.stringify(reply))
  }
  const fail = (id: string | null, message: string): void => {
    send({ kind: 'error', id, message })
  }
  const finish = (flight: InFlight, outcome: string): void => {
    if (current === flight) current = null
    log(
      `dictation ${flight.start.id} user ${actor.userId} ${outcome} after ${Date.now() - flight.startedAt}ms`
    )
  }

  const recogniser = (
    options.openRecogniser ??
    (handlers =>
      new SttSession(
        { apiKey: config.apiKey, url: config.sttUrl, model: config.sttModel },
        handlers
      ))
  )({
    onPartial: text => {
      if (
        current != null &&
        (current.phase === 'holding' || current.phase === 'released')
      )
        send({ kind: 'partial', id: current.start.id, text })
    },
    onFinal: text => {
      const flight = current
      if (flight?.phase !== 'released') return
      send({ kind: 'transcript', id: flight.start.id, text })
      if (text.trim() === '') {
        fail(flight.start.id, 'Nothing was heard')
        finish(flight, 'heard nothing')
        return
      }
      flight.phase = 'interpreting'
      flight.transcript = text
      const conversation = (
        options.converse ??
        ((c, context, t) => new Interpretation(c, context, t))
      )(
        {
          ...endpointFor(flight.model, config)!,
          model: flight.model,
          tools: flight.scope.tools,
          cacheKey
        },
        flight.start.context,
        text
      )
      flight.conversation = conversation
      conversation.start().then(
        turn => {
          answered(flight, turn)
        },
        (error: unknown) => {
          answered(flight, { kind: 'error', message: String(error) })
        }
      )
    },
    onError: message => {
      const flight = current
      if (
        flight == null ||
        (flight.phase !== 'holding' && flight.phase !== 'released')
      )
        return
      fail(flight.start.id, message)
      finish(flight, `recogniser failed: ${message}`)
    }
  })

  /** What the LLM came back with, for an utterance still waiting on it. */
  const answered = (flight: InFlight, turn: Turn): void => {
    if (current !== flight || closed) return
    const { id } = flight.start
    const { transcript } = flight
    switch (turn.kind) {
      case 'actions':
        send({
          kind: 'actions',
          id,
          transcript,
          actions: turn.actions,
          dropped: turn.dropped
        })
        finish(
          flight,
          `${turn.actions.length} actions, ${turn.dropped.length} dropped`
        )
        return
      case 'ask':
        flight.phase = 'asking'
        flight.options = turn.options
        send({
          kind: 'ask',
          id,
          question: turn.question,
          options: turn.options
        })
        log(`dictation ${id} asks with ${turn.options.length} options`)
        return
      case 'error':
        fail(id, turn.message)
        finish(flight, `error: ${turn.message}`)
    }
  }

  const release = (flight: InFlight): void => {
    if (flight.audioBytes === 0) {
      recogniser.end()
      fail(flight.start.id, 'No audio arrived before the button was released')
      finish(flight, 'released with no audio')
      return
    }
    flight.phase = 'released'
    recogniser.end()
  }

  const onStart = async (start: DictationStart): Promise<void> => {
    if (current != null) {
      fail(start.id, 'The last thing said is still being answered')
      return
    }
    const scope = scopes.get(start.scope)
    if (scope == null) {
      fail(start.id, `Dictation cannot talk about ${start.scope}`)
      return
    }
    const model = start.model ?? config.model
    if (endpointFor(model, config) == null) {
      fail(
        start.id,
        `${DICTATION_MODEL_NAMES[model as DictationModel] ?? model} is not set up on this server`
      )
      return
    }
    const flight: InFlight = {
      start,
      model,
      scope,
      phase: 'authorising',
      held: [],
      releasedEarly: false,
      audioBytes: 0,
      transcript: '',
      startedAt: Date.now()
    }
    current = flight
    try {
      await scope.authorise(options.db, actor, start.target)
    } catch (error) {
      const message =
        error instanceof HttpError && error.status === 404
          ? 'That game is not one you can dictate for'
          : error instanceof HttpError || error instanceof TypeError
            ? error.message
            : 'Dictation could not check that game'
      if (!(error instanceof HttpError) && !(error instanceof TypeError))
        log(`dictation ${start.id} could not authorise: ${String(error)}`)
      if (current === flight) {
        fail(start.id, message)
        finish(flight, 'refused')
      }
      return
    }
    if (current !== flight || closed) return
    // Only now does any of the utterance's audio reach the recogniser.
    recogniser.begin()
    flight.phase = 'holding'
    for (const pcm of flight.held) recogniser.write(pcm)
    flight.held = []
    if (flight.releasedEarly) release(flight)
  }

  const onControl = (frame: DictationUp): void => {
    switch (frame.kind) {
      case 'keyterms':
        recogniser.retarget(frame.keyterms)
        return
      case 'start':
        onStart(frame).catch((error: unknown) => {
          log(`dictation ${frame.id} failed to start: ${String(error)}`)
        })
        return
      case 'release': {
        const flight = current
        if (flight?.start.id !== frame.id) return
        if (flight.phase === 'authorising') flight.releasedEarly = true
        else if (flight.phase === 'holding') release(flight)
        return
      }
      case 'answer': {
        const flight = current
        if (flight?.start.id !== frame.id || flight.phase !== 'asking') {
          fail(frame.id, 'No question is open for that')
          return
        }
        if (frame.option >= (flight.options?.length ?? 0)) {
          fail(frame.id, `There is no option ${frame.option}`)
          return
        }
        const conversation = flight.conversation
        if (conversation == null) return
        flight.phase = 'interpreting'
        conversation.answer(frame.option).then(
          turn => {
            answered(flight, turn)
          },
          (error: unknown) => {
            answered(flight, { kind: 'error', message: String(error) })
          }
        )
        return
      }
      case 'dismiss': {
        const flight = current
        if (flight?.start.id !== frame.id || flight.phase !== 'asking') return
        finish(flight, 'dismissed')
      }
    }
  }

  ws.on('message', (data: RawData, isBinary: boolean) => {
    if (isBinary) {
      const flight = current
      const pcm = toBuffer(data)
      // Audio outside a hold is dropped here and never reaches the recogniser.
      if (flight == null) return
      if (flight.phase === 'authorising' && !flight.releasedEarly) {
        flight.held.push(pcm)
        flight.audioBytes += pcm.length
      } else if (flight.phase === 'holding') {
        flight.audioBytes += pcm.length
        recogniser.write(pcm)
      }
      return
    }
    let frame: DictationUp
    try {
      frame = asDictationUp(JSON.parse(toBuffer(data).toString('utf8')))
    } catch (error) {
      fail(
        null,
        `Not a dictation frame: ${error instanceof Error ? error.message : String(error)}`
      )
      return
    }
    onControl(frame)
  })

  ws.on('close', () => {
    closed = true
    if (current != null) finish(current, 'abandoned: the socket closed')
    recogniser.close()
  })
  ws.on('error', error => {
    log(`dictation socket for user ${actor.userId}: ${error.message}`)
  })
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data
  if (Array.isArray(data)) return Buffer.concat(data)
  return Buffer.from(data)
}
