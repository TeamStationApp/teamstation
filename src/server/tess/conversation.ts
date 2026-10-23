import { type Kysely, sql } from 'kysely'

import type { TessChange, TessMessage } from '../../common/api'
import type { Database } from '../db/database'
import type { TessSettings } from '../serverConfig'
import {
  attachmentBlock,
  type AttachmentInfo,
  type AttachmentRow
} from './attachments'
import { holdLiveUser, whileLive } from './liveUser'
import {
  type ContentBlock,
  createMessage,
  type MessageParam,
  type MessagesRequest,
  type MessagesResponse,
  type TextBlock
} from './messagesApi'
import { type Moment, momentText } from './prompt'
import { recordUsage } from './usage'

/**
 * One person's conversation with Tess as it is stored, and what it becomes:
 * the Messages API request it is sent as, and the messages the app shows.
 *
 * Messages are stored as Anthropic content blocks, as sent and received,
 * with four blocks of Tess's own that never reach the model as they are:
 * an attachment by id, expanded to its content when a request is built; a
 * change Tess proposed, by id, on the assistant message that proposed it,
 * which the app draws as a card and the model never sees; the note a
 * confirmed change leaves, sent as text and not shown; and the moment a
 * message of the person's was sent, with the page beside the chat, sent as
 * text at its end and not shown. Stored with the message, the moment reads
 * the same in every later request, so the conversation stays cached.
 */

export interface AttachmentRef {
  type: 'attachment'
  id: string
}
export interface ChangeRef {
  type: 'change'
  id: string
}
export interface ConfirmationNote {
  type: 'confirmation'
  changeId: string
  text: string
}
export interface MomentNote extends Moment {
  type: 'moment'
  /** The id the app sent the message with, which the model never sees. */
  clientId?: string
}
export type StoredBlock =
  ContentBlock | AttachmentRef | ChangeRef | ConfirmationNote | MomentNote

export interface StoredMessage {
  id: number
  role: 'user' | 'assistant'
  content: StoredBlock[]
  createdAt: Date
}

export interface Conversation {
  summary: string | null
  contextTokens: number
  messages: StoredMessage[]
}

/** What every call to the model needs, besides the request. */
export interface ModelDeps {
  db: Kysely<Database>
  settings: TessSettings
  /** The Messages API's `fetch`, replaced in tests. */
  fetch?: typeof fetch
  now?: () => Date
}

/**
 * One Messages call for one person, its tokens added to their week. Every
 * call goes through here: the conversation's, compaction's summaries and
 * attachment descriptions.
 */
export async function callModel(
  deps: ModelDeps,
  userId: string,
  request: MessagesRequest
): Promise<MessagesResponse> {
  const response = await createMessage(deps.settings, request, {
    fetch: deps.fetch,
    actor: userId
  })
  await recordUsage(deps.db, userId, response.usage, deps.now?.() ?? new Date())
  return response
}

/** The person's conversation, oldest message first, or an empty one. */
export async function loadConversation(
  db: Kysely<Database>,
  userId: string,
  fromId = 0
): Promise<Conversation> {
  const head = await db
    .selectFrom('tess_conversations')
    .select(['summary', 'context_tokens'])
    .where('user_id', '=', userId)
    .executeTakeFirst()
  const rows = await db
    .selectFrom('tess_messages')
    .select(['id', 'role', 'content', 'created_at'])
    .where('user_id', '=', userId)
    .where('id', '>=', fromId)
    .orderBy('id')
    .execute()
  return {
    summary: head?.summary ?? null,
    contextTokens: head?.context_tokens ?? 0,
    messages: rows.map(row => ({
      id: Number(row.id),
      role: row.role,
      content: row.content as StoredBlock[],
      createdAt: row.created_at
    }))
  }
}

/**
 * Adds messages to the end of the conversation in one transaction, so a
 * tool call is never stored without its result. Answers their ids. Once the
 * person's account is deleted nothing is added: 410.
 */
export async function appendMessages(
  db: Kysely<Database>,
  userId: string,
  messages: ReadonlyArray<{
    role: 'user' | 'assistant'
    content: StoredBlock[]
  }>
): Promise<number[]> {
  return await db.transaction().execute(async trx => {
    await holdLiveUser(trx, userId)
    await trx
      .insertInto('tess_conversations')
      .values({ user_id: userId })
      .onConflict(conflict =>
        conflict.column('user_id').doUpdateSet({ updated_at: new Date() })
      )
      .execute()
    const ids: number[] = []
    for (const message of messages) {
      const row = await trx
        .insertInto('tess_messages')
        .values({
          user_id: userId,
          role: message.role,
          content: JSON.stringify(message.content)
        })
        .returning('id')
        .executeTakeFirstOrThrow()
      ids.push(Number(row.id))
    }
    return ids
  })
}

/** The size of the conversation's last request, in tokens. */
export async function contextTokensOf(
  db: Kysely<Database>,
  userId: string
): Promise<number> {
  const head = await db
    .selectFrom('tess_conversations')
    .select('context_tokens')
    .where('user_id', '=', userId)
    .executeTakeFirst()
  return head?.context_tokens ?? 0
}

/**
 * Saves the size of the conversation's last request, in tokens; once the
 * person's account is deleted, 410.
 */
export async function saveContextTokens(
  db: Kysely<Database>,
  userId: string,
  tokens: number
): Promise<void> {
  const value = Math.max(0, Math.min(2147483647, Math.round(tokens)))
  await whileLive(db, userId, async trx => {
    await trx
      .insertInto('tess_conversations')
      .values({ user_id: userId, context_tokens: value })
      .onConflict(conflict =>
        conflict
          .column('user_id')
          .doUpdateSet({ context_tokens: value, updated_at: new Date() })
      )
      .execute()
  })
}

/**
 * Whether a message starts a turn: one from the person (or the note of a
 * change they confirmed), never a tool's result. Compaction cuts only here,
 * so no tool call is parted from its result.
 */
export function isTurnStart(message: {
  role: string
  content: StoredBlock[]
}): boolean {
  return (
    message.role === 'user' &&
    !message.content.some(block => block.type === 'tool_result')
  )
}

/** The attachment ids a set of messages names. */
export function attachmentIdsOf(
  messages: ReadonlyArray<{ content: StoredBlock[] }>
): string[] {
  return [
    ...new Set(
      messages.flatMap(message =>
        message.content.flatMap(block =>
          block.type === 'attachment' ? [block.id] : []
        )
      )
    )
  ]
}

/**
 * The person's attachments with these ids, by id, with their bytes: for a
 * request to the model, which sends them.
 */
export async function attachmentsById(
  db: Kysely<Database>,
  userId: string,
  ids: readonly string[]
): Promise<Map<string, AttachmentRow>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .selectFrom('tess_attachments')
    .selectAll()
    .where('user_id', '=', userId)
    .where('id', 'in', [...ids])
    .execute()
  return new Map(rows.map(row => [row.id, row]))
}

/**
 * What the app shows and a summary writes of the person's attachments with
 * these ids, by id: never their bytes, which a conversation of pictures
 * would otherwise move out of the database on every read.
 */
export async function attachmentInfoById(
  db: Kysely<Database>,
  userId: string,
  ids: readonly string[]
): Promise<Map<string, AttachmentInfo>> {
  if (ids.length === 0) return new Map()
  const rows = await db
    .selectFrom('tess_attachments')
    .select([
      'id',
      'name',
      'kind',
      'description',
      sql<boolean>`data is null`.as('described')
    ])
    .where('user_id', '=', userId)
    .where('id', 'in', [...ids])
    .execute()
  return new Map(rows.map(row => [row.id, row]))
}

/**
 * The conversation as the Messages API takes it: the summary of what
 * compaction removed as a first exchange, then every message with its
 * attachments expanded, Tess's change ids dropped, empty blocks left out, and
 * messages of the same role in a row joined into one.
 */
export function requestMessages(
  summary: string | null,
  messages: ReadonlyArray<{
    role: 'user' | 'assistant'
    content: StoredBlock[]
  }>,
  attachments: ReadonlyMap<string, AttachmentRow>
): MessageParam[] {
  const out: MessageParam[] = []
  const push = (role: 'user' | 'assistant', content: ContentBlock[]): void => {
    if (content.length === 0) return
    // The first message is the person's: anything of Tess's before it has
    // lost what it answered.
    if (out.length === 0 && role === 'assistant') return
    const last = out[out.length - 1]
    if (last?.role === role) (last.content as ContentBlock[]).push(...content)
    else out.push({ role, content: [...content] })
  }
  if (summary != null && summary !== '') {
    push('user', [
      {
        type: 'text',
        text: `A summary of our conversation before the messages that follow:\n${summary}`
      }
    ])
    push('assistant', [
      { type: 'text', text: 'Thank you. I will keep that in mind.' }
    ])
  }
  for (const message of messages)
    push(
      message.role,
      message.content.flatMap((block): ContentBlock[] => {
        if (block.type === 'change') return []
        if (block.type === 'confirmation')
          return [{ type: 'text', text: block.text }]
        if (block.type === 'moment')
          return [{ type: 'text', text: momentText(block) }]
        if (block.type === 'attachment') {
          const row = attachments.get(block.id)
          return [
            row == null
              ? { type: 'text', text: 'An attachment that was removed.' }
              : attachmentBlock(row)
          ]
        }
        if (block.type === 'text' && block.text.trim() === '') return []
        return [block]
      })
    )
  return out
}

/**
 * The conversation as the app shows it. The person's messages show their
 * text and attachments. Tess's messages of one turn, which her tool calls
 * split, show as one reply: the text of each, then a card for each change
 * she proposed. Tool results and confirmation notes are not shown, and a
 * reply with neither text nor a change is left out.
 */
export function viewMessages(
  messages: readonly StoredMessage[],
  attachments: ReadonlyMap<string, AttachmentInfo>,
  changes: ReadonlyMap<string, TessChange>
): TessMessage[] {
  const out: TessMessage[] = []
  let reply: TessMessage | undefined
  const close = (): void => {
    if (reply != null && (reply.text !== '' || reply.changes.length > 0))
      out.push(reply)
    reply = undefined
  }
  for (const message of messages) {
    if (message.role === 'user') {
      if (message.content.some(block => block.type === 'tool_result')) continue
      close()
      if (message.content.some(block => block.type === 'confirmation')) continue
      const clientId = message.content.find(
        (block): block is MomentNote => block.type === 'moment'
      )?.clientId
      out.push({
        id: String(message.id),
        role: 'user',
        text: textOf(message.content),
        attachments: message.content.flatMap(block => {
          if (block.type !== 'attachment') return []
          const row = attachments.get(block.id)
          return row == null
            ? []
            : [
                {
                  id: row.id,
                  name: row.name,
                  kind: row.kind,
                  described: row.described
                }
              ]
        }),
        changes: [],
        createdAt: message.createdAt.toISOString(),
        ...(clientId == null ? {} : { clientId })
      })
      continue
    }
    reply ??= {
      id: String(message.id),
      role: 'assistant',
      text: '',
      attachments: [],
      changes: [],
      createdAt: message.createdAt.toISOString()
    }
    const text = textOf(message.content)
    if (text !== '')
      reply.text = reply.text === '' ? text : `${reply.text}\n\n${text}`
    for (const block of message.content) {
      if (block.type !== 'change') continue
      const change = changes.get(block.id)
      if (change != null) reply.changes.push(change)
    }
  }
  close()
  return out
}

/** The text blocks of a message, or of a response, joined. */
export function textOf(content: readonly StoredBlock[]): string {
  return content
    .filter((block): block is TextBlock => block.type === 'text')
    .map(block => block.text.trim())
    .filter(text => text !== '')
    .join('\n\n')
}
