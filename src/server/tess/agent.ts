import type { TessChange, TessScreen } from '../../common/api'
import { badRequest, HttpError, tooLarge } from '../../common/errors'
import { ownedAttachments, pruneAttachments } from './attachments'
import {
  expirePendingChanges,
  restoreExpiredChanges,
  runChange
} from './changes'
import {
  compact,
  COMPACT_ABOVE,
  describeAttachments,
  estimateTokens,
  fitPictures,
  INPUT_CEILING
} from './compaction'
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
  isTooLarge,
  isTooLong,
  MAX_TOKENS,
  type MessageParam,
  type MessagesRequest,
  type MessagesResponse,
  type MessagesStreamEvent,
  type SystemBlock,
  type ToolResultBlock,
  type ToolUseBlock
} from './messagesApi'
import { systemBlocks } from './prompt'
import { stepLabel } from './stepLabels'
import { runTool, TOOLS } from './tools'
import { withTurn } from './turns'
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

/**
 * What a turn tells as it happens, for the app to show: each piece of the
 * summary of Tess's thinking and of her text, a separate block's starting
 * on a new paragraph; each tool call as a step, labelled (`stepLabels.ts`),
 * when it starts and when it ends; once the person's message (or the note
 * of the change they confirmed) is stored, the id it was stored with, and
 * the change as it ended; before the message is stored, `preparing`
 * when the conversation is to be made fit for it first (pictures described,
 * or the conversation compacted), model calls that may take a while; and,
 * when the turn fails before anything of her answer is stored, `takenBack`
 * once the stored message is deleted again, just before the turn throws.
 */
export type TurnEvent =
  | { type: 'thinking'; delta: string }
  | { type: 'text'; delta: string }
  | {
      type: 'step'
      /** The tool call's id. */
      id: string
      label: string
      status: 'running' | 'done' | 'failed'
    }
  | { type: 'stored'; fromId: number; change?: TessChange }
  | { type: 'preparing' }
  | { type: 'takenBack' }

/**
 * Told each `TurnEvent`; the turn waits for what it answers to `stored`,
 * `preparing`, `step` and `takenBack`.
 */
export type TurnEvents = (event: TurnEvent) => void | Promise<void>

export interface TurnInput {
  text: string
  attachmentIds?: readonly string[]
  /** The page beside the chat, from a wide screen. */
  screen?: TessScreen
  /** The app's id for the message, shown on it. */
  clientId?: string
}

/**
 * The person says something. While another of their turns is running it is
 * refused with 409. Their uploads no message names that are a day old are
 * cleared, but for this message's. The conversation is compacted first when
 * it needs to be; their pending changes expire, since they have moved on; then
 * Tess answers. A message with attachments that would take the conversation
 * over the ceiling is refused with 413 and not kept. Its attachments are, so
 * the app can send it again, as it gives the draft back, without the one
 * that is too large. When Tess fails before she has stored anything of her
 * answer (the model is down or out of time), the message is taken back and
 * the changes it expired are pending again, as the app shows them: the app
 * gives the draft back to send again, and a resend is then the only copy.
 * Answers the id of the stored message.
 */
export async function runTurn(
  deps: TessDeps,
  user: TessUser,
  input: TurnInput,
  onEvent?: TurnEvents
): Promise<number> {
  const text = input.text.trim()
  const attachments = await ownedAttachments(
    deps.db,
    user.userId,
    input.attachmentIds ?? []
  )
  if (text === '' && attachments.length === 0)
    throw badRequest('Say something to Tess')
  return await withTurn(
    deps.db,
    user.userId,
    async () => await turn(deps, user, input, text, attachments, onEvent)
  )
}

async function turn(
  deps: TessDeps,
  user: TessUser,
  input: TurnInput,
  text: string,
  attachments: ReadonlyArray<{ id: string }>,
  onEvent?: TurnEvents
): Promise<number> {
  await pruneAttachments(
    deps.db,
    user.userId,
    attachments.map(row => row.id)
  )
  const content: StoredBlock[] = [
    ...(text === '' ? [] : [{ type: 'text' as const, text }]),
    ...attachments.map(row => ({ type: 'attachment' as const, id: row.id })),
    {
      type: 'moment',
      sentAt: (deps.now?.() ?? new Date()).toISOString(),
      ...(input.screen == null ? {} : { screen: input.screen }),
      ...(input.clientId == null ? {} : { clientId: input.clientId })
    }
  ]
  const system = await systemFor(deps, user)
  await guard(deps, user.userId, system, content, onEvent)
  const expired = await expirePendingChanges(deps.db, user.userId)
  const [id] = await appendMessages(deps.db, user.userId, [
    { role: 'user', content }
  ])
  try {
    await onEvent?.({ type: 'stored', fromId: id })
    await respond(deps, user, system, onEvent)
  } catch (error) {
    if (await takeBack(deps, user.userId, id)) {
      await restoreExpiredChanges(deps.db, user.userId, expired)
      await onEvent?.({ type: 'takenBack' })
    }
    throw error
  }
  return id
}

/**
 * Deletes the person's message `id` when nothing has been stored after it,
 * and answers whether it did. Once a tool round is stored the message stays
 * with it, since the round answers it.
 */
async function takeBack(
  deps: TessDeps,
  userId: string,
  id: number
): Promise<boolean> {
  const later = await deps.db
    .selectFrom('tess_messages')
    .select('id')
    .where('user_id', '=', userId)
    .where('id', '>', id)
    .limit(1)
    .executeTakeFirst()
  if (later != null) return false
  await deps.db
    .deleteFrom('tess_messages')
    .where('user_id', '=', userId)
    .where('id', '=', id)
    .execute()
  return true
}

/**
 * The person held Confirm on a change. While another of their turns is
 * running it is refused with 409, and does not run. It runs once, then Tess
 * is told what the server answered and reports it. Her report failing does not undo the
 * change, which has run: the answer is still the change. Answers the change
 * and the id the report's messages start from.
 */
export async function confirmTurn(
  deps: TessDeps,
  user: TessUser,
  changeId: string,
  onEvent?: TurnEvents
): Promise<{ change: TessChange; fromId: number }> {
  return await withTurn(deps.db, user.userId, async () => {
    const { change, note } = await runChange(
      deps,
      user.userId,
      user.credentials,
      changeId
    )
    const [fromId] = await appendMessages(deps.db, user.userId, [
      {
        role: 'user',
        content: [{ type: 'confirmation', changeId, text: note }]
      }
    ])
    try {
      await onEvent?.({ type: 'stored', fromId, change })
      await respond(deps, user, await systemFor(deps, user), onEvent)
    } catch (error) {
      if (!(error instanceof HttpError)) throw error
    }
    return { change, fromId }
  })
}

async function systemFor(
  deps: TessDeps,
  user: TessUser
): Promise<SystemBlock[]> {
  return systemBlocks({
    user: await userContext(deps.db, user.userId, user.isAdmin)
  })
}

/**
 * The request for the stored conversation, with `extra` as a last message,
 * or with `alone`, for that message and nothing before it. The conversation
 * is cached up to its last block, since every tool round and the next turn
 * send it again.
 */
async function buildRequest(
  deps: TessDeps,
  userId: string,
  system: SystemBlock[],
  extra?: StoredBlock[],
  alone = false
): Promise<MessagesRequest> {
  const conversation = alone
    ? { summary: null, messages: [] }
    : await loadConversation(deps.db, userId)
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
    tools: TOOLS,
    cacheMessages: true
  }
}

/**
 * Before a message is stored. The pictures the request will carry are kept
 * to what one message may hold, older ones giving way to their
 * descriptions, so its bytes stay under the provider's limit. Then one with
 * attachments is measured with
 * `count_tokens`; one without is taken at the size the last request and its
 * answer had, with the message's own at its most, and measured when that
 * comes to more than 150,000. Above 150,000 the conversation is compacted
 * first, down to nothing but the message when it must be; still too large
 * with the message, it is refused. Compaction cannot make the message
 * itself smaller, so it is measured alone first: one that would not fit
 * beside the summary compaction leaves, an answer long at most, is refused
 * at once, and the conversation is left as it was. `onEvent` is told
 * `preparing`, once, before pictures are described or the conversation
 * compacted.
 */
async function guard(
  deps: TessDeps,
  userId: string,
  system: SystemBlock[],
  content: StoredBlock[],
  onEvent?: TurnEvents
): Promise<void> {
  let told = false
  const preparing = async (): Promise<void> => {
    if (told) return
    told = true
    await onEvent?.({ type: 'preparing' })
  }
  await fitPictures(deps, userId, content, preparing)
  const measure = async (): Promise<number> =>
    await countTokens(
      deps.settings,
      await buildRequest(deps, userId, system, content),
      { fetch: deps.fetch }
    )
  const ids = attachmentIdsOf([{ content }])
  let tokens =
    ids.length > 0
      ? await measure()
      : (await contextTokensOf(deps.db, userId)) +
        estimateTokens(JSON.stringify(content))
  if (ids.length === 0 && tokens > COMPACT_ABOVE) tokens = await measure()
  const refused = (): HttpError =>
    tooLarge(
      ids.length > 0
        ? 'That attachment is too large for the conversation'
        : 'The conversation is too long to go on'
    )
  if (tokens > COMPACT_ABOVE) {
    const alone = await countTokens(
      deps.settings,
      await buildRequest(deps, userId, system, content, true),
      { fetch: deps.fetch }
    )
    if (alone + (tokens > alone ? MAX_TOKENS : 0) > INPUT_CEILING)
      throw refused()
    await preparing()
    tokens = await compact(deps, userId, measure, { keepNone: true })
  }
  if (tokens <= INPUT_CEILING) return
  throw refused()
}

/**
 * Tess answers the stored conversation: call, run the tools asked for, call
 * again, until she answers in text. At the tenth response that still asks for
 * tools the round is closed: each call is answered with an error and one last
 * call, which may use no tool, gives her answer. A call the provider refuses
 * for its length is sent again, once, after the conversation is compacted;
 * one it refuses for its bytes, once, after its attachments are described.
 * The size of the last request and its answer is saved, and above 150,000
 * the conversation is compacted; a compaction that fails then leaves the
 * answer as it is, to be tried again before the next message. When she
 * fails after storing a round, the size it had is saved, so the next
 * message is measured against it. Each call is streamed, and what it tells
 * goes to `onEvent` with each step.
 */
async function respond(
  deps: TessDeps,
  user: TessUser,
  system: SystemBlock[],
  onEvent?: TurnEvents
): Promise<void> {
  const { db, settings } = deps
  const { userId } = user
  const relay = relayOf(onEvent)
  const step = async (
    id: string,
    label: string,
    status: 'running' | 'done' | 'failed'
  ): Promise<void> => {
    await onEvent?.({ type: 'step', id, label, status })
  }
  const measure = async (): Promise<number> =>
    await countTokens(settings, await buildRequest(deps, userId, system), {
      fetch: deps.fetch
    })
  let request = await buildRequest(deps, userId, system)
  // What the stored conversation comes to, once a round of it is stored.
  let known = 0
  let compacted = false
  const call = async (
    toolChoice?: MessagesRequest['toolChoice']
  ): Promise<MessagesResponse> => {
    try {
      return await callModel(deps, userId, { ...request, toolChoice }, relay())
    } catch (error) {
      if (compacted || !(isTooLong(error) || isTooLarge(error))) throw error
      compacted = true
      if (isTooLong(error)) known = await compact(deps, userId, measure)
      else await describeAttachments(deps, userId)
      request = await buildRequest(deps, userId, system)
      return await callModel(deps, userId, { ...request, toolChoice }, relay())
    }
  }
  let last: MessagesResponse
  try {
    for (let round = 1; ; round += 1) {
      const response = await call()
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
        for (const call of calls) await step(call.id, stepLabel(call), 'failed')
        await appendMessages(db, userId, [
          { role: 'assistant', content: response.content },
          { role: 'user', content: results }
        ])
        known = sizeAfter(response, results)
        request = withExchange(request, response.content, results)
        const closing = await call('none')
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
      for (const call of calls) {
        const label = stepLabel(call)
        await step(call.id, label, 'running')
        const outcome = await runTool(context, call)
        outcomes.push(outcome)
        await step(
          call.id,
          label,
          outcome.result.is_error === true ? 'failed' : 'done'
        )
      }
      const results = await fitted(
        deps,
        request,
        response,
        outcomes.map(outcome => outcome.result)
      )
      // A result too large to keep failed after all.
      for (const [at, result] of results.entries())
        if (result.content === TOO_LARGE_NOW)
          await step(calls[at].id, stepLabel(calls[at]), 'failed')
      const changes: StoredBlock[] = outcomes.flatMap(outcome =>
        outcome.changeId == null
          ? []
          : [{ type: 'change' as const, id: outcome.changeId }]
      )
      await appendMessages(db, userId, [
        { role: 'assistant', content: [...response.content, ...changes] },
        { role: 'user', content: results }
      ])
      known = sizeAfter(response, results)
      request = withExchange(request, response.content, results)
    }
  } catch (error) {
    // Still too long once compacted: the next message compacts again first.
    const size = isTooLong(error) ? Math.max(known, COMPACT_ABOVE + 1) : known
    if (size > 0) await saveContextTokens(db, userId, size)
    throw error
  }
  const tokens = inputOf(last) + last.usage.outputTokens
  await saveContextTokens(db, userId, tokens)
  if (tokens <= COMPACT_ABOVE) return
  try {
    await compact(deps, userId, measure)
  } catch (error) {
    // The answer is stored, and the saved size has the next message
    // compact first.
    if (!(error instanceof HttpError)) throw error
  }
}

/**
 * A relay of each call's stream to `onEvent`, made anew for each call: a
 * thinking or text block after the first of its kind in the turn starts on
 * a new paragraph, as the app joins them once they are stored. A stream's
 * events are told as they come, without waiting.
 */
function relayOf(
  onEvent: TurnEvents | undefined
): () => (event: MessagesStreamEvent) => void {
  const told = { thinking: false, text: false }
  return () => {
    const block = { thinking: -1, text: -1 }
    return event => {
      if (onEvent == null) return
      let delta = event.delta
      if (block[event.type] !== event.index) {
        block[event.type] = event.index
        if (told[event.type]) delta = `\n\n${delta}`
      }
      told[event.type] = true
      const answered = onEvent({ type: event.type, delta })
      if (answered != null) answered.catch(() => undefined)
    }
  }
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

/**
 * The request with one more exchange: Tess's tool calls and their results.
 * A text block of nothing but white space is left out, as the stored
 * conversation leaves it out, since the Messages API refuses one.
 */
function withExchange(
  request: MessagesRequest,
  calls: ContentBlock[],
  results: ToolResultBlock[]
): MessagesRequest {
  const messages: MessageParam[] = [
    ...request.messages,
    {
      role: 'assistant',
      content: calls.filter(
        block => !(block.type === 'text' && block.text.trim() === '')
      )
    },
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

/** The size of the next request after a round, at most. */
function sizeAfter(
  response: MessagesResponse,
  results: ToolResultBlock[]
): number {
  return (
    inputOf(response) +
    response.usage.outputTokens +
    results.reduce((sum, result) => sum + estimateTokens(contentOf(result)), 0)
  )
}

function contentOf(result: ToolResultBlock): string {
  return typeof result.content === 'string'
    ? result.content
    : JSON.stringify(result.content)
}

/**
 * Tool results that keep the next request, `request` with this round, under
 * the ceiling: a result that would not fit at its estimate is replaced by a
 * note asking for less. When the round takes the request above 150,000 it is
 * counted, and the largest results give way until it fits.
 */
async function fitted(
  deps: TessDeps,
  request: MessagesRequest,
  response: MessagesResponse,
  results: ToolResultBlock[]
): Promise<ToolResultBlock[]> {
  const tooLarge = (result: ToolResultBlock): ToolResultBlock => ({
    ...result,
    content: TOO_LARGE_NOW,
    is_error: true
  })
  let room = INPUT_CEILING - inputOf(response) - response.usage.outputTokens
  const kept = results.map(result => {
    const tokens = estimateTokens(contentOf(result))
    if (tokens <= room) {
      room -= tokens
      return result
    }
    return tooLarge(result)
  })
  if (INPUT_CEILING - room <= COMPACT_ABOVE) return kept
  for (;;) {
    const tokens = await countTokens(
      deps.settings,
      withExchange(request, response.content, kept),
      { fetch: deps.fetch }
    )
    if (tokens <= INPUT_CEILING) return kept
    let largest = -1
    kept.forEach((result, at) => {
      if (
        result.content !== TOO_LARGE_NOW &&
        (largest < 0 ||
          contentOf(result).length > contentOf(kept[largest]).length)
      )
        largest = at
    })
    if (largest < 0) return kept
    kept[largest] = tooLarge(kept[largest])
  }
}
