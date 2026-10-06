import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString,
  type Cleaner
} from 'cleaners'
import { base64url } from 'rfc4648'

import { fromUtf8, utf8 } from './chatCrypto/bytes'
import { isMessageId } from './chatCrypto/messageIds'

/**
 * What is inside a chat message, once it is opened.
 *
 * Content is JSON, UTF-8, sealed by `chatCrypto/seal.ts`; the server never
 * sees any of it. These cleaners run on every message a device opens, so a
 * member's client that sends something malformed or oversized is refused by
 * every reader, not trusted by one.
 */

/** The longest body, in characters (Unicode code points). */
export const MAX_BODY = 8000
/** The most attachments one message holds. */
export const MAX_ATTACHMENTS = 10
/** The largest attachment, in bytes before encryption. */
export const MAX_ATTACHMENT_SIZE = 100 * 1024 * 1024
/** The longest reaction, in UTF-16 units: room for any emoji sequence. */
export const MAX_EMOJI = 64
/** The longest file name or content type. */
const MAX_LABEL = 255

export interface AttachmentRef {
  id: string
  /** The attachment's own key, base64url (32 bytes). */
  key: string
  /** SHA-256 of the encrypted blob, base64url. */
  digest: string
  /** Bytes before encryption. */
  size: number
  contentType: string
  fileName: string
  width?: number
  height?: number
  durationMs?: number
}

export interface ChatQuote {
  id: string
  authorId: number
  snippet: string
}

export type ChatContent =
  | {
      type: 'text'
      body: string
      mentions: number[]
      quote?: ChatQuote
      attachments: AttachmentRef[]
    }
  | { type: 'reaction'; targetId: string; emoji: string; remove: boolean }
  | { type: 'edit'; targetId: string; body: string; mentions: number[] }
  | { type: 'delete'; targetId: string }

const asWhole =
  (low: number, high: number): Cleaner<number> =>
  raw => {
    const value = asNumber(raw)
    if (!Number.isSafeInteger(value) || value < low || value > high) {
      throw new TypeError(`Expected a whole number from ${low} to ${high}`)
    }
    return value
  }

const asUserIdNumber = asWhole(1, Number.MAX_SAFE_INTEGER)

const asText =
  (most: number): Cleaner<string> =>
  raw => {
    const text = asString(raw)
    // Code points, so an emoji counts once, whatever its UTF-16 length.
    if (text.length > most && Array.from(text).length > most) {
      throw new TypeError(`Longer than ${most} characters`)
    }
    return text
  }

const asLabel: Cleaner<string> = raw => {
  const text = asString(raw)
  if (text === '' || text.length > MAX_LABEL) {
    throw new TypeError(`Expected 1 to ${MAX_LABEL} characters`)
  }
  return text
}

const asMessageIdText: Cleaner<string> = raw => {
  if (!isMessageId(raw)) throw new TypeError('Expected a message id')
  return raw
}

const asKey32: Cleaner<string> = raw => {
  const text = asString(raw)
  let bytes: Uint8Array
  try {
    bytes = base64url.parse(text, { loose: true })
  } catch {
    throw new TypeError('Expected base64url')
  }
  if (bytes.length !== 32) throw new TypeError('Expected 32 bytes')
  return text
}

const asMentions = asArray(asUserIdNumber)

const asAttachmentFields = asObject({
  id: asLabel,
  key: asKey32,
  digest: asKey32,
  size: asWhole(0, MAX_ATTACHMENT_SIZE),
  contentType: asLabel,
  fileName: asLabel,
  width: asOptional(asWhole(0, 100000)),
  height: asOptional(asWhole(0, 100000)),
  durationMs: asOptional(asWhole(0, Number.MAX_SAFE_INTEGER))
})

/** One attachment reference, with absent dimensions left out rather than undefined. */
export const asAttachmentRef: Cleaner<AttachmentRef> = raw => {
  const { width, height, durationMs, ...rest } = asAttachmentFields(raw)
  return {
    ...rest,
    ...(width == null ? {} : { width }),
    ...(height == null ? {} : { height }),
    ...(durationMs == null ? {} : { durationMs })
  }
}

const asAttachments: Cleaner<AttachmentRef[]> = raw => {
  const list = asArray(asAttachmentRef)(raw)
  if (list.length > MAX_ATTACHMENTS) {
    throw new TypeError(`More than ${MAX_ATTACHMENTS} attachments`)
  }
  return list
}

const asQuote: Cleaner<ChatQuote> = asObject({
  id: asMessageIdText,
  authorId: asUserIdNumber,
  snippet: asText(MAX_BODY)
})

const asEmoji: Cleaner<string> = raw => {
  const text = asString(raw)
  if (text === '' || text.length > MAX_EMOJI) {
    throw new TypeError('Expected an emoji')
  }
  return text
}

const asTextContent = asObject({
  type: asString,
  body: asText(MAX_BODY),
  mentions: asMentions,
  quote: asOptional(asQuote),
  attachments: asAttachments
})

const asReactionContent = asObject({
  type: asString,
  targetId: asMessageIdText,
  emoji: asEmoji,
  remove: asBoolean
})

const asEditContent = asObject({
  type: asString,
  targetId: asMessageIdText,
  body: asText(MAX_BODY),
  mentions: asMentions
})

const asDeleteContent = asObject({ type: asString, targetId: asMessageIdText })

/** One message's content. Anything else, or anything over a limit, throws. */
export const asChatContent: Cleaner<ChatContent> = raw => {
  const type = asObject({ type: asString })(raw).type
  switch (type) {
    case 'text': {
      const { body, mentions, quote, attachments } = asTextContent(raw)
      return quote == null
        ? { type, body, mentions, attachments }
        : { type, body, mentions, quote, attachments }
    }
    case 'reaction': {
      const { targetId, emoji, remove } = asReactionContent(raw)
      return { type, targetId, emoji, remove }
    }
    case 'edit': {
      const { targetId, body, mentions } = asEditContent(raw)
      return { type, targetId, body, mentions }
    }
    case 'delete':
      return { type, targetId: asDeleteContent(raw).targetId }
    default:
      throw new TypeError(`Unknown content type ${type}`)
  }
}

/** Content as the bytes `sealMessage` takes: checked, then UTF-8 JSON. */
export function encodeContent(content: ChatContent): Uint8Array {
  return utf8(JSON.stringify(asChatContent(content)))
}

/** The bytes `openMessage` returns, back to checked content. */
export function decodeContent(bytes: Uint8Array): ChatContent {
  return asChatContent(JSON.parse(fromUtf8(bytes)))
}
