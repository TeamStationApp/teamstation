import type { TeamStationClient } from '../../../common/api'
import type { ChatKeyRecord, ChatKeyStore } from '../keyRecord'
import type { IdentityCache } from './decrypt'
import type { ChatKeysClient } from './links'
import type { ChatMemory } from './store'

/**
 * What every part of the engine shares: the API, who is signed in, the
 * device's key record, the identities fetched so far, and what the session
 * holds in memory.
 */

/** Every API call the engine makes. */
export type ChatEngineClient = ChatKeysClient &
  Pick<
    TeamStationClient,
    | 'chatConversations'
    | 'chatMembers'
    | 'chatReads'
    | 'chatLog'
    | 'chatUserKeys'
    | 'chatIdentity'
    | 'chatEpochs'
    | 'postChatEpoch'
    | 'chatGrants'
    | 'postChatGrants'
    | 'postChatMessage'
    | 'chatMessages'
    | 'markChatRead'
    | 'createChatAttachment'
    | 'putChatAttachmentPart'
    | 'completeChatAttachment'
    | 'chatAttachment'
    | 'reportChatMessage'
    | 'updateChatPreferences'
    | 'chatPins'
    | 'pinChatMessage'
  >

export type ChatEngineErrorCode =
  /** The device holds no key for the chat's latest epoch. */
  | 'locked'
  /** The chat's membership record failed to verify on this device. */
  | 'unverified'
  /** The server's box set names someone the verified record does not. */
  | 'unverifiedMember'
  /** A member's published keys do not check out. */
  | 'badKeys'
  /** The chat is closed, or the person may only read it. */
  | 'readOnly'
  /** The device is not linked yet (`start()` did not reach `ready`). */
  | 'notReady'
  /** No such message here, or not one this action applies to. */
  | 'target'
  /** The person is not in this chat (any more). */
  | 'notMember'
  /** The attachment could not be fetched or opened. */
  | 'attachment'

/** A refusal by the engine itself, before or instead of the server's. */
export class ChatEngineError extends Error {
  constructor(
    readonly code: ChatEngineErrorCode,
    message: string
  ) {
    super(message)
    this.name = 'ChatEngineError'
  }
}

/**
 * The device's key record, written through to its store. Every change goes
 * through `update`, one at a time, so two parts of the engine never write
 * over each other.
 */
export class KeyHolder {
  private queue: Promise<unknown> = Promise.resolve()

  constructor(
    private readonly store: ChatKeyStore,
    private current: ChatKeyRecord
  ) {}

  get record(): ChatKeyRecord {
    return this.current
  }

  /** Applies `change` to the latest record and saves it, if it changed. */
  async update(
    change: (record: ChatKeyRecord) => ChatKeyRecord
  ): Promise<ChatKeyRecord> {
    const run = this.queue.then(async () => {
      const next = change(this.current)
      if (next === this.current) return next
      await this.store.save(next)
      this.current = next
      return next
    })
    this.queue = run.catch(() => undefined)
    return await run
  }

  /** Takes a record somebody else saved (enrolment, a PUK sync). */
  async replace(load: () => Promise<ChatKeyRecord>): Promise<ChatKeyRecord> {
    const run = this.queue.then(async () => {
      this.current = await load()
      return this.current
    })
    this.queue = run.catch(() => undefined)
    return await run
  }
}

export interface EngineContext {
  client: ChatEngineClient
  /** The signed-in user. */
  userId: number
  memory: ChatMemory
  keys: KeyHolder
  identities: IdentityCache
  /** How many messages one request asks for. */
  pageSize: number
  /** Opens per-user key generations this device lacks (a PUK sync). */
  refreshKeys: () => Promise<void>
}
