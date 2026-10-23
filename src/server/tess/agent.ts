import type { TessChange, TessScreen } from '../../common/api'
import { badRequest, HttpError, tooLarge } from '../../common/errors'
import { ownedAttachments } from './attachments'
import { expirePendingChanges, runChange } from './changes'
import { CEILING, compact, COMPACT_ABOVE, dropUnsent } from './compaction'
import {
  appendMessages,
  attachmentIdsOf,
  attachmentsById,
  callModel,
  contextTokensOf,
  loadConversation,
  type ModelDeps,
  requestMessages,
  saveContextTokens,
  type StoredBlock
} from './conversation'
import type { Credentials } from './loopback'
import {
  type ContentBlock,
  countTokens,
  type MessageParam,
  type MessagesRequest,
  type MessagesResponse,
  type SystemBlock,
  type ToolResultBlock,
  type ToolUseBlock
} from './messagesApi'
import { systemBlocks } from './prompt'
import { runTool, TOOLS } from './tools'
import { userContext } from './userContext'

/**
 * One turn of a conversation with Tess: the person's message stored, the
 * model called, each tool it asks for run and its result sent back, until it
 * answers in text. Every request and response is stored as it goes, a tool
 * call always with its result, so the stored conversation is always one the
 * model accepts next time.
 */

/** How many responses of one turn may ask for tools. */
export const MAX_TOOL_ROUNDS = 10

export const TOOL_LIMIT = 'Tool limit reached; answer with what you have'
export const TOO_LARGE_NOW =
  'That answer is too large for the conversation now. Ask for less, or answer with what you have.'

export interface TessDeps extends ModelDeps {
  /** This server's own origin, read when a tool runs: see `loopback.ts`. */
  origin: () => string
}

/** Who Tess is answering, and the credentials her tools act with. */
export interface TessUser {
  userId: string
  isAdmin: boolean
  credentials: Credentials
}

export interface TurnInput {
  text: string
  attachmentIds?: readonly string[]
  /** The page beside the chat, from a wide screen. */
  screen?: TessScreen
}

/**
 * The person says something. The conversation is compacted first when it
 * needs to be; their pending changes expire, since they have moved on; then
 * Tess answers. A message with attachments that would take the conversation
 * over the ceiling is refused with 413, and neither it nor its attachments
 * are kept. Answers the id of the stored message.
 */
export async function runTurn(
  deps: TessDeps,
  user: TessUser,
  input: TurnInput
): Promise<number> {
  const text = input.text.trim()
  const attachments = await ownedAttachments(
    deps.db,
    user.userId,
    input.attachmentIds ?? []
  )
  if (text === '' && attachments.length === 0)
    throw badRequest('Say something to Tess')
  const content: StoredBlock[] = [
    ...(text === '' ? [] : [{ type: 'text' as const, text }]),
    ...attachments.map(row => ({ type: 'attachment' as const, id: row.id }))
  ]
  const system = await systemFor(deps, user, input.screen)
  await guard(deps, user.userId, system, content)
  await expirePendingChanges(deps.db, user.userId)
  const [id] = await appendMessages(deps.db, user.userId, [
    { role: 'user', content }
  ])
  await respond(deps, user, system)
  return id
}

/**
 * The person held Confirm on a change. It runs once, then Tess is told what
 * the server answered and reports it. Her report failing does not undo the
 * change, which has run: the answer is still the change. Answers the change
 * and the id the report's messages start from.
 */
export async function confirmTurn(
  deps: TessDeps,
  user: TessUser,
  changeId: string
): Promise<{ change: TessChange; fromId: number }> {
  const { change, note } = await runChange(
    deps,
    user.userId,
    user.credentials,
    changeId
  )
  const [fromId] = await appendMessages(deps.db, user.userId, [
    { role: 'user', content: [{ type: 'confirmation', changeId, text: note }] }
  ])
  try {
    await respond(deps, user, await systemFor(deps, user))
  } catch (error) {
    if (!(error instanceof HttpError)) throw error
  }
  return { change, fromId }
}

async function systemFor(
  deps: TessDeps,
  user: TessUser,
  screen?: TessScreen
): Promise<SystemBlock[]> {
  return systemBlocks({
    user: await userContext(deps.db, user.userId, user.isAdmin),
    now: deps.now?.() ?? new Date(),
    screen
  })
}

/** The request for the stored conversation, with `extra` as a last message. */
async function buildRequest(
  deps: TessDeps,
  userId: string,
  system: SystemBlock[],
  extra?: StoredBlock[]
): Promise<MessagesRequest> {
  const conversation = await loadConversation(deps.db, userId)
  const messages =
    extra == null
      ? conversation.messages
      : [...conversation.messages, { role: 'user' as const, content: extra }]
  return {
    system,
    messages: requestMessages(
      conversation.summary,
      messages,
      await attachmentsById(deps.db, userId, attachmentIdsOf(messages))
    ),
    tools: TOOLS
  }
}

/**
 * Before a message is stored. One with attachments is measured with
 * `count_tokens`; one without is taken at the size the last request had.
 * Above 150,000 the conversation is compacted first; still above 200,000
 * with the message, it is refused.
 */
async function guard(
  deps: TessDeps,
  userId: string,
  system: SystemBlock[],
  content: StoredBlock[]
): Promise<void> {
  const measure = async (): Promise<number> =>
    await countTokens(
      deps.settings,
      await buildRequest(deps, userId, system, content),
      { fetch: deps.fetch }
    )
  const ids = attachmentIdsOf([{ content }])
  let tokens =
    ids.length > 0 ? await measure() : await contextTokensOf(deps.db, userId)
  if (tokens > COMPACT_ABOVE) tokens = await compact(deps, userId, measure)
  if (tokens <= CEILING) return
  await dropUnsent(deps.db, userId, ids)
  throw tooLarge(
    ids.length > 0
      ? 'That attachment is too large for the conversation'
      : 'The conversation is too long to go on'
  )
}

/**
 * Tess answers the stored conversation: call, run the tools asked for, call
 * again, until she answers in text. At the tenth response that still asks for
 * tools the round is closed: each call is answered with an error and one last
 * call, which may use no tool, gives her answer. The size of the last request
 * is saved, and above 150,000 the conversation is compacted.
 */
async function respond(
  deps: TessDeps,
  user: TessUser,
  system: SystemBlock[]
): Promise<void> {
  const { db, settings } = deps
  const { userId } = user
  let request = await buildRequest(deps, userId, system)
  let last: MessagesResponse
  for (let round = 1; ; round += 1) {
    const response = await callModel(deps, userId, request)
    last = response
    const calls = response.content.filter(
      (block): block is ToolUseBlock => block.type === 'tool_use'
    )
    if (response.stopReason !== 'tool_use' || calls.length === 0) {
      await storeAnswer(deps, userId, response)
      break
    }
    if (round >= MAX_TOOL_ROUNDS) {
      const results: ToolResultBlock[] = calls.map(call => ({
        type: 'tool_result',
        tool_use_id: call.id,
        content: TOOL_LIMIT,
        is_error: true
      }))
      await appendMessages(db, userId, [
        { role: 'assistant', content: response.content },
        { role: 'user', content: results }
      ])
      request = withExchange(request, response.content, results)
      const closing = await callModel(deps, userId, {
        ...request,
        toolChoice: 'none'
      })
      last = closing
      await storeAnswer(deps, userId, closing)
      break
    }
    const context = {
      db,
      userId,
      credentials: user.credentials,
      origin: deps.origin(),
      now: deps.now?.() ?? new Date()
    }
    const outcomes = []
    for (const call of calls) outcomes.push(await runTool(context, call))
    const results = fitted(
      response,
      outcomes.map(outcome => outcome.result)
    )
    const changes: StoredBlock[] = outcomes.flatMap(outcome =>
      outcome.changeId == null
        ? []
        : [{ type: 'change' as const, id: outcome.changeId }]
    )
    await appendMessages(db, userId, [
      { role: 'assistant', content: [...response.content, ...changes] },
      { role: 'user', content: results }
    ])
    request = withExchange(request, response.content, results)
  }
  const tokens = inputOf(last)
  await saveContextTokens(db, userId, tokens)
  if (tokens > COMPACT_ABOVE)
    await compact(
      deps,
      userId,
      async () =>
        await countTokens(settings, await buildRequest(deps, userId, system), {
          fetch: deps.fetch
        })
    )
}

/**
 * Stores a final answer. A tool call in an answer that did not stop for
 * tools (one cut off by the token limit) is left out, since nothing answers
 * it; an answer with nothing left is not stored.
 */
async function storeAnswer(
  deps: TessDeps,
  userId: string,
  response: MessagesResponse
): Promise<void> {
  const content = response.content.filter(
    block =>
      block.type !== 'tool_use' &&
      !(block.type === 'text' && block.text.trim() === '')
  )
  if (content.length === 0) return
  await appendMessages(deps.db, userId, [{ role: 'assistant', content }])
}

/** The request with one more exchange: Tess's tool calls and their results. */
function withExchange(
  request: MessagesRequest,
  calls: ContentBlock[],
  results: ToolResultBlock[]
): MessagesRequest {
  const messages: MessageParam[] = [
    ...request.messages,
    { role: 'assistant', content: calls },
    { role: 'user', content: results }
  ]
  return { ...request, messages }
}

/** Everything a call read: fresh input, and what it wrote to and read from the cache. */
function inputOf(response: MessagesResponse): number {
  const { usage } = response
  return (
    usage.inputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens
  )
}

/**
 * Tool results that keep the next request under the ceiling, roughly: a
 * result that would not fit, at three characters a token, is replaced by a
 * note asking for less.
 */
function fitted(
  response: MessagesResponse,
  results: ToolResultBlock[]
): ToolResultBlock[] {
  let room =
    (CEILING - 10000 - inputOf(response) - response.usage.outputTokens) * 3
  return results.map(result => {
    const size =
      typeof result.content === 'string'
        ? result.content.length
        : JSON.stringify(result.content).length
    if (size <= room) {
      room -= size
      return result
    }
    return { ...result, content: TOO_LARGE_NOW, is_error: true }
  })
}
