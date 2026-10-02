import { createHash, randomBytes } from 'node:crypto'
import { createReadStream } from 'node:fs'
import { mkdir, rename, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

import { type Kysely, type RawBuilder, type Selectable, sql } from 'kysely'

import { MAX_ATTACHMENT_SIZE } from '../../common/chatContent'
import { blobLength } from '../../common/chatCrypto/stream'
import { badRequest, conflict, forbidden, notFound } from '../../common/errors'
import { makeId } from '../../common/ids'
import type { ChatAttachmentsTable, Database } from '../db/database'
import {
  assembleParts,
  isComplete,
  missingParts,
  partBytes,
  partCount,
  partName,
  receivedParts
} from '../director/uploads'
import { deleteObject, putObjectFile } from '../media/images'
import { presignGetUrl } from '../media/presign'
import { spaceConfigured, type SpaceSettings } from '../media/spacesHls'
import type { ChatCaller } from './keys'
import { type ChatObjectStore, mayPost } from './messages'
import { memberNow } from './reconciler'
import { b64 } from './wire'

/**
 * Encrypted attachments.
 *
 * The app seals a file with `chatCrypto/stream.ts` and sends the server only
 * the blob: ciphertext, padded to its bucket, with its SHA-256 (the digest)
 * declared up front. The key and the file's name and type travel inside the
 * message, never here.
 *
 * - **Upload, in parts.** `POST /chat/attachments` `{ conversationId, size,
 *   digest }` opens one for a member who may post there, and says how many
 *   8 MiB parts to send. Each `PUT …/parts/:n` writes one to
 *   `<uploadsDir>/chat/<id>/`, as `director/uploads.ts` keeps a Director's:
 *   what is on disk is what has arrived, so a killed app asks
 *   (`GET /chat/attachments/:id`) and sends only what is missing.
 * - **Complete.** Every part here, they are joined, the join must hash to the
 *   declared digest (`digestMismatch` otherwise, and the parts are dropped so
 *   the upload starts again), and the blob is streamed to the Space at
 *   `chat/<conversationId>/<attachmentId>`. The parts go once it is there.
 * - **Download.** `GET /chat/attachments/:id` answers a member of its
 *   conversation a presigned GET good for 10 minutes. The blob opens only
 *   with the key inside the message.
 * - **Clean-up.** `purgeChatAttachments` (hourly, `startChatPurge`, in the
 *   primary) deletes, object, parts and row, every attachment no message
 *   references 24 hours after it was opened, and every attachment that only
 *   cleared messages reference.
 */

/** The size of every part but the last. */
export const CHAT_PART_SIZE = 8 * 1024 * 1024

/** The body limit of one part: room over `CHAT_PART_SIZE`. */
export const CHAT_PART_LIMIT = 9 * 1024 * 1024

/** The largest blob: what the largest file (100 MiB) seals to. */
export const MAX_BLOB = blobLength(MAX_ATTACHMENT_SIZE)

/** How long an attachment no message references is kept. */
export const ORPHAN_AFTER_MS = 24 * 3600 * 1000

/** How long a presigned read stays good. */
export const READ_URL_SEC = 600

/** How often the purge sweeps. */
export const CHAT_PURGE_INTERVAL_MS = 3600 * 1000

/** Where an attachment's object lives in the Space. */
export function attachmentKey(
  conversationId: string,
  attachmentId: string
): string {
  return `chat/${conversationId}/${attachmentId}`
}

/** Where an attachment's parts wait while they arrive. */
export function chatUploadDir(
  uploadsDir: string,
  attachmentId: string
): string {
  return join(uploadsDir, 'chat', attachmentId)
}

export interface ChatAttachmentContext {
  db: Kysely<Database>
  space: SpaceSettings
  uploadsDir: string
}

/** An upload still arriving, as its uploader sees it. */
export interface AttachmentUpload {
  id: string
  conversationId: string
  size: number
  completed: false
  partSize: number
  parts: number
  missing: number[]
}

/** A finished attachment. `url` and `expiresAt` only on a read. */
export interface AttachmentView {
  id: string
  conversationId: string
  size: number
  /** SHA-256 of the blob, base64url. */
  digest: string
  completed: true
  url?: string
  expiresAt?: string
}

export interface NewAttachment {
  conversationId: string
  size: number
  digest: Uint8Array
}

type AttachmentRow = Selectable<ChatAttachmentsTable>

/** `POST /chat/attachments`: opens an upload. */
export async function createAttachment(
  context: ChatAttachmentContext,
  caller: ChatCaller,
  body: NewAttachment,
  now: Date
): Promise<AttachmentUpload> {
  const { db, uploadsDir } = context
  const standing = await mayPost(db, body.conversationId, caller.userId, now)
  if (standing === 'stranger') throw notFound()
  if (standing === 'reader') {
    throw forbidden('You cannot post attachments in this chat', {
      reason: 'readOnly'
    })
  }
  theSpace(context)
  const id = makeId('chatAttachment')
  await mkdir(chatUploadDir(uploadsDir, id), { recursive: true })
  await db
    .insertInto('chat_attachments')
    .values({
      id,
      conversation_id: body.conversationId,
      uploader_user_id: caller.userId,
      size: body.size,
      object_key: attachmentKey(body.conversationId, id),
      digest: body.digest,
      completed_at: null,
      created_at: now
    })
    .execute()
  return {
    id,
    conversationId: body.conversationId,
    size: body.size,
    completed: false,
    partSize: CHAT_PART_SIZE,
    parts: partCount(body.size, CHAT_PART_SIZE),
    missing: missingParts([], partCount(body.size, CHAT_PART_SIZE))
  }
}

/** `PUT /chat/attachments/:id/parts/:n`: one part, written again on a repeat. */
export async function putPart(
  context: ChatAttachmentContext,
  caller: ChatCaller,
  attachmentId: string,
  index: number,
  bytes: Buffer,
  now: Date
): Promise<{ received: number; parts: number; missing: number[] }> {
  const row = await uploadersRow(context.db, caller, attachmentId, now)
  if (row.completed_at != null) {
    throw conflict('This attachment is complete', { reason: 'completed' })
  }
  const size = Number(row.size)
  const total = partCount(size, CHAT_PART_SIZE)
  if (!Number.isSafeInteger(index) || index < 0 || index >= total) {
    throw badRequest(`There is no part ${index} of this attachment`, {
      reason: 'part'
    })
  }
  const expected = partBytes(index, size, CHAT_PART_SIZE)
  if (bytes.length !== expected) {
    throw badRequest(
      `Part ${index} should be ${expected} bytes and arrived as ${bytes.length}`,
      { reason: 'part' }
    )
  }
  const dir = chatUploadDir(context.uploadsDir, row.id)
  await mkdir(dir, { recursive: true })
  // Written aside and renamed, so a part on disk is always a whole part.
  const aside = join(dir, `incoming-${randomBytes(6).toString('hex')}`)
  await writeFile(aside, bytes)
  await rename(aside, join(dir, partName(index)))
  const received = await receivedParts(dir)
  return {
    received: received.length,
    parts: total,
    missing: missingParts(received, total)
  }
}

/**
 * `POST /chat/attachments/:id/complete`: checks the digest and puts the blob
 * in the Space. A repeat answers the finished attachment.
 */
export async function completeAttachment(
  context: ChatAttachmentContext,
  caller: ChatCaller,
  attachmentId: string,
  now: Date
): Promise<AttachmentView> {
  const { db, uploadsDir } = context
  const row = await uploadersRow(db, caller, attachmentId, now)
  if (row.completed_at != null) return viewOf(row)
  const space = theSpace(context)
  const dir = chatUploadDir(uploadsDir, row.id)
  const total = partCount(Number(row.size), CHAT_PART_SIZE)
  const received = await receivedParts(dir)
  if (!isComplete(received, total)) {
    const missing = missingParts(received, total)
    throw conflict(`${missing.length} parts have not arrived`, {
      reason: 'partsMissing',
      missing
    })
  }
  // A name of its own, so two completes at once never write one file.
  const whole = join(dir, `whole-${randomBytes(6).toString('hex')}`)
  try {
    await assembleParts({ dir, total, into: whole })
    const digest = await sha256File(whole)
    if (!digest.equals(Buffer.from(row.digest))) {
      // Which part is wrong cannot be told, so none is kept.
      await rm(dir, { recursive: true, force: true })
      throw badRequest('The attachment does not match its digest', {
        reason: 'digestMismatch'
      })
    }
    await putObjectFile({
      space,
      key: row.object_key,
      path: whole,
      contentType: 'application/octet-stream'
    })
  } finally {
    await rm(whole, { force: true })
  }
  const done = await db
    .updateTable('chat_attachments')
    .set({ completed_at: now })
    .where('id', '=', row.id)
    .where('completed_at', 'is', null)
    .returningAll()
    .executeTakeFirst()
  await rm(dir, { recursive: true, force: true })
  return viewOf(done ?? { ...row, completed_at: now })
}

/**
 * `GET /chat/attachments/:id`: for a member, a finished attachment with a
 * presigned GET good for 10 minutes; for its uploader, an unfinished one
 * with the parts still missing. Anybody else, and anything unfinished
 * that is not theirs, is not found.
 */
export async function readAttachment(
  context: ChatAttachmentContext,
  caller: ChatCaller,
  attachmentId: string,
  now: Date
): Promise<AttachmentView | AttachmentUpload> {
  const { db } = context
  const row = await db
    .selectFrom('chat_attachments')
    .selectAll()
    .where('id', '=', attachmentId)
    .executeTakeFirst()
  if (
    row == null ||
    !(await memberNow(db, row.conversation_id, caller.userId, now))
  ) {
    throw notFound()
  }
  if (row.completed_at == null) {
    if (Number(row.uploader_user_id) !== caller.userId) throw notFound()
    const total = partCount(Number(row.size), CHAT_PART_SIZE)
    const received = await receivedParts(
      chatUploadDir(context.uploadsDir, row.id)
    )
    return {
      id: row.id,
      conversationId: row.conversation_id,
      size: Number(row.size),
      completed: false,
      partSize: CHAT_PART_SIZE,
      parts: total,
      missing: missingParts(received, total)
    }
  }
  const space = theSpace(context)
  return {
    ...viewOf(row),
    url: presignGetUrl({
      ...space,
      key: row.object_key,
      expiresSec: READ_URL_SEC,
      now
    }),
    expiresAt: new Date(now.getTime() + READ_URL_SEC * 1000).toISOString()
  }
}

/** Deletes attachment objects from the Space, one key at a time. */
export function spaceObjectStore(space: SpaceSettings): ChatObjectStore {
  return {
    deleteObjects: async keys => {
      for (const key of keys) await deleteObject({ space, key })
    }
  }
}

/**
 * The orphans: attachments no message references, 24 hours after they were
 * opened, and attachments only cleared messages reference (whatever their
 * age). Each goes from the Space, from the disk and from the table, under
 * its row's lock with the rule checked again, so a post that names it in the
 * meantime either keeps it or is refused (`attachment`). The ids purged.
 */
export async function purgeChatAttachments(options: {
  db: Kysely<Database>
  objects: ChatObjectStore
  uploadsDir: string
  now: Date
  log?: (message: string) => void
}): Promise<string[]> {
  const { db, objects, uploadsDir, now } = options
  const cutoff = new Date(now.getTime() - ORPHAN_AFTER_MS)
  const { rows } = await sql<{ id: string }>`
    select a.id from chat_attachments a
    where ${orphan(sql.ref('a.id'), sql.ref('a.created_at'), cutoff)}
    order by a.created_at, a.id
  `.execute(db)
  const purged: string[] = []
  for (const { id } of rows) {
    try {
      const gone = await db.transaction().execute(async trx => {
        const { rows: locked } = await sql<{
          id: string
          objectKey: string
        }>`
          select a.id, a.object_key as "objectKey" from chat_attachments a
          where a.id = ${id}
          and ${orphan(sql.ref('a.id'), sql.ref('a.created_at'), cutoff)}
          for update
        `.execute(trx)
        if (locked.length === 0) return false
        await objects.deleteObjects([locked[0].objectKey])
        await rm(chatUploadDir(uploadsDir, id), {
          recursive: true,
          force: true
        })
        await trx.deleteFrom('chat_attachments').where('id', '=', id).execute()
        return true
      })
      if (gone) purged.push(id)
    } catch (error) {
      options.log?.(`purging chat attachment ${id}: ${String(error)}`)
    }
  }
  return purged
}

/** The orphan rule, for the attachment named by `id`. */
function orphan(
  id: RawBuilder<unknown>,
  createdAt: RawBuilder<unknown>,
  cutoff: Date
): RawBuilder<unknown> {
  return sql`(
    (
      not exists (
        select 1 from chat_message_attachments l where l.attachment_id = ${id}
      )
      and ${createdAt} < ${cutoff}
    )
    or (
      exists (
        select 1 from chat_message_attachments l where l.attachment_id = ${id}
      )
      and not exists (
        select 1 from chat_message_attachments l
        join chat_messages m on m.id = l.message_id
        where l.attachment_id = ${id} and m.cleared_at is null
      )
    )
  )`
}

export interface ChatPurgeHandle {
  /** One sweep now; the ids purged. */
  sweep: () => Promise<string[]>
  stop: () => void
}

/**
 * Sweeps on the way up and then hourly, whenever a Space is configured.
 *
 * Apart from `purgeReplacedRecordings`, which gates only the recordings'
 * purge: chat attachments are this deployment's own uploads, and an orphan
 * left in the Space is paid for and readable by nobody.
 */
export function startChatPurge(
  db: Kysely<Database>,
  config: { space: SpaceSettings; uploadsDir: string },
  options: {
    clock?: () => Date
    intervalMs?: number
    objects?: ChatObjectStore
    log?: (message: string) => void
  } = {}
): ChatPurgeHandle | undefined {
  if (!spaceConfigured(config.space)) return undefined
  const clock = options.clock ?? (() => new Date())
  const log =
    options.log ??
    ((message: string): void => {
      console.log(message)
    })
  const objects = options.objects ?? spaceObjectStore(config.space)
  const sweep = async (): Promise<string[]> => {
    const purged = await purgeChatAttachments({
      db,
      objects,
      uploadsDir: config.uploadsDir,
      now: clock(),
      log
    })
    if (purged.length > 0) {
      log(`purged ${purged.length} orphaned chat attachment(s)`)
    }
    return purged
  }
  const run = (): void => {
    sweep().catch((error: unknown) => {
      log(`purging chat attachments: ${String(error)}`)
    })
  }
  run()
  const timer = setInterval(run, options.intervalMs ?? CHAT_PURGE_INTERVAL_MS)
  timer.unref?.()
  return {
    sweep,
    stop: () => {
      clearInterval(timer)
    }
  }
}

/** The uploader's own attachment in a conversation they are still in. */
async function uploadersRow(
  db: Kysely<Database>,
  caller: ChatCaller,
  attachmentId: string,
  now: Date
): Promise<AttachmentRow> {
  const row = await db
    .selectFrom('chat_attachments')
    .selectAll()
    .where('id', '=', attachmentId)
    .executeTakeFirst()
  if (
    row == null ||
    Number(row.uploader_user_id) !== caller.userId ||
    !(await memberNow(db, row.conversation_id, caller.userId, now))
  ) {
    throw notFound()
  }
  return row
}

function theSpace(context: ChatAttachmentContext): SpaceSettings {
  if (!spaceConfigured(context.space)) {
    throw badRequest('This server has nowhere to keep attachments', {
      reason: 'noSpace'
    })
  }
  return context.space
}

function viewOf(row: AttachmentRow): AttachmentView {
  return {
    id: row.id,
    conversationId: row.conversation_id,
    size: Number(row.size),
    digest: b64(row.digest),
    completed: true
  }
}

async function sha256File(path: string): Promise<Buffer> {
  const hash = createHash('sha256')
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer)
  return hash.digest()
}
