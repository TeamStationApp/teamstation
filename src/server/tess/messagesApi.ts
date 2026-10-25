import { HttpError } from '../../common/errors'
import type { Property } from '../../common/observability/contract'
import {
  type ServerSentEvent,
  serverSentEvents
} from '../../common/serverSentEvents'
import { emitLog } from '../observability/logging'
import type { TessSettings } from '../serverConfig'

/**
 * Anthropic's Messages API, for Tess: one request per call, over plain
 * `fetch` as dictation's interpreter does, with a deadline. A provider's
 * failure becomes an `HttpError` naming its status and error type, never its
 * body, which can quote the request back. A request refused for its length
 * says so in the error's details (`tooLong`), and one refused for its bytes
 * (`tooLarge`), so the conversation can be made shorter and sent again.
 *
 * A turn's answers are streamed (`streamMessage`), so the app can show her
 * thinking and her text as they come; summaries and descriptions are not.
 * Either way the answer is the same blocks, which the conversation stores.
 */

export const ANTHROPIC_VERSION = '2023-06-01'
/**
 * The model's thinking blocks are bound to the conversation they were made
 * in: the system prompt, the tools and every earlier message. Tess's history
 * does not stay byte for byte the same between requests (a deploy changes
 * the sitemap in the system prompt; compaction summarizes older turns and
 * turns attachments into descriptions), so a replayed block can be bound to
 * a prefix that no longer exists. With this beta, `drop_block` makes the API
 * drop such a block and every thinking block after it, unbilled, and answer;
 * without it the whole request is refused, and so is every request after.
 */
export const THINKING_BINDING_BETA = 'thinking-binding-controls-2026-08-01'
export const THINKING = {
  type: 'adaptive',
  // Thinking blocks carry a readable summary of her reasoning, which the app
  // shows; the reasoning itself never leaves the provider. Only what the
  // block shows changes, not what it is bound to.
  display: 'summarized',
  block_binding: { prefix_mismatch_behavior: 'drop_block' }
} as const
export const MAX_TOKENS = 8192
export const DEADLINE_MS = 120000

export interface TextBlock {
  type: 'text'
  text: string
}
export interface ImageBlock {
  type: 'image'
  source: { type: 'base64'; media_type: string; data: string }
}
export interface ToolUseBlock {
  type: 'tool_use'
  id: string
  name: string
  input: unknown
}
export interface ToolResultBlock {
  type: 'tool_result'
  tool_use_id: string
  content: string | Array<TextBlock | ImageBlock>
  is_error?: boolean
}
/**
 * Her reasoning, as a summary, signed by the provider: stored and sent back
 * exactly as it came.
 */
export interface ThinkingBlock {
  type: 'thinking'
  thinking: string
  signature: string
}
export interface RedactedThinkingBlock {
  type: 'redacted_thinking'
  data: string
}
export type ContentBlock =
  | TextBlock
  | ImageBlock
  | ToolUseBlock
  | ToolResultBlock
  | ThinkingBlock
  | RedactedThinkingBlock

export interface MessageParam {
  role: 'user' | 'assistant'
  content: string | ContentBlock[]
}

/** A block of the system prompt. A cached one is the end of a cached prefix. */
export interface SystemBlock {
  text: string
  cached?: boolean
}

export interface ToolDefinition {
  name: string
  description: string
  input_schema: Record<string, unknown>
}

export interface MessagesRequest {
  system: SystemBlock[]
  messages: MessageParam[]
  /**
   * Without tools, neither `tools` nor `tool_choice` is sent: compaction's
   * summaries and attachment descriptions are plain requests.
   */
  tools?: ToolDefinition[]
  /** `auto` unless said; `none` for the closing call at the tool-round cap. */
  toolChoice?: 'auto' | 'none'
  /**
   * The conversation is a cached prefix too: its last block ends one, so the
   * next tool round, and the next turn, read all of it before that from the
   * cache. Only for requests the next one extends: a summary or a
   * description is sent once.
   */
  cacheMessages?: boolean
}

/** What one call used, in the provider's four counts. */
export interface MessagesUsage {
  inputTokens: number
  cacheCreationInputTokens: number
  cacheReadInputTokens: number
  outputTokens: number
}

export interface MessagesResponse {
  content: ContentBlock[]
  stopReason: string
  usage: MessagesUsage
}

export interface MessagesOptions {
  fetch?: typeof fetch
  deadlineMs?: number
  /** Whose call it is, for the log. */
  actor?: string
}

/** `POST /messages`, logged as `tess_request` whatever its outcome. */
export async function createMessage(
  settings: TessSettings,
  request: MessagesRequest,
  options: MessagesOptions = {}
): Promise<MessagesResponse> {
  return await logged(options, async log =>
    responseOf(
      await post(
        settings,
        '/messages',
        { ...bodyOf(settings, request), max_tokens: MAX_TOKENS },
        options,
        log
      )
    )
  )
}

/** What a streamed answer tells as it comes, block by block. */
export interface MessagesStreamEvent {
  /** A piece of her thinking's summary, or of her text. */
  type: 'thinking' | 'text'
  delta: string
  /** The content block it belongs to. */
  index: number
}

/**
 * `POST /messages`, streamed: each piece of her thinking's summary and of
 * her text goes to `onEvent` as it arrives, and the answer is the blocks the
 * stream builds, exactly the ones `createMessage` would answer, signatures
 * and tool inputs included, so the conversation stores the same thing. The
 * deadline is for the wait before each piece. A failure, before the stream
 * or in it, is the error `createMessage` would throw.
 */
export async function streamMessage(
  settings: TessSettings,
  request: MessagesRequest,
  onEvent: (event: MessagesStreamEvent) => void,
  options: MessagesOptions = {}
): Promise<MessagesResponse> {
  return await logged(options, async log => {
    const wait = deadline(options.deadlineMs ?? DEADLINE_MS)
    try {
      let response: Response
      try {
        response = await send(
          settings,
          '/messages',
          {
            ...bodyOf(settings, request),
            max_tokens: MAX_TOKENS,
            stream: true
          },
          options,
          wait.signal
        )
      } catch {
        throw lost(wait, log)
      }
      log.status = response.status
      if (!response.ok || response.body == null) {
        let text: string
        try {
          text = await response.text()
        } catch {
          throw lost(wait, log)
        }
        if (!response.ok) throw refused(response.status, parse(text), log)
        log.ec = 'invalid'
        throw unreadable()
      }
      const answer = streamedAnswer(onEvent, log)
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      const events = serverSentEvents()
      // Every whole event so far, in order; a part waits for the next chunk.
      const take = (text: string): void => {
        for (const event of events.push(text)) answer.take(event)
      }
      try {
        while (!answer.finished()) {
          let chunk: Awaited<ReturnType<typeof reader.read>>
          try {
            chunk = await reader.read()
          } catch {
            throw lost(wait, log)
          }
          if (chunk.done) break
          wait.renew()
          take(decoder.decode(chunk.value, { stream: true }))
        }
      } finally {
        // Released however the read ends: an error event or an unreadable
        // one leaves the rest of the body unread.
        reader.cancel().catch(() => undefined)
      }
      take(decoder.decode())
      for (const event of events.end()) answer.take(event)
      // The connection ended before the message did: cut, not unreadable.
      if (!answer.finished()) throw lost(wait, log)
      return answer.response()
    } finally {
      wait.clear()
    }
  })
}

/**
 * One call, timed and logged as `tess_request` with what it used, whatever
 * its outcome. `call` fills the log with the status and, on a failure, the
 * error class.
 */
async function logged(
  options: MessagesOptions,
  call: (log: Record<string, Property>) => Promise<MessagesResponse>
): Promise<MessagesResponse> {
  const start = performance.now()
  const log: Record<string, Property> = {}
  try {
    const response = await call(log)
    const { usage } = response
    log.it = tokens(
      usage.inputTokens +
        usage.cacheCreationInputTokens +
        usage.cacheReadInputTokens
    )
    log.ot = tokens(usage.outputTokens)
    return response
  } catch (error) {
    // Only an answer that is not a message gets here unclassified.
    log.ec ??= 'invalid'
    throw error
  } finally {
    emitLog(
      'tess_request',
      {
        op: 'assistant',
        ms: Math.min(86400000, Math.max(0, performance.now() - start)),
        ...log
      },
      log.ec == null ? 'info' : 'error',
      options.actor
    )
  }
}

/** `POST /messages/count_tokens`: what the request would take as input. */
export async function countTokens(
  settings: TessSettings,
  request: MessagesRequest,
  options: MessagesOptions = {}
): Promise<number> {
  const body = await post(
    settings,
    '/messages/count_tokens',
    bodyOf(settings, request),
    options,
    {}
  )
  const count = body.input_tokens
  if (typeof count !== 'number' || !Number.isFinite(count) || count < 0)
    throw unreadable()
  return count
}

/** The body both endpoints share. */
function bodyOf(
  settings: TessSettings,
  request: MessagesRequest
): Record<string, unknown> {
  const tools = request.tools ?? []
  return {
    model: settings.model,
    thinking: THINKING,
    system: request.system.map(block =>
      block.cached === true
        ? {
            type: 'text',
            text: block.text,
            cache_control: { type: 'ephemeral' }
          }
        : { type: 'text', text: block.text }
    ),
    messages:
      request.cacheMessages === true
        ? cachedLast(request.messages)
        : request.messages,
    ...(tools.length === 0
      ? {}
      : { tools, tool_choice: { type: request.toolChoice ?? 'auto' } })
  }
}

/** The messages with a cache breakpoint on the last block of the last one. */
function cachedLast(messages: MessageParam[]): unknown[] {
  const last = messages.at(-1)
  if (last == null) return messages
  const blocks =
    typeof last.content === 'string'
      ? [{ type: 'text', text: last.content }]
      : last.content
  if (blocks.length === 0) return messages
  return [
    ...messages.slice(0, -1),
    {
      ...last,
      content: [
        ...blocks.slice(0, -1),
        { ...blocks.at(-1), cache_control: { type: 'ephemeral' } }
      ]
    }
  ]
}

/** A wait that gives up after `ms` without progress; `renew` starts it again. */
interface Deadline {
  ms: number
  signal: AbortSignal
  expired: () => boolean
  renew: () => void
  clear: () => void
}

function deadline(ms: number): Deadline {
  const controller = new AbortController()
  let expired = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const start = (): void => {
    timer = setTimeout(() => {
      expired = true
      controller.abort()
    }, ms)
  }
  start()
  return {
    ms,
    signal: controller.signal,
    expired: () => expired,
    renew: () => {
      clearTimeout(timer)
      start()
    },
    clear: () => {
      clearTimeout(timer)
    }
  }
}

/** Sends one request; rejects only when it never reached the provider. */
async function send(
  settings: TessSettings,
  path: string,
  body: Record<string, unknown>,
  options: MessagesOptions,
  signal: AbortSignal
): Promise<Response> {
  return await (options.fetch ?? fetch)(
    `${settings.baseUrl.replace(/\/$/, '')}${path}`,
    {
      method: 'POST',
      signal,
      headers: {
        'content-type': 'application/json',
        'x-api-key': settings.apiKey,
        'anthropic-version': ANTHROPIC_VERSION,
        'anthropic-beta': THINKING_BINDING_BETA
      },
      body: JSON.stringify(body)
    }
  )
}

/** The provider gave no answer, or stopped answering: out of time, or out of reach. */
function lost(wait: Deadline, log: Record<string, Property>): HttpError {
  log.ec = wait.expired() ? 'timeout' : 'offline'
  return new HttpError(
    'unavailable',
    wait.expired()
      ? `Tess's model gave no answer within ${Math.round(wait.ms / 1000)}s`
      : "Tess's model could not be reached"
  )
}

/**
 * The provider refused the request with `status`, and `body` says why: its
 * error type, and whether it was the request's length or its bytes.
 */
function refused(
  status: number,
  body: Record<string, unknown> | null,
  log: Record<string, Property>
): HttpError {
  const type = errorType(body)
  log.ec = errorClassOf(status)
  return new HttpError(
    'unavailable',
    `Tess's model answered ${status} ${type}`,
    {
      status,
      type,
      ...(status === 400 && refusedForLength(body) ? { tooLong: true } : {}),
      ...(status === 413 ? { tooLarge: true } : {})
    }
  )
}

/**
 * One request, its answer parsed. Fills `log` with the status and, on a
 * failure, the error class the log takes.
 */
async function post(
  settings: TessSettings,
  path: string,
  body: Record<string, unknown>,
  options: MessagesOptions,
  log: Record<string, Property>
): Promise<Record<string, unknown>> {
  const wait = deadline(options.deadlineMs ?? DEADLINE_MS)
  try {
    let response: Response
    let text: string
    try {
      response = await send(settings, path, body, options, wait.signal)
      text = await response.text()
    } catch {
      throw lost(wait, log)
    }
    log.status = response.status
    const parsed = parse(text)
    if (!response.ok) throw refused(response.status, parsed, log)
    if (parsed == null) {
      log.ec = 'invalid'
      throw unreadable()
    }
    return parsed
  } finally {
    wait.clear()
  }
}

/**
 * The status an error sent in the stream stands for: the one the provider
 * answers that error with when it refuses a request outright.
 */
const STREAM_ERROR_STATUS: Readonly<Record<string, number>> = {
  invalid_request_error: 400,
  authentication_error: 401,
  billing_error: 402,
  permission_error: 403,
  not_found_error: 404,
  request_too_large: 413,
  rate_limit_error: 429,
  api_error: 500,
  timeout_error: 504,
  overloaded_error: 529
}

/** A block's text so far: none until a delta adds some. */
function textIn(value: unknown): string {
  return typeof value === 'string' ? value : ''
}

/** A message built from its stream, one event at a time. */
interface StreamedAnswer {
  /** One event, as it came. */
  take: (event: ServerSentEvent) => void
  /** `message_stop` has come. */
  finished: () => boolean
  /** The answer the events made, once `finished`. */
  response: () => MessagesResponse
}

function streamedAnswer(
  onEvent: (event: MessagesStreamEvent) => void,
  log: Record<string, Property>
): StreamedAnswer {
  const blocks: Array<Record<string, unknown>> = []
  // Each tool call's input, as the JSON text its deltas add up to.
  const inputs = new Map<number, string>()
  let usage: Record<string, unknown> = {}
  let stopReason: unknown
  let done = false
  const broken = (): HttpError => {
    log.ec = 'invalid'
    return unreadable()
  }
  const take = ({ data }: ServerSentEvent): void => {
    // A comment, or an event with nothing to read: the type is in the data.
    if (data == null || data === '') return
    const event = parse(data)
    if (event == null) throw broken()
    const index = typeof event.index === 'number' ? event.index : -1
    const block = blocks[index] as Record<string, unknown> | undefined
    const delta = (event.delta ?? {}) as Record<string, unknown>
    switch (event.type) {
      case 'message_start': {
        const message = (event.message ?? {}) as Record<string, unknown>
        usage = { ...(message.usage as Record<string, unknown> | undefined) }
        return
      }
      case 'content_block_start': {
        const start = event.content_block
        if (index < 0 || start == null || typeof start !== 'object')
          throw broken()
        blocks[index] = { ...(start as Record<string, unknown>) }
        if (blocks[index].type === 'tool_use') inputs.set(index, '')
        return
      }
      case 'content_block_delta':
        if (block == null) throw broken()
        if (delta.type === 'text_delta' && typeof delta.text === 'string') {
          block.text = `${textIn(block.text)}${delta.text}`
          onEvent({ type: 'text', delta: delta.text, index })
        } else if (
          delta.type === 'thinking_delta' &&
          typeof delta.thinking === 'string'
        ) {
          block.thinking = `${textIn(block.thinking)}${delta.thinking}`
          onEvent({ type: 'thinking', delta: delta.thinking, index })
        } else if (
          delta.type === 'signature_delta' &&
          typeof delta.signature === 'string'
        )
          block.signature = `${textIn(block.signature)}${delta.signature}`
        else if (
          delta.type === 'input_json_delta' &&
          typeof delta.partial_json === 'string'
        )
          inputs.set(index, `${inputs.get(index) ?? ''}${delta.partial_json}`)
        else if (delta.type === 'citations_delta')
          block.citations = [
            ...(Array.isArray(block.citations) ? block.citations : []),
            delta.citation
          ]
        return
      case 'content_block_stop': {
        if (block == null) throw broken()
        const json = inputs.get(index)
        if (json == null || json === '') return
        try {
          block.input = JSON.parse(json) as unknown
        } catch {
          throw broken()
        }
        return
      }
      case 'message_delta':
        stopReason = delta.stop_reason ?? stopReason
        usage = {
          ...usage,
          ...(event.usage as Record<string, unknown> | undefined)
        }
        return
      case 'message_stop':
        done = true
        return
      case 'error':
        log.status = STREAM_ERROR_STATUS[errorType(event)] ?? 500
        throw refused(log.status, event, log)
      default:
      // `ping`, and any event this client does not know yet.
    }
  }
  return {
    take,
    finished: () => done,
    response: () => {
      try {
        return responseOf({
          content: blocks.filter(block => block != null),
          stop_reason: stopReason,
          usage
        })
      } catch (error) {
        log.ec = 'invalid'
        throw error
      }
    }
  }
}

/** The provider's error type, when it is a plain identifier; never its message. */
function errorType(body: Record<string, unknown> | null): string {
  const error = body?.error
  const type =
    error != null && typeof error === 'object'
      ? (error as Record<string, unknown>).type
      : undefined
  return typeof type === 'string' && /^[a-z_]{1,64}$/.test(type)
    ? type
    : 'unknown_error'
}

/**
 * Whether the provider refused the request for its length: the prompt is
 * longer than the window, or leaves no room for the answer. Only this is
 * read from its message, which is never passed on.
 */
function refusedForLength(body: Record<string, unknown> | null): boolean {
  const error = body?.error
  const message =
    error != null && typeof error === 'object'
      ? (error as Record<string, unknown>).message
      : undefined
  return (
    typeof message === 'string' &&
    /prompt is too long|exceed(s|ed)? (the )?context (limit|window)/i.test(
      message
    )
  )
}

/** Whether `error` is the provider refusing a request for its length. */
export function isTooLong(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    (error.details as { tooLong?: unknown } | undefined)?.tooLong === true
  )
}

/**
 * Whether `error` is the provider refusing a request for its bytes: 413
 * `request_too_large`, a body over its 32 MB, which pictures reach long
 * before the window.
 */
export function isTooLarge(error: unknown): boolean {
  return (
    error instanceof HttpError &&
    (error.details as { tooLarge?: unknown } | undefined)?.tooLarge === true
  )
}

function errorClassOf(status: number): Property {
  if (status === 429) return 'rate_limited'
  if (status === 401 || status === 403) return 'permission'
  if (status >= 400 && status < 500) return 'invalid'
  return 'internal'
}

function parse(text: string): Record<string, unknown> | null {
  try {
    const value: unknown = JSON.parse(text)
    return value != null && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

function unreadable(): HttpError {
  return new HttpError('unavailable', "Tess's model sent an unreadable answer")
}

/** The answer's blocks, why it stopped, and what it used. */
function responseOf(body: Record<string, unknown>): MessagesResponse {
  const { content, stop_reason: stopReason, usage } = body
  if (
    !Array.isArray(content) ||
    !content.every(
      block =>
        block != null &&
        typeof block === 'object' &&
        typeof (block as { type?: unknown }).type === 'string'
    ) ||
    typeof stopReason !== 'string' ||
    usage == null ||
    typeof usage !== 'object'
  )
    throw unreadable()
  const count = (key: string): number => {
    const value = (usage as Record<string, unknown>)[key]
    return typeof value === 'number' && Number.isFinite(value) && value > 0
      ? value
      : 0
  }
  return {
    content: content as ContentBlock[],
    stopReason,
    usage: {
      inputTokens: count('input_tokens'),
      cacheCreationInputTokens: count('cache_creation_input_tokens'),
      cacheReadInputTokens: count('cache_read_input_tokens'),
      outputTokens: count('output_tokens')
    }
  }
}

/** A token count as the log takes it. */
function tokens(count: number): number {
  return Math.min(10000000, Math.round(count))
}
