import {
  asArray,
  asBoolean,
  asNumber,
  asObject,
  asOptional,
  asString
} from 'cleaners'

import { asLiteral } from '../../common/asLiteral'
import { isIdentityId } from '../../common/chatCrypto/messageIds'
import { asChatBoxCursor } from '../../common/chatHistory'
import { asUserId } from '../../common/userId'
import { asBase64urlBytes } from './wire'

export const asEpochMode = asOptional(asLiteral('continue', 'fresh'))

export function asRecoveryLimit(raw: unknown): number {
  const value =
    typeof raw === 'string' && /^[1-9][0-9]*$/.test(raw) ? Number(raw) : raw
  const n = asNumber(value)
  if (!Number.isSafeInteger(n) || n < 1 || n > 100)
    throw new TypeError('Expected limit from 1 to 100')
  return n
}

export function historyQuery(
  query: Record<string, unknown>
): { cursor: string; limit: number } | undefined {
  if (query.scope == null) {
    if (query.cursor != null || query.limit != null)
      throw new TypeError('cursor and limit require scope=history')
    return undefined
  }
  if (query.scope !== 'history') throw new TypeError('Expected scope=history')
  return {
    cursor: asChatBoxCursor(query.cursor ?? '0'),
    limit: asRecoveryLimit(query.limit ?? 100)
  }
}

export function boxDeliveryQuery(
  query: Record<string, unknown>
): { boxesAfter: string; boxLimit: number } | undefined {
  if (query.boxesAfter == null) {
    if (query.boxLimit != null)
      throw new TypeError('boxLimit requires boxesAfter')
    return undefined
  }
  return {
    boxesAfter: asChatBoxCursor(query.boxesAfter),
    boxLimit: asRecoveryLimit(query.boxLimit ?? 100)
  }
}

function asPositiveEpoch(raw: unknown): number {
  const n = asNumber(raw)
  if (!Number.isInteger(n) || n < 1 || n > 2147483647)
    throw new TypeError('Expected an epoch')
  return n
}

const asBoxes = asArray(
  asObject({
    requestId: asChatBoxCursor,
    conversationId: (raw: unknown): string => {
      const id = asString(raw)
      if (id.length === 0 || id.length > 100)
        throw new TypeError('Expected a conversation id')
      return id
    },
    targetEpoch: asPositiveEpoch,
    epoch: asPositiveEpoch,
    userId: asUserId,
    identityId: (raw: unknown): string => {
      if (!isIdentityId(raw)) throw new TypeError('Expected an identity id')
      return raw
    },
    pukGeneration: (raw: unknown): number => {
      const n = asPositiveEpoch(raw)
      if (n > 1000000) throw new TypeError('Expected a PUK generation')
      return n
    },
    box: asBase64urlBytes(48, 4096),
    approveHistory: asOptional(asBoolean, false)
  })
)
export const asHistoryGrantsBody = asObject({
  boxes: (raw: unknown) => {
    const boxes = asBoxes(raw)
    if (boxes.length === 0 || boxes.length > 100)
      throw new TypeError('Expected 1 to 100 historical boxes')
    return boxes
  }
})
