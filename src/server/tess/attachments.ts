import { randomUUID } from 'node:crypto'

import { type Kysely, type Selectable, sql } from 'kysely'

import {
  TESS_MAX_ATTACHMENTS,
  TESS_MAX_IMAGE_BYTES,
  TESS_MAX_TEXT_BYTES,
  type TessAttachment,
  type TessAttachmentBody,
  tessUploadType
} from '../../common/api'
import { badRequest, tooLarge, unsupportedMedia } from '../../common/errors'
import { lockKeys } from '../db/advisoryLocks'
import type { Database, TessAttachmentsTable } from '../db/database'
import { holdLiveUser } from './liveUser'
import type { ImageBlock, TextBlock } from './messagesApi'

/**
 * Files given to Tess: pictures, and CSV, plain text and Markdown. Each is
 * uploaded on its own and then named by id in a message, at most five to a
 * message. A picture's bytes must be the picture it says it is, and text must
 * be UTF-8, because the model refuses a request carrying anything else and a
 * stored one would refuse every request after it.
 *
 * Until a message names it, an upload is held for that message: at most
 * 25 MB of them a person, and each for a day, after which the next upload
 * or message clears it.
 */

const MAX_NAME = 200

/** The most a person's uploads that no message names may hold together. */
export const MAX_UNSENT_BYTES = 25 * 1024 * 1024
export const UNSENT_FULL =
  'Tess already holds 25 MB of files you have not sent. Send them first: files never sent are cleared after a day.'

export type AttachmentKind = TessAttachmentsTable['kind']
export type AttachmentRow = Selectable<TessAttachmentsTable>
/**
 * What is shown of an attachment, and written of it in a summary: never its
 * bytes, which only a request to the model reads.
 */
export type AttachmentInfo = Pick<
  AttachmentRow,
  'id' | 'name' | 'kind' | 'description'
> & {
  /** Its bytes were replaced by `description`. */
  described: boolean
}

/** An id as the database keeps attachments' and changes': a UUID. */
export function isUuid(id: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
    id
  )
}

/** The image type the bytes themselves are, whatever the upload said. */
export function sniffImage(bytes: Buffer): string | null {
  if (
    bytes.length >= 8 &&
    bytes.subarray(0, 8).equals(Buffer.from('89504e470d0a1a0a', 'hex'))
  )
    return 'image/png'
  if (
    bytes.length >= 3 &&
    bytes[0] === 0xff &&
    bytes[1] === 0xd8 &&
    bytes[2] === 0xff
  )
    return 'image/jpeg'
  if (
    bytes.length >= 6 &&
    /^GIF8[79]a$/.test(bytes.subarray(0, 6).toString('latin1'))
  )
    return 'image/gif'
  if (
    bytes.length >= 12 &&
    bytes.subarray(0, 4).toString('latin1') === 'RIFF' &&
    bytes.subarray(8, 12).toString('latin1') === 'WEBP'
  )
    return 'image/webp'
  return null
}

/** Checks and stores one upload, answering what the message names it by. */
export async function storeAttachment(
  db: Kysely<Database>,
  userId: string,
  body: TessAttachmentBody
): Promise<TessAttachment> {
  const name = cleanName(body.name)
  // The type and size rules are the app's own, from `common/api`.
  const classified = tessUploadType(name, body.mediaType)
  if (classified == null)
    throw unsupportedMedia(
      'Tess takes PNG, JPEG, GIF and WebP pictures, and CSV, plain text and Markdown files'
    )
  const limit =
    classified.kind === 'image' ? TESS_MAX_IMAGE_BYTES : TESS_MAX_TEXT_BYTES
  const encoded = body.data
    .replace(/^data:[^,]*;base64,/, '')
    .replace(/\s+/g, '')
  if (Math.floor((encoded.length * 3) / 4) > limit + 2)
    throw tooLarge(tooLargeMessage(classified.kind))
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(encoded) || encoded.length % 4 === 1)
    throw badRequest('The file is not valid base64')
  const bytes = Buffer.from(encoded, 'base64')
  if (bytes.length === 0) throw badRequest('The file is empty')
  if (bytes.length > limit) throw tooLarge(tooLargeMessage(classified.kind))
  let mediaType = classified.mediaType
  if (classified.kind === 'image') {
    const sniffed = sniffImage(bytes)
    if (sniffed == null)
      throw unsupportedMedia('That picture is not a PNG, JPEG, GIF or WebP')
    mediaType = sniffed
  } else {
    try {
      new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    } catch {
      throw badRequest('Text files must be UTF-8')
    }
  }
  const id = randomUUID()
  // One upload of a person's at a time, so two cannot both fit the cap.
  await db.transaction().execute(async trx => {
    await lockKeys(trx, [`tess_attachments:${userId}`])
    // Nothing kept for an account deleted meanwhile.
    await holdLiveUser(trx, userId)
    await pruneAttachments(trx, userId)
    if ((await unsentBytes(trx, userId)) + bytes.length > MAX_UNSENT_BYTES)
      throw tooLarge(UNSENT_FULL)
    await trx
      .insertInto('tess_attachments')
      .values({
        id,
        user_id: userId,
        name,
        media_type: mediaType,
        kind: classified.kind,
        data: bytes
      })
      .execute()
  })
  return { id, name, kind: classified.kind }
}

/** Whether no message of the person's names attachment `a`. */
const unsent = sql<boolean>`not exists (
  select 1 from tess_messages m
  where m.user_id = a.user_id
    and m.content @> jsonb_build_array(
      jsonb_build_object('type', 'attachment', 'id', a.id::text)
    )
)`

/** The bytes the person's uploads that no message names hold together. */
async function unsentBytes(
  db: Kysely<Database>,
  userId: string
): Promise<number> {
  const row = await db
    .selectFrom('tess_attachments as a')
    .select(sql<string>`coalesce(sum(octet_length(a.data)), 0)`.as('bytes'))
    .where('a.user_id', '=', userId)
    .where(unsent)
    .executeTakeFirstOrThrow()
  return Number(row.bytes)
}

/**
 * Deletes the person's uploads that no message names and that are more than
 * a day old, but for `keep`: the ones a message being sent names.
 */
export async function pruneAttachments(
  db: Kysely<Database>,
  userId: string,
  keep: readonly string[] = []
): Promise<void> {
  let query = db
    .deleteFrom('tess_attachments as a')
    .where('a.user_id', '=', userId)
    .where('a.created_at', '<', sql<Date>`now() - interval '1 day'`)
    .where(unsent)
  if (keep.length > 0) query = query.where('a.id', 'not in', [...keep])
  await query.execute()
}

/**
 * The attachments one message names, by id: at most five, each the
 * caller's own. Any other id is refused as unknown, whoever it belongs to.
 * Their bytes are not read: the request that sends them reads them.
 */
export async function ownedAttachments(
  db: Kysely<Database>,
  userId: string,
  ids: readonly string[]
): Promise<Array<Pick<AttachmentRow, 'id'>>> {
  const unique = [...new Set(ids)]
  if (unique.length > TESS_MAX_ATTACHMENTS)
    throw badRequest(
      `A message takes at most ${TESS_MAX_ATTACHMENTS} attachments`
    )
  if (unique.length === 0) return []
  if (!unique.every(isUuid)) throw badRequest('Unknown attachment')
  const rows = await db
    .selectFrom('tess_attachments')
    .select('id')
    .where('user_id', '=', userId)
    .where('id', 'in', unique)
    .execute()
  if (rows.length !== unique.length) throw badRequest('Unknown attachment')
  return unique.map(id => ({ id }))
}

/**
 * What the model is sent for an attachment: a picture as itself and a text
 * file as text headed by its name, or, once compaction has cleared its bytes,
 * the description written in their place.
 */
export function attachmentBlock(
  row: Pick<
    AttachmentRow,
    'name' | 'media_type' | 'kind' | 'data' | 'description'
  >
): ImageBlock | TextBlock {
  if (row.data == null)
    return {
      type: 'text',
      text: `Attachment ${row.name} (described): ${row.description ?? ''}`
    }
  if (row.kind === 'image')
    return {
      type: 'image',
      source: {
        type: 'base64',
        media_type: row.media_type,
        data: row.data.toString('base64')
      }
    }
  return {
    type: 'text',
    text: `Attachment ${row.name} (${row.kind}):\n${row.data.toString('utf8')}`
  }
}

/** A file name as stored: no path, no control characters, not too long. */
function cleanName(raw: string): string {
  const base = raw.split(/[/\\]/).pop() ?? ''
  // eslint-disable-next-line no-control-regex
  const name = base.replace(/[\u0000-\u001f\u007f]/g, '').trim()
  return (name === '' ? 'attachment' : name).slice(0, MAX_NAME)
}

function tooLargeMessage(kind: AttachmentKind): string {
  return kind === 'image'
    ? 'Pictures for Tess can be up to 3.75 MB'
    : 'Text files for Tess can be up to 1 MB'
}
