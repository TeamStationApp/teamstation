import type { ChatMessage, ChatMessageEnvelope } from '../../../common/api'
import {
  type AttachmentRef,
  type ChatContent,
  encodeContent,
  MAX_ATTACHMENT_SIZE,
  MAX_CIPHERTEXT
} from '../../../common/chatContent'
import { newMessageId } from '../../../common/chatCrypto/messageIds'
import { type EnvelopeKind, sealMessage } from '../../../common/chatCrypto/seal'
import {
  openAttachment,
  sealAttachment
} from '../../../common/chatCrypto/stream'
import {
  type ChatLinkPreview,
  contentWithPreview
} from '../../../common/chatLinkPreview'
import { b64, epochKeyOf, unb64 } from '../keyRecord'
import {
  ChatEngineError,
  type EngineContext,
  uncertainDelivery
} from './context'
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

export interface PostAttempt {
  candidate?: { envelope: ChatMessageEnvelope; preview?: ChatLinkPreview }
}

interface PostOptions {
  targetIds?: string[]
  attachmentIds?: string[]
  preview?: ChatLinkPreview
}

async function preparePost(
  ctx: EngineContext,
  conversationId: string,
  kind: EnvelopeKind,
  content: ChatContent,
  options: PostOptions,
  id: string,
  preview?: ChatLinkPreview
): Promise<NonNullable<PostAttempt['candidate']>> {
  const plaintext = encodeContent(content)
  const epoch = await epochForSend(ctx, conversationId)
  const record = ctx.keys.record
  const identity = record.identity
  const epochKey = epochKeyOf(record, conversationId, epoch)
  if (identity == null || epochKey == null) {
    throw new ChatEngineError('notReady', 'This device is not linked')
  }
  const fields = {
    conversationId,
    epoch,
    messageId: id,
    senderUserId: ctx.userId,
    kind,
    epochKey,
    identitySecretKey: identity.keys.secretKey
  }
  let sealed = sealMessage({
    ...fields,
    plaintext:
      preview == null
        ? plaintext
        : contentWithPreview(content, preview, fields, epochKey)
  })
  if (preview != null && sealed.ciphertext.length > MAX_CIPHERTEXT) {
    preview = undefined
    sealed = sealMessage({ ...fields, plaintext })
  }
  const envelope: ChatMessageEnvelope = {
    id,
    epoch,
    kind,
    senderIdentityId: identity.id,
    ...(options.targetIds == null ? {} : { targetIds: options.targetIds }),
    ...(options.attachmentIds == null
      ? {}
      : { attachmentIds: options.attachmentIds }),
    ...(preview?.thumbnail == null
      ? {}
      : { previewAttachmentId: preview.thumbnail.id }),
    nonce: b64(sealed.nonce),
    ciphertext: b64(sealed.ciphertext),
    signature: b64(sealed.signature)
  }
  return { envelope, preview }
}

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
  options: PostOptions = {},
  attempt: PostAttempt = {}
): Promise<ChatMessage> {
  const id = attempt.candidate?.envelope.id ?? newMessageId()
  let preview = options.preview
  let retryEpoch = true
  for (;;) {
    const candidate =
      attempt.candidate ??
      (await preparePost(
        ctx,
        conversationId,
        kind,
        content,
        options,
        id,
        preview
      ))
    const { envelope } = candidate
    preview = candidate.preview
    attempt.candidate = candidate
    try {
      const post = async (): Promise<ChatMessage> =>
        await ctx.client.postChatMessage(conversationId, envelope)
      const stored = await post().catch(async (error: unknown) => {
        // The server may already have stored this ID. Replay the same signed
        // bytes once to retrieve it before attempting any other recovery.
        if (options.preview == null || !uncertainDelivery(error)) throw error
        return await post()
      })
      const state = await stateOf(ctx, conversationId)
      state.envelopes.set(stored.seq, stored)
      state.opened.set(stored.id, {
        status: 'ok',
        content,
        ...(preview == null ? {} : { preview }),
        replacedIdentity: false
      })
      return stored
    } catch (error) {
      if (uncertainDelivery(error)) throw error
      delete attempt.candidate
      const reason = reasonOf(error)
      if (reason === 'attachment' && preview?.thumbnail != null) {
        const { url, title, siteName, description } = preview
        preview =
          title.trim() !== '' || description.trim() !== ''
            ? { url, title, siteName, description }
            : undefined
        continue
      }
      if (!retryEpoch || reason == null || !RETRY.has(reason)) throw error
      retryEpoch = false
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
