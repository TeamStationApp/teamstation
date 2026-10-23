import type { Kysely } from 'kysely'

import type { Database } from '../db/database'
import { attachmentBlock, type AttachmentRow } from './attachments'
import {
  attachmentIdsOf,
  attachmentsById,
  callModel,
  isTurnStart,
  loadConversation,
  type ModelDeps,
  saveContextTokens,
  type StoredMessage
} from './conversation'
import type { ContentBlock, MessagesResponse } from './messagesApi'

/**
 * Keeps a conversation under the model's window. Above 150,000 tokens it is
 * compacted: every attachment it holds is described and its bytes dropped,
 * and everything before its last three turns is summarized into the
 * conversation's summary, which every later request starts with. A request
 * is never sent above 200,000.
 *
 * The cut always falls where a turn starts (a message of the person's, never
 * a tool's result), so no tool call is parted from its result.
 */

export const COMPACT_ABOVE = 150000
export const CEILING = 200000
export const KEPT_TURNS = 3

/** How much of one tool call or result the summary's transcript keeps. */
const TRANSCRIPT_CLIP = 1500

export const DESCRIBE_SYSTEM =
  'You describe a file a TeamStation user gave Tess, their assistant, so that the description can stand in for the file later in the conversation. Keep every fact, number, name, date and table row a later question about it may need. Write plain text, at most 400 words.'

export const SUMMARY_SYSTEM =
  'You write the summary that replaces the earlier part of a conversation between a TeamStation user and Tess, their assistant, so that the conversation can go on without it. Keep every fact a later answer may need: the teams, games, people and ids looked up and what was found, the changes proposed and what the server answered, what the person asked for and what is still open. Leave out greetings. Write plain text, at most 600 words.'

/**
 * Compacts the person's conversation, then measures it with `measure` and
 * saves that size. When the last three turns alone are still above the
 * threshold, only the last turn is kept. Answers the size.
 */
export async function compact(
  deps: ModelDeps,
  userId: string,
  measure: () => Promise<number>
): Promise<number> {
  await describeAttachments(deps, userId)
  await summarizeBefore(deps, userId, KEPT_TURNS)
  let tokens = await measure()
  if (tokens > COMPACT_ABOVE && (await summarizeBefore(deps, userId, 1)))
    tokens = await measure()
  await saveContextTokens(deps.db, userId, tokens)
  return tokens
}

/**
 * Describes each attachment the conversation still holds the bytes of, one
 * Messages call each, then drops the bytes. The description is written in
 * the same statement that clears the data, so each has one or the other.
 */
export async function describeAttachments(
  deps: ModelDeps,
  userId: string
): Promise<void> {
  const { messages } = await loadConversation(deps.db, userId)
  const attachments = await attachmentsById(
    deps.db,
    userId,
    attachmentIdsOf(messages)
  )
  for (const row of attachments.values()) {
    if (row.data == null) continue
    const response = await callModel(deps, userId, {
      system: [{ text: DESCRIBE_SYSTEM }],
      messages: [
        {
          role: 'user',
          content: [
            attachmentBlock(row),
            {
              type: 'text',
              text: `Describe the attachment ${row.name} for later reference.`
            }
          ]
        }
      ]
    })
    const described = textOf(response)
    await deps.db
      .updateTable('tess_attachments')
      .set({
        description:
          described === ''
            ? `${row.name}, a ${row.kind} file that could not be described.`
            : described,
        data: null
      })
      .where('id', '=', row.id)
      .where('user_id', '=', userId)
      .execute()
  }
}

/**
 * Summarizes everything before the last `keep` turns into the summary, with
 * the summary before it, and deletes it. Answers whether anything was.
 */
export async function summarizeBefore(
  deps: ModelDeps,
  userId: string,
  keep: number
): Promise<boolean> {
  const conversation = await loadConversation(deps.db, userId)
  const starts = conversation.messages.flatMap((message, at) =>
    isTurnStart(message) ? [at] : []
  )
  if (starts.length <= keep) return false
  const cut = starts[starts.length - keep]
  const removed = conversation.messages.slice(0, cut)
  if (removed.length === 0) return false
  const attachments = await attachmentsById(
    deps.db,
    userId,
    attachmentIdsOf(removed)
  )
  const earlier =
    conversation.summary == null || conversation.summary === ''
      ? ''
      : `The summary so far:\n${conversation.summary}\n\n`
  const response = await callModel(deps, userId, {
    system: [{ text: SUMMARY_SYSTEM }],
    messages: [
      {
        role: 'user',
        content: [
          {
            type: 'text',
            text: `${earlier}The conversation to summarize:\n${transcriptOf(removed, attachments)}`
          }
        ]
      }
    ]
  })
  const written = textOf(response)
  const summary = written === '' ? (conversation.summary ?? '') : written
  await deps.db.transaction().execute(async trx => {
    await trx
      .updateTable('tess_conversations')
      .set({ summary, updated_at: new Date() })
      .where('user_id', '=', userId)
      .execute()
    await trx
      .deleteFrom('tess_messages')
      .where('user_id', '=', userId)
      .where('id', '<', conversation.messages[cut].id)
      .execute()
  })
  return true
}

/** Messages written out as lines for the summary: who said or did what. */
export function transcriptOf(
  messages: readonly StoredMessage[],
  attachments: ReadonlyMap<string, AttachmentRow>
): string {
  const lines: string[] = []
  for (const message of messages) {
    const who = message.role === 'user' ? 'Person' : 'Tess'
    for (const block of message.content) {
      if (block.type === 'text' && block.text.trim() !== '')
        lines.push(`${who}: ${block.text.trim()}`)
      else if (block.type === 'attachment') {
        const row = attachments.get(block.id)
        lines.push(
          `Person attached ${row?.name ?? 'a file'}: ${row?.description ?? 'not described'}`
        )
      } else if (block.type === 'confirmation')
        lines.push(`Note: ${block.text}`)
      else if (block.type === 'tool_use')
        lines.push(
          `Tess used ${block.name} ${clip(JSON.stringify(block.input))}`
        )
      else if (block.type === 'tool_result')
        lines.push(
          `${block.is_error === true ? 'Tool error' : 'Tool result'}: ${clip(
            typeof block.content === 'string'
              ? block.content
              : block.content
                  .map(part => (part.type === 'text' ? part.text : '[image]'))
                  .join(' ')
          )}`
        )
    }
  }
  return lines.join('\n')
}

function clip(text: string): string {
  return text.length > TRANSCRIPT_CLIP
    ? `${text.slice(0, TRANSCRIPT_CLIP)}…`
    : text
}

/** A response's text blocks, joined. */
export function textOf(response: MessagesResponse): string {
  return response.content
    .filter(
      (block): block is Extract<ContentBlock, { type: 'text' }> =>
        block.type === 'text'
    )
    .map(block => block.text.trim())
    .filter(text => text !== '')
    .join('\n\n')
}

/** The attachments a refused message named that no stored message names. */
export async function dropUnsent(
  db: Kysely<Database>,
  userId: string,
  ids: readonly string[]
): Promise<void> {
  if (ids.length === 0) return
  const { messages } = await loadConversation(db, userId)
  const kept = new Set(attachmentIdsOf(messages))
  const unsent = ids.filter(id => !kept.has(id))
  if (unsent.length === 0) return
  await db
    .deleteFrom('tess_attachments')
    .where('user_id', '=', userId)
    .where('id', 'in', unsent)
    .execute()
}
