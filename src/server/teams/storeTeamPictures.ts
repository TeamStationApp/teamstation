import type { Kysely } from 'kysely'

import {
  badRequest,
  tooLarge,
  unavailable,
  unsupportedMedia
} from '../../common/errors'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import {
  type ImageKind,
  MAX_SOURCE_BYTES,
  type StoredImage,
  storeImage,
  UnreadableImage
} from '../media/images'
import { imageUrl, PROFILE_SIZE } from '../media/imageUrls'
import { spaceConfigured, type SpaceSettings } from '../media/spacesHls'
import { noteScopeChange } from '../socket/syncRevision'

/**
 * A team's logo and a player's headshot, sent as base64 inside JSON and
 * stored as the normalised renditions every other picture is.
 */

/** Where a picture came from, in the columns' own words. */
export type PictureSource = 'import' | 'upload'

/** The kinds of picture a body may carry. */
export const PICTURE_TYPES = ['image/jpeg', 'image/png', 'image/webp'] as const
export type PictureType = (typeof PICTURE_TYPES)[number]

export interface SentPicture {
  contentType: PictureType
  bytes: Buffer
  source: PictureSource
}

/**
 * `stored: true` with the profile-size URL when the picture was written;
 * `stored: false` when it was the one already held, with `kept: 'upload'`
 * when an import met a picture somebody uploaded, which an import never
 * replaces.
 */
export type StoredPicture =
  { stored: true; url: string } | { stored: false; kept?: 'upload' }

/** What storing needs: the FFmpeg that normalises, the Space that holds. */
export interface PictureStore {
  ffmpegPath: string
  space: SpaceSettings
}

/**
 * Strict base64, as `^[A-Za-z0-9+/]+={0,2}$` with a length divisible by 4
 * would say: the alphabet, then at most two pads. Read a character at a time
 * rather than by that pattern, which overflows the stack on the 13 MB string
 * a 10 MiB picture is.
 */
function isBase64(text: string): boolean {
  if (text.length === 0 || text.length % 4 !== 0) return false
  const end = text.endsWith('==')
    ? text.length - 2
    : text.endsWith('=')
      ? text.length - 1
      : text.length
  if (end === 0) return false
  for (let i = 0; i < end; i += 1) {
    const c = text.charCodeAt(i)
    const alphabet =
      (c >= 65 && c <= 90) || // A-Z
      (c >= 97 && c <= 122) || // a-z
      (c >= 48 && c <= 57) || // 0-9
      c === 43 || // +
      c === 47 // /
    if (!alphabet) return false
  }
  return true
}

function isRecord(raw: unknown): raw is Record<string, unknown> {
  return typeof raw === 'object' && raw != null && !Array.isArray(raw)
}

/**
 * The body `{image: {contentType, base64}, source}`, or the error to answer:
 * 415 for a content type other than JPEG, PNG or WebP, 400 for anything that
 * is not strict base64, 413 for more than `MAX_SOURCE_BYTES` decoded, known
 * from the length before anything is decoded, and 415 for bytes that do not
 * begin with the declared type's signature.
 */
export function asPictureBody(raw: unknown): SentPicture {
  if (!isRecord(raw)) throw badRequest('The body must be { image, source }')
  const { image, source } = raw
  if (source !== 'import' && source !== 'upload') {
    throw badRequest('source must be import or upload')
  }
  if (!isRecord(image)) throw badRequest('image must be an object')
  const contentType = PICTURE_TYPES.find(type => type === image.contentType)
  if (contentType == null) {
    throw unsupportedMedia(
      'image.contentType must be image/jpeg, image/png or image/webp'
    )
  }
  const { base64 } = image
  if (typeof base64 !== 'string' || !isBase64(base64)) {
    throw badRequest('image.base64 is not base64')
  }
  const padding = base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0
  if ((base64.length / 4) * 3 - padding > MAX_SOURCE_BYTES) {
    throw tooLarge(
      `A picture is at most ${MAX_SOURCE_BYTES / (1024 * 1024)} MiB`
    )
  }
  const bytes = Buffer.from(base64, 'base64')
  if (!isOfType(bytes, contentType)) {
    throw unsupportedMedia('The picture is not the type it says it is')
  }
  return { contentType, bytes, source }
}

/**
 * Whether the bytes begin with their type's signature: JPEG `FF D8 FF`, PNG
 * `89 50 4E 47 0D 0A 1A 0A`, WebP `RIFF`, four bytes of length, `WEBP`.
 */
function isOfType(bytes: Buffer, contentType: PictureType): boolean {
  const startsWith = (at: number, signature: number[]): boolean =>
    bytes.length >= at + signature.length &&
    signature.every((byte, i) => bytes[at + i] === byte)
  switch (contentType) {
    case 'image/jpeg':
      return startsWith(0, [0xff, 0xd8, 0xff])
    case 'image/png':
      return startsWith(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    case 'image/webp':
      return (
        startsWith(0, [0x52, 0x49, 0x46, 0x46]) &&
        startsWith(8, [0x57, 0x45, 0x42, 0x50])
      )
  }
}

/** What a row holds of its picture now. */
interface HeldPicture {
  path: string | null
  sha256: string | null
  source: string | null
}

/**
 * The rule both pictures share. An import never replaces an upload, and an
 * upload replaces one only where `mayReplaceUpload` says so. The same
 * picture again uploads nothing, and only takes the new source. A new
 * one is normalised and uploaded by `storeImage`, which writes no row, and
 * then `write` records it.
 */
async function storePicture(
  store: PictureStore,
  options: {
    kind: ImageKind
    entityId: string
    held: HeldPicture
    picture: SentPicture
    /** Whether an upload may replace a picture somebody else uploaded. */
    mayReplaceUpload: boolean
    /**
     * Writes the row; when `guarded`, only where its picture is not an
     * upload. True when the row was written.
     */
    write: (
      stored: StoredImage | undefined,
      guarded: boolean
    ) => Promise<boolean>
  }
): Promise<StoredPicture> {
  const { kind, entityId, held, picture, write } = options
  if (!spaceConfigured(store.space)) {
    throw unavailable('No picture store is configured')
  }
  // Whether this picture may not replace an upload. Checked here, and again
  // by the write itself, so an upload that lands while this one is being
  // normalised and stored is not overwritten.
  const guarded = picture.source === 'import' || !options.mayReplaceUpload
  if (guarded && held.source === 'upload' && held.path != null) {
    return { stored: false, kept: 'upload' }
  }

  let stored: StoredImage | undefined
  try {
    stored = await storeImage({
      ffmpegPath: store.ffmpegPath,
      space: store.space,
      kind,
      entityId,
      source: picture.bytes,
      knownSha256: held.path == null ? null : held.sha256
    })
  } catch (error) {
    if (error instanceof UnreadableImage) {
      throw unsupportedMedia('That is not a picture TeamStation can read')
    }
    console.error('storing a %s picture for %s', kind, entityId, error)
    throw unavailable('The picture store did not answer')
  }

  if (stored == null) {
    // The picture already held. An upload of it still makes it the
    // person's own, so a later import leaves it alone.
    if (held.source !== picture.source) {
      if (!(await write(undefined, guarded))) {
        return { stored: false, kept: 'upload' }
      }
    }
    return { stored: false }
  }
  if (!(await write(stored, guarded))) {
    return { stored: false, kept: 'upload' }
  }
  const url = imageUrl(store.space, stored.pathPrefix, PROFILE_SIZE)
  // A configured Space always signs a URL; this only satisfies the type.
  if (url == null) throw unavailable('No picture store is configured')
  return { stored: true, url }
}

/** A team's logo, which is its administrators' to upload over. */
export async function storeTeamLogo(
  db: Kysely<Database>,
  store: PictureStore,
  teamId: string,
  picture: SentPicture
): Promise<StoredPicture> {
  const row = await db
    .selectFrom('teams')
    .select(['logo_path', 'logo_sha256', 'logo_source'])
    .where('id', '=', teamId)
    .executeTakeFirstOrThrow()
  return await storePicture(store, {
    kind: 'team',
    entityId: teamId,
    held: {
      path: row.logo_path,
      sha256: row.logo_sha256,
      source: row.logo_source
    },
    picture,
    mayReplaceUpload: true,
    write: async (stored, guarded) =>
      await atomic(db, async trx => {
        let update = trx
          .updateTable('teams')
          .set({
            ...(stored == null
              ? {}
              : { logo_path: stored.pathPrefix, logo_sha256: stored.sha256 }),
            logo_source: picture.source,
            picture_catalog_id: null,
            logo_updated_at: new Date()
          })
          .where('id', '=', teamId)
        if (guarded) {
          update = update.where(eb =>
            eb.or([
              eb('logo_source', 'is distinct from', 'upload'),
              eb('logo_path', 'is', null)
            ])
          )
        }
        const written = await update.executeTakeFirst()
        if (Number(written.numUpdatedRows) === 0) return false
        noteScopeChange(trx, { teamId })
        return true
      })
  })
}

/**
 * A player's headshot, which is their own picture on every team. One that
 * was uploaded is replaced only by a site administrator's upload: a team's
 * administrator cannot overwrite a face somebody chose, which may have come
 * from another team or the player's family.
 */
export async function storePlayerAvatar(
  db: Kysely<Database>,
  store: PictureStore,
  userId: string,
  picture: SentPicture,
  callerIsAdmin: boolean
): Promise<StoredPicture> {
  const row = await db
    .selectFrom('users')
    .select(['avatar_path', 'avatar_sha256', 'avatar_source'])
    .where('id', '=', userId)
    .executeTakeFirstOrThrow()
  return await storePicture(store, {
    kind: 'user',
    entityId: String(userId),
    held: {
      path: row.avatar_path,
      sha256: row.avatar_sha256,
      source: row.avatar_source
    },
    picture,
    mayReplaceUpload: callerIsAdmin,
    write: async (stored, guarded) => {
      let update = db
        .updateTable('users')
        .set({
          ...(stored == null
            ? {}
            : {
                avatar_path: stored.pathPrefix,
                avatar_sha256: stored.sha256
              }),
          avatar_source: picture.source,
          picture_catalog_id: null,
          avatar_updated_at: new Date()
        })
        .where('id', '=', userId)
      if (guarded) {
        update = update.where(eb =>
          eb.or([
            eb('avatar_source', 'is distinct from', 'upload'),
            eb('avatar_path', 'is', null)
          ])
        )
      }
      const written = await update.executeTakeFirst()
      return Number(written.numUpdatedRows) > 0
    }
  })
}
