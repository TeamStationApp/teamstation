import { base64url } from 'rfc4648'

import {
  asAttachmentRef,
  type AttachmentRef,
  type ChatContent,
  encodeContent
} from './chatContent'
import { fromUtf8, utf8 } from './chatCrypto/bytes'
import { type MessageFields, openPreview, sealPreview } from './chatCrypto/seal'

export const MAX_THUMBNAIL_BYTES = 96 * 1024

export interface ChatLinkPreview {
  url: string
  title: string
  description: string
  siteName: string
  thumbnail?: AttachmentRef
}

export function isPreviewThumbnail(ref: AttachmentRef): boolean {
  return (
    ref.size > 0 &&
    ref.size <= MAX_THUMBNAIL_BYTES &&
    /^image\/(jpeg|png|webp)$/.test(ref.contentType) &&
    ref.width != null &&
    ref.width > 0 &&
    ref.width <= 480 &&
    ref.height != null &&
    ref.height > 0 &&
    ref.height <= 320
  )
}

/** The card without its image, or none when no text would remain on it. */
export function withoutThumbnail(
  preview: ChatLinkPreview
): ChatLinkPreview | undefined {
  const { url, title, description, siteName } = preview
  return title.trim() !== '' || description.trim() !== ''
    ? { url, title, description, siteName }
    : undefined
}

function text(value: unknown, max: number): string {
  if (typeof value !== 'string' || Array.from(value).length > max)
    throw new Error('Invalid preview text')
  return value
}

function readPreview(raw: ChatLinkPreview): ChatLinkPreview {
  const url = text(raw.url, 2048)
  const title = text(raw.title, 256)
  const description = text(raw.description, 512)
  const siteName = text(raw.siteName, 96)
  const thumbnail =
    raw.thumbnail == null ? undefined : asAttachmentRef(raw.thumbnail)
  if (
    !/^https?:\/\//i.test(url) ||
    (thumbnail != null && !isPreviewThumbnail(thumbnail)) ||
    (title.trim() === '' && description.trim() === '' && thumbnail == null)
  )
    throw new Error('Invalid link preview')
  return {
    url,
    title,
    description,
    siteName,
    ...(thumbnail == null ? {} : { thumbnail })
  }
}

export function contentWithPreview(
  content: ChatContent,
  preview: ChatLinkPreview,
  fields: MessageFields,
  epochKey: Uint8Array
): Uint8Array {
  const checked = JSON.parse(fromUtf8(encodeContent(content))) as ChatContent
  const box = sealPreview(
    fields,
    epochKey,
    utf8(JSON.stringify(readPreview(preview)))
  )
  return utf8(
    JSON.stringify({
      ...checked,
      sealedPreview: {
        version: 1,
        nonce: base64url.stringify(box.nonce, { pad: false }),
        ciphertext: base64url.stringify(box.ciphertext, { pad: false })
      }
    })
  )
}

/** A damaged optional card never prevents the original authenticated message from opening. */
export function previewFromContent(
  bytes: Uint8Array,
  fields: MessageFields,
  epochKey: Uint8Array
): ChatLinkPreview | undefined {
  try {
    const { sealedPreview: box } = JSON.parse(fromUtf8(bytes))
    if (
      box?.version !== 1 ||
      typeof box.nonce !== 'string' ||
      box.nonce.length !== 32 ||
      typeof box.ciphertext !== 'string' ||
      box.ciphertext.length > 48 * 1024
    )
      return
    const opened = openPreview(
      fields,
      epochKey,
      base64url.parse(box.nonce, { loose: true }),
      base64url.parse(box.ciphertext, { loose: true })
    )
    return readPreview(JSON.parse(fromUtf8(opened)))
  } catch {
    return undefined
  }
}
