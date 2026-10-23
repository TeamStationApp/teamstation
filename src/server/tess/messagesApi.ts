import { HttpError } from '../../common/errors'
import type { Property } from '../../common/observability/contract'
import { emitLog } from '../observability/logging'
import type { TessSettings } from '../serverConfig'

/**
 * Anthropic's Messages API, for Tess: one request per call, over plain
 * `fetch` as dictation's interpreter does, with a deadline. A provider's
 * failure becomes an `HttpError` naming its status and error type, never its
 * body, which can quote the request back.
 */

export const ANTHROPIC_VERSION = '2023-06-01'
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
    system: request.system.map(block =>
      block.cached === true
        ? {
            type: 'text',
            text: block.text,
            cache_control: { type: 'ephemeral' }
          }
        : { type: 'text', text: block.text }
    ),
    messages: request.messages,
    ...(tools.length === 0
      ? {}
      : { tools, tool_choice: { type: request.toolChoice ?? 'auto' } })
  }
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
            'anthropic-version': ANTHROPIC_VERSION
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
        { status: response.status, type }
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
