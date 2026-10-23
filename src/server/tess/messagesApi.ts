import { HttpError } from '../../common/errors'
import type { Property } from '../../common/observability/contract'
import { emitLog } from '../observability/logging'
import type { TessSettings } from '../serverConfig'

/**
 * Anthropic's Messages API, for Tess: one request per call, over plain
 * `fetch` as dictation's interpreter does, with a deadline. A provider's
 * failure becomes an `HttpError` naming its status and error type, never its
 * body, which can quote the request back. A request refused for its length
 * says so in the error's details (`tooLong`), and one refused for its bytes
 * (`tooLarge`), so the conversation can be made shorter and sent again.
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
export type ContentBlock =
  TextBlock | ImageBlock | ToolUseBlock | ToolResultBlock

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
  const start = performance.now()
  const logged: Record<string, Property> = {}
  try {
    const body = await post(
      settings,
      '/messages',
      { ...bodyOf(settings, request), max_tokens: MAX_TOKENS },
      options,
      logged
    )
    const response = responseOf(body)
    const { usage } = response
    logged.it = tokens(
      usage.inputTokens +
        usage.cacheCreationInputTokens +
        usage.cacheReadInputTokens
    )
    logged.ot = tokens(usage.outputTokens)
    return response
  } catch (error) {
    // Only an answer that is not a message gets here unclassified.
    logged.ec ??= 'invalid'
    throw error
  } finally {
    emitLog(
      'tess_request',
      {
        op: 'assistant',
        ms: Math.min(86400000, Math.max(0, performance.now() - start)),
        ...logged
      },
      logged.ec == null ? 'info' : 'error',
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

/**
 * One request, its answer parsed. Fills `logged` with the status and, on a
 * failure, the error class the log takes.
 */
async function post(
  settings: TessSettings,
  path: string,
  body: Record<string, unknown>,
  options: MessagesOptions,
  logged: Record<string, Property>
): Promise<Record<string, unknown>> {
  const deadlineMs = options.deadlineMs ?? DEADLINE_MS
  const controller = new AbortController()
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, deadlineMs)
  try {
    let response: Response
    let text: string
    try {
      response = await (options.fetch ?? fetch)(
        `${settings.baseUrl.replace(/\/$/, '')}${path}`,
        {
          method: 'POST',
          signal: controller.signal,
          headers: {
            'content-type': 'application/json',
            'x-api-key': settings.apiKey,
            'anthropic-version': ANTHROPIC_VERSION,
            'anthropic-beta': THINKING_BINDING_BETA
          },
          body: JSON.stringify(body)
        }
      )
      text = await response.text()
    } catch {
      logged.ec = timedOut ? 'timeout' : 'offline'
      throw new HttpError(
        'unavailable',
        timedOut
          ? `Tess's model gave no answer within ${Math.round(deadlineMs / 1000)}s`
          : "Tess's model could not be reached"
      )
    }
    logged.status = response.status
    const parsed = parse(text)
    if (!response.ok) {
      const type = errorType(parsed)
      logged.ec = errorClassOf(response.status)
      throw new HttpError(
        'unavailable',
        `Tess's model answered ${response.status} ${type}`,
        {
          status: response.status,
          type,
          ...(response.status === 400 && refusedForLength(parsed)
            ? { tooLong: true }
            : {}),
          ...(response.status === 413 ? { tooLarge: true } : {})
        }
      )
    }
    if (parsed == null) {
      logged.ec = 'invalid'
      throw unreadable()
    }
    return parsed
  } finally {
    clearTimeout(timer)
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
