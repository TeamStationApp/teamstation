import type { ChatMessage } from '../../../common/api'
import {
  type AttachmentRef,
  type ChatContent,
  encodeContent,
  MAX_ATTACHMENT_SIZE
} from '../../../common/chatContent'
import { newMessageId } from '../../../common/chatCrypto/messageIds'
import { type EnvelopeKind, sealMessage } from '../../../common/chatCrypto/seal'
import {
  openAttachment,
  sealAttachment
} from '../../../common/chatCrypto/stream'
import { b64, epochKeyOf, unb64 } from '../keyRecord'
import { ChatEngineError, type EngineContext } from './context'
import { reasonOf } from './links'
import { epochForSend } from './rotate'
import { stateOf } from './sync'

/**
 * Sealing and posting: a message under the chat's current epoch (made
 * first by `rotate.ts` when one is due), and attachments sealed, sent up in
 * parts and checked by digest.
 */

/** Refusals that mean "read the chat's keys again, then try once more". */
const RETRY = new Set(['staleEpoch', 'locked', 'staleIdentity'])

/**
 * Seals `content` as one message of envelope `kind` and posts it. A post
 * refused because the epoch moved on, or the keys changed, is tried once
 * more after reading them again. Answers the stored envelope.
 */
export async function postContent(
  ctx: EngineContext,
  conversationId: string,
  kind: EnvelopeKind,
  content: ChatContent,
  options: { targetIds?: string[]; attachmentIds?: string[] } = {}
): Promise<ChatMessage> {
  const id = newMessageId()
  const plaintext = encodeContent(content)
  for (let attempt = 0; ; attempt++) {
    const epoch = await epochForSend(ctx, conversationId)
    const record = ctx.keys.record
    const identity = record.identity
    const epochKey = epochKeyOf(record, conversationId, epoch)
    if (identity == null || epochKey == null) {
      throw new ChatEngineError('notReady', 'This device is not linked')
    }
    const sealed = sealMessage({
      conversationId,
      epoch,
      messageId: id,
      senderUserId: ctx.userId,
      kind,
      epochKey,
      plaintext,
      identitySecretKey: identity.keys.secretKey
    })
    try {
      const stored = await ctx.client.postChatMessage(conversationId, {
        id,
        epoch,
        kind,
        senderIdentityId: identity.id,
        ...(options.targetIds == null ? {} : { targetIds: options.targetIds }),
        ...(options.attachmentIds == null
          ? {}
          : { attachmentIds: options.attachmentIds }),
        nonce: b64(sealed.nonce),
        ciphertext: b64(sealed.ciphertext),
        signature: b64(sealed.signature)
      })
      const state = await stateOf(ctx, conversationId)
      state.envelopes.set(stored.seq, stored)
      state.opened.set(stored.id, {
        status: 'ok',
        content,
        replacedIdentity: false
      })
      return stored
    } catch (error) {
      const reason = reasonOf(error)
      if (attempt > 0 || reason == null || !RETRY.has(reason)) throw error
      if (reason === 'staleIdentity') await ctx.refreshKeys()
    }
  }
}

/** A file to send, as the pickers hand it over. */
export interface OutgoingFile {
  bytes: Uint8Array
  contentType: string
  fileName: string
  width?: number
  height?: number
  durationMs?: number
}

/**
 * Seals a file under a key of its own, sends the blob up in the parts the
 * server asks for, and completes it. Answers the reference a message
 * carries (its key included).
 */
export async function uploadAttachment(
  ctx: EngineContext,
  conversationId: string,
  file: OutgoingFile
): Promise<AttachmentRef> {
  if (file.bytes.length > MAX_ATTACHMENT_SIZE) {
    throw new ChatEngineError('attachment', 'The file is too large')
  }
  const sealed = sealAttachment(file.bytes)
  const digest = b64(sealed.digest)
  let upload = await ctx.client.createChatAttachment({
    conversationId,
    size: sealed.blob.length,
    digest
  })
  for (let round = 0; round < 3 && !upload.completed; round++) {
    for (const index of upload.missing) {
      const start = index * upload.partSize
      await ctx.client.putChatAttachmentPart(
        upload.id,
        index,
        sealed.blob.slice(start, start + upload.partSize)
      )
    }
    try {
      upload = await ctx.client.completeChatAttachment(upload.id)
    } catch (error) {
      if (reasonOf(error) !== 'partsMissing') throw error
      upload = await ctx.client.chatAttachment(upload.id)
    }
  }
  if (!upload.completed) {
    throw new ChatEngineError('attachment', 'The upload did not complete')
  }
  return {
    id: upload.id,
    key: b64(sealed.key),
    digest,
    size: file.bytes.length,
    contentType: file.contentType,
    fileName: file.fileName,
    ...(file.width == null ? {} : { width: file.width }),
    ...(file.height == null ? {} : { height: file.height }),
    ...(file.durationMs == null ? {} : { durationMs: file.durationMs })
  }
}

/** Fetches a blob by URL. */
export type FetchBytes = (url: string) => Promise<Uint8Array>

export const fetchBytes: FetchBytes = async url => {
  const response = await fetch(url)
  if (!response.ok)
    throw new Error(`Fetching an attachment: ${response.status}`)
  return new Uint8Array(await response.arrayBuffer())
}

/** Fetches an attachment's blob, checks its digest, and opens it. */
export async function downloadAttachment(
  ctx: EngineContext,
  ref: AttachmentRef,
  fetchBlob: FetchBytes
): Promise<Uint8Array> {
  const found = await ctx.client.chatAttachment(ref.id)
  if (!found.completed || found.url == null) {
    throw new ChatEngineError('attachment', 'The attachment is not there')
  }
  const blob = await fetchBlob(found.url)
  try {
    return openAttachment(unb64(ref.key), blob, unb64(ref.digest))
  } catch {
    throw new ChatEngineError('attachment', 'The attachment does not open')
  }
}
