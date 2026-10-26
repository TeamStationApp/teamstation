import { sql } from 'kysely'

import { TESS_MAX_ATTACHMENTS, TESS_MAX_IMAGE_BYTES } from '../../common/api'
import { attachmentBlock, type AttachmentInfo } from './attachments'
import {
  attachmentIdsOf,
  attachmentInfoById,
  attachmentsById,
  callModel,
  isTurnStart,
  loadConversation,
  type ModelDeps,
  saveContextTokens,
  type StoredBlock,
  type StoredMessage,
  textOf
} from './conversation'
import { MAX_TOKENS, type MessagesResponse } from './messagesApi'

/**
 * Keeps a conversation under the model's window. Above 150,000 tokens it is
 * compacted: every attachment it holds is described and its bytes dropped,
 * and everything before its last three turns is summarized into the
 * conversation's summary, which every later request starts with. A request
 * is never sent above 200,000 with the room its answer may take.
 *
 * Pictures are cheap in tokens but not in bytes, and the provider refuses a
 * request body over 32 MB. So the pictures a request carries are kept to one
 * message's worth of base64, and to 20: the older ones are described and
 * their bytes dropped first, as compaction does with all of them.
 *
 * The cut always falls where a turn starts (a message of the person's, never
 * a tool's result), so no tool call is parted from its result.
 */

export const COMPACT_ABOVE = 150000
export const CEILING = 200000
export const KEPT_TURNS = 3

/**
 * The most a request may hold: the window less the answer's room, since the
 * provider refuses a request whose input and `max_tokens` exceed it.
 */
export const INPUT_CEILING = CEILING - MAX_TOKENS

/**
 * The fewest characters a token takes, for an estimate that does not fall
 * short: prose runs near four, and JSON full of ids and numbers near two.
 * Near the threshold an estimate is checked with `count_tokens`.
 */
export const CHARS_PER_TOKEN = 2

/** What `text` takes at most, in tokens, by `CHARS_PER_TOKEN`. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** What `bytes` take in base64, as a request carries them. */
export function base64Length(bytes: number): number {
  return 4 * Math.ceil(bytes / 3)
}

/**
 * The most base64 a request's pictures may come to: a message of five
 * pictures at the limit, 25 MiB. The rest of a request is held to 200,000
 * tokens, a few MB at most, so the body stays clear of the provider's 32 MB.
 */
export const PICTURE_BYTES =
  TESS_MAX_ATTACHMENTS * base64Length(TESS_MAX_IMAGE_BYTES)

/**
 * The most pictures a request may carry: above 20 the provider refuses any
 * larger than 2000 px a side, and a picture uploaded on the web is not
 * scaled.
 */
export const MAX_PICTURES = 20

/** How much of one tool call or result the summary's transcript keeps. */
const TRANSCRIPT_CLIP = 1500

export const DESCRIBE_SYSTEM =
  'You describe a file a TeamStation user gave Tess, their assistant, so that the description can stand in for the file later in the conversation. Keep every fact, number, name, date and table row a later question about it may need. Write plain text, at most 400 words.'

export const SUMMARY_SYSTEM =
  'You write the summary that replaces the earlier part of a conversation between a TeamStation user and Tess, their assistant, so that the conversation can go on without it. Keep every fact a later answer may need: the teams, games, people and ids looked up and what was found, the changes proposed and what the server answered, what the person asked for and what is still open. Leave out greetings. Write plain text, at most 600 words.'

/**
 * Compacts the person's conversation, then measures it with `measure` and
 * saves that size. When the last three turns alone are still above the
 * threshold, only the last turn is kept; and with `keepNone`, before a new
 * message is stored, when that turn is still too large, none is, so the new
 * message always has room. Answers the size.
 */
export async function compact(
  deps: ModelDeps,
  userId: string,
  measure: () => Promise<number>,
  options: { keepNone?: boolean } = {}
): Promise<number> {
  await describeAttachments(deps, userId)
  await summarizeBefore(deps, userId, KEPT_TURNS)
  let tokens = await measure()
  if (tokens > COMPACT_ABOVE && (await summarizeBefore(deps, userId, 1)))
    tokens = await measure()
  if (
    tokens > COMPACT_ABOVE &&
    options.keepNone === true &&
    (await summarizeBefore(deps, userId, 0))
  )
    tokens = await measure()
  await saveContextTokens(deps.db, userId, tokens)
  return tokens
}

/**
 * Keeps the pictures the next request carries, the conversation's and those
 * of `extra`, a message not yet stored, within `PICTURE_BYTES` and
 * `MAX_PICTURES`. Counting from the newest, the first picture that does not
 * fit is described and its bytes dropped, and so is every picture before
 * it. A message's own pictures always fit, so the person's newest pictures
 * are sent as they are. `beforeDescribing` is awaited first when any is.
 */
export async function fitPictures(
  deps: ModelDeps,
  userId: string,
  extra: StoredBlock[] = [],
  beforeDescribing?: () => Promise<void>
): Promise<void> {
  const { messages } = await loadConversation(deps.db, userId)
  const newestFirst = attachmentIdsOf(
    [...messages, { content: extra }]
      .reverse()
      .map(message => ({ content: [...message.content].reverse() }))
  )
  if (newestFirst.length === 0) return
  // Their sizes only: the bytes stay in the database.
  const rows = await deps.db
    .selectFrom('tess_attachments')
    .select(['id', sql<number>`octet_length(data)`.as('bytes')])
    .where('user_id', '=', userId)
    .where('kind', '=', 'image')
    .where('data', 'is not', null)
    .where('id', 'in', newestFirst)
    .execute()
  const sizes = new Map(rows.map(row => [row.id, Number(row.bytes)]))
  const over: string[] = []
  let bytes = 0
  let pictures = 0
  for (const id of newestFirst) {
    const size = sizes.get(id)
    if (size == null) continue
    bytes += base64Length(size)
    pictures += 1
    if (over.length > 0 || bytes > PICTURE_BYTES || pictures > MAX_PICTURES)
      over.push(id)
  }
  if (over.length === 0) return
  await beforeDescribing?.()
  await describeAttachments(deps, userId, over)
}

/**
 * Describes each attachment the conversation still holds the bytes of, or
 * each of `ids`, one Messages call each, then drops the bytes. The
 * description is written in the same statement that clears the data, so
 * each has one or the other.
 */
export async function describeAttachments(
  deps: ModelDeps,
  userId: string,
  ids?: readonly string[]
): Promise<void> {
  const attachments = await attachmentsById(
    deps.db,
    userId,
    ids ?? attachmentIdsOf((await loadConversation(deps.db, userId)).messages)
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
    const described = responseText(response)
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
 * the summary before it, and deletes it; `keep` 0 summarizes it all. Answers
 * whether anything was.
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
  if (starts.length <= keep && keep > 0) return false
  const cut =
    keep === 0 ? conversation.messages.length : starts[starts.length - keep]
  const removed = conversation.messages.slice(0, cut)
  if (removed.length === 0) return false
  const attachments = await attachmentInfoById(
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
  const written = responseText(response)
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
      .where('id', '<=', removed[removed.length - 1].id)
      .execute()
  })
  return true
}

/** Messages written out as lines for the summary: who said or did what. */
export function transcriptOf(
  messages: readonly StoredMessage[],
  attachments: ReadonlyMap<string, Pick<AttachmentInfo, 'name' | 'description'>>
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
export function responseText(response: MessagesResponse): string {
  return textOf(response.content)
}
