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

import type { KeyPair } from '../../common/chatCrypto/hpke'
import type { DeviceKeys } from '../../common/chatCrypto/keys'
import { asUserId, type UserId, userIdOfGumbo } from '../../common/userId'

/**
 * What one device keeps of chat: its own two key pairs, the user's identity
 * key and per-user keys once it is linked, the identity keys it has pinned,
 * and the epoch keys it has opened.
 *
 * One record per device, for one user. The phones keep it in the Keychain
 * and Keystore (`keyStore.native.ts`), the browser in IndexedDB under a
 * wrapping key it cannot export (`keyStore.ts`). It is written here as JSON,
 * bytes in base64url, so the two twins store the very same thing and share
 * this module rather than import each other.
 */
export interface ChatKeyRecord {
  /** The user the keys belong to. A record for anybody else is wiped. */
  userId: UserId
  /** This device's id on the server (`cdv_…`). */
  deviceId: string
  device: DeviceKeys
  /** The user's identity, once this device enrolled, linked or reset. */
  identity: { id: string; keys: KeyPair } | undefined
  /** Every per-user key generation of that identity, oldest first. */
  puks: Array<{ generation: number; keys: KeyPair }>
  /** The link this device asked for and is waiting on, if any. */
  pendingLinkId: string | undefined
  /** Trust on first use: each user id's identity key as first seen (base64url). */
  pins: Record<string, string>
  /** Opened epoch keys: conversation id → epoch → key (base64url). */
  epochKeys: Record<string, Record<string, string>>
  /**
   * A pinned identity key that was replaced, by user id: what the person's
   * safety number was before it changed (base64url).
   */
  previousPins: Record<string, string>
  /** How far each chat's membership log is verified, by conversation id. */
  logs: Record<string, ChatLogHead>
}

/**
 * What this device has verified of one chat's membership log: the last
 * verified row and its hash, the members the verified rows leave (a `join`
 * with no later `leave`), and the identity resets they record. `broken`
 * once a row failed: the chat's membership cannot be trusted from then on.
 */
export interface ChatLogHead {
  seq: number
  /** base64url. */
  hash: string
  members: UserId[]
  resets: Array<{ userId: UserId; seq: number; at: number }>
  broken: boolean
}

/** Where a device keeps its record. */
export interface ChatKeyStore {
  /**
   * Only an absent record returns undefined. Unreadable keys must block
   * enrollment: a record that is there but cannot be read throws
   * `UnreadableKeyRecordError` and stays where it is.
   */
  load: () => Promise<ChatKeyRecord | undefined>
  save: (record: ChatKeyRecord) => Promise<void>
  /** Forgets every key this device holds. */
  wipe: () => Promise<void>
  /**
   * Whether a record is stored, answered without creating anything: signing
   * out where chat's crypto core is not asks this first.
   */
  exists: () => Promise<boolean>
}

export const b64 = (bytes: Uint8Array): string =>
  base64url.stringify(bytes, { pad: false })
export const unb64 = (text: string): Uint8Array =>
  base64url.parse(text, { loose: true })

const asKey32: Cleaner<string> = raw => {
  const text = asString(raw)
  if (!/^[A-Za-z0-9_-]{43}=?$/.test(text))
    throw new TypeError('Expected a saved 32-byte chat key')
  const bytes = unb64(text)
  if (bytes.length !== 32 || b64(bytes) !== text.replace(/=$/, ''))
    throw new TypeError('Expected a saved 32-byte chat key')
  return text
}

const asKeyPair = asObject({ secretKey: asKey32, publicKey: asKey32 })

const asLogHead = (asId: Cleaner<UserId>): Cleaner<ChatLogHead> =>
  asObject({
    seq: asNumber,
    hash: asKey32,
    members: asArray(asId),
    resets: asOptional(
      asArray(asObject({ userId: asId, seq: asNumber, at: asNumber })),
      []
    ),
    broken: asBoolean
  })

type StoredKeyPair = ReturnType<typeof asKeyPair>
type StoredRecord = Omit<ChatKeyRecord, 'device' | 'identity' | 'puks'> & {
  device: { box: StoredKeyPair; sign: StoredKeyPair }
  identity?: { id: string; keys: StoredKeyPair }
  puks: Array<{ generation: number; keys: StoredKeyPair }>
}

const asStoredRecord = (asId: Cleaner<UserId>): Cleaner<StoredRecord> =>
  asObject({
    userId: asId,
    deviceId: asString,
    device: asObject({ box: asKeyPair, sign: asKeyPair }),
    identity: asOptional(asObject({ id: asString, keys: asKeyPair })),
    puks: asArray(asObject({ generation: asNumber, keys: asKeyPair })),
    pendingLinkId: asOptional(asString),
    pins: asOptional(
      (raw: unknown) => asObject(asKey32)(raw) as Record<string, string>,
      {}
    ),
    epochKeys: asOptional(
      (raw: unknown) =>
        asObject(asObject(asKey32))(raw) as Record<
          string,
          Record<string, string>
        >,
      {}
    ),
    previousPins: asOptional(
      (raw: unknown) => asObject(asKey32)(raw) as Record<string, string>,
      {}
    ),
    logs: asOptional(
      (raw: unknown) =>
        asObject(asLogHead(asId))(raw) as Record<string, ChatLogHead>,
      {}
    )
  })

const pairOut = (pair: KeyPair): { secretKey: string; publicKey: string } => ({
  secretKey: b64(pair.secretKey),
  publicKey: b64(pair.publicKey)
})
const pairIn = (pair: { secretKey: string; publicKey: string }): KeyPair => ({
  secretKey: unb64(pair.secretKey),
  publicKey: unb64(pair.publicKey)
})

/** The record as the stores keep it. */
export function recordToJson(record: ChatKeyRecord): string {
  return JSON.stringify({
    version: 2,
    userId: record.userId,
    deviceId: record.deviceId,
    device: {
      box: pairOut(record.device.box),
      sign: pairOut(record.device.sign)
    },
    identity:
      record.identity == null
        ? undefined
        : { id: record.identity.id, keys: pairOut(record.identity.keys) },
    puks: record.puks.map(puk => ({
      generation: puk.generation,
      keys: pairOut(puk.keys)
    })),
    pendingLinkId: record.pendingLinkId,
    pins: record.pins,
    epochKeys: record.epochKeys,
    previousPins: record.previousPins,
    logs: record.logs
  })
}

const UNKNOWN_VERSION = 'Unknown chat key record version'

/** A stored record back. Anything malformed throws. */
export function recordFromJson(text: string): ChatKeyRecord {
  const parsed: unknown = JSON.parse(text)
  const { version } = asObject({ version: asNumber })(parsed)
  if (version !== 1 && version !== 2) throw new TypeError(UNKNOWN_VERSION)
  const asId: Cleaner<UserId> =
    version === 1 ? raw => userIdOfGumbo(asNumber(raw)) : asUserId
  const raw = asStoredRecord(asId)(parsed)
  const pins = (saved: Record<string, string>): Record<string, string> =>
    Object.fromEntries(
      Object.entries(saved).map(([id, key]) => {
        if (version === 1) {
          if (!/^[1-9][0-9]*$/.test(id))
            throw new TypeError('Invalid legacy pin owner')
          return [userIdOfGumbo(Number(id)), key]
        }
        return [asUserId(id), key]
      })
    )
  return {
    userId: raw.userId,
    deviceId: raw.deviceId,
    device: { box: pairIn(raw.device.box), sign: pairIn(raw.device.sign) },
    identity:
      raw.identity == null
        ? undefined
        : { id: raw.identity.id, keys: pairIn(raw.identity.keys) },
    puks: raw.puks
      .map(puk => ({ generation: puk.generation, keys: pairIn(puk.keys) }))
      .sort((a, b) => a.generation - b.generation),
    pendingLinkId: raw.pendingLinkId,
    pins: pins(raw.pins),
    epochKeys: raw.epochKeys,
    previousPins: pins(raw.previousPins),
    logs: raw.logs
  }
}

/** Why a record this device holds cannot be read. */
export type UnreadableKeyRecordReason =
  /** The browser's record is there and its wrapping key is not. */
  | 'wrappingKeyMissing'
  /** The sealed record does not open under the wrapping key. */
  | 'undecryptable'
  /** A record version this build does not know (a newer build's). */
  | 'unknownVersion'
  /** Not a record this build can parse. */
  | 'invalid'

const UNREADABLE: Record<UnreadableKeyRecordReason, string> = {
  wrappingKeyMissing: 'The saved chat wrapping key is missing',
  undecryptable: 'The saved chat keys could not be decrypted',
  unknownVersion: UNKNOWN_VERSION,
  invalid: 'The saved chat keys are not a record this app can read'
}

/**
 * A key record that is on this device and cannot be read. A store throws
 * it and keeps the record: it may be a newer build's, or readable again
 * later, and nothing but the person, through "Reset chat on this device",
 * has it removed. The message names the reason and never any of the
 * record's text.
 */
export class UnreadableKeyRecordError extends Error {
  readonly reason: UnreadableKeyRecordReason

  constructor(reason: UnreadableKeyRecordReason) {
    super(UNREADABLE[reason])
    this.name = 'UnreadableKeyRecordError'
    this.reason = reason
  }
}

/** `recordFromJson` for the record a store holds: unreadable, not malformed. */
export function storedRecordFromJson(text: string): ChatKeyRecord {
  try {
    return recordFromJson(text)
  } catch (error) {
    throw new UnreadableKeyRecordError(
      error instanceof TypeError && error.message === UNKNOWN_VERSION
        ? 'unknownVersion'
        : 'invalid'
    )
  }
}

/** A new device's record: its keys and nothing of the user's yet. */
export function newRecord(
  userId: UserId,
  deviceId: string,
  device: DeviceKeys
): ChatKeyRecord {
  return {
    userId,
    deviceId,
    device,
    identity: undefined,
    puks: [],
    pendingLinkId: undefined,
    pins: {},
    epochKeys: {},
    previousPins: {},
    logs: {}
  }
}

/** The latest per-user key generation this device holds. */
export function latestPuk(
  record: ChatKeyRecord
): { generation: number; keys: KeyPair } | undefined {
  return record.puks[record.puks.length - 1]
}

/**
 * Trust on first use. The first identity key seen for a user is pinned; a
 * later one that differs is reported as `changed`, so the screens can say
 * that the person's safety number changed, and is pinned in its place. The
 * key it replaced is kept in `previousPins`, for the approval prompt's old
 * safety number.
 */
export function pinIdentity(
  record: ChatKeyRecord,
  userId: UserId,
  identityKey: Uint8Array
): { record: ChatKeyRecord; seen: 'new' | 'same' | 'changed' } {
  const key = b64(identityKey)
  const pinned = record.pins[String(userId)]
  if (pinned === key) return { record, seen: 'same' }
  return {
    record: {
      ...record,
      pins: { ...record.pins, [String(userId)]: key },
      previousPins:
        pinned == null
          ? record.previousPins
          : { ...record.previousPins, [String(userId)]: pinned }
    },
    seen: pinned == null ? 'new' : 'changed'
  }
}

/** An epoch key this device has opened, if it has. */
export function epochKeyOf(
  record: ChatKeyRecord,
  conversationId: string,
  epoch: number
): Uint8Array | undefined {
  const key = record.epochKeys[conversationId]?.[String(epoch)]
  return key == null ? undefined : unb64(key)
}

/** The record with one more epoch key cached. */
export function withEpochKey(
  record: ChatKeyRecord,
  conversationId: string,
  epoch: number,
  key: Uint8Array
): ChatKeyRecord {
  return {
    ...record,
    epochKeys: {
      ...record.epochKeys,
      [conversationId]: {
        ...record.epochKeys[conversationId],
        [String(epoch)]: b64(key)
      }
    }
  }
}
