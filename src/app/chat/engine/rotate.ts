import type { ChatMember } from '../../../common/api'
import {
  sealPreviousEpochKey,
  signEpoch,
  verifyPuk
} from '../../../common/chatCrypto/chain'
import { epochAad, hpkeSeal } from '../../../common/chatCrypto/hpke'
import { newEpochKey } from '../../../common/chatCrypto/keys'
import { b64, epochKeyOf, unb64, withEpochKey } from '../keyRecord'
import { ChatEngineError, type EngineContext } from './context'
import { pinCurrent } from './decrypt'
import { reasonOf } from './links'
import { syncLog } from './log'
import type { ConversationState } from './store'
import { holdsLatest, syncEpochs, syncMembers } from './sync'

/**
 * Making a chat's next epoch, before a send that needs one.
 *
 * - No epoch yet: epoch 1, boxed to the eligible members.
 * - `needs_rotation` (someone left, a device was revoked, an identity was
 *   reset): epoch n+1, carrying epoch n's key, boxed to the eligible
 *   members, so whoever left cannot open it.
 * - Nobody holds the latest key (`noHolder`): a chain break, boxed to every
 *   member with an identity, a reset awaiting approval included; what came
 *   before stays locked for good.
 *
 * The box set is the server's rule intersected with the members the
 * verified membership log leaves. If the server names somebody outside it,
 * or the log is broken, this device makes no epoch; a send then goes under
 * the current epoch when it holds one.
 */

type Mode = 'first' | 'chained' | 'chainBreak'

/** A member's current per-user key, checked against their identity. */
interface Recipient {
  userId: string
  identityId: string
  generation: number
  publicKey: Uint8Array
}

async function recipientOf(
  ctx: EngineContext,
  member: ChatMember
): Promise<Recipient> {
  const keys = await ctx.client.chatUserKeys(member.userId)
  const identity = keys.identity
  const puk = keys.puk
  if (
    identity == null ||
    puk == null ||
    (member.identityKey != null && identity.publicKey !== member.identityKey) ||
    !verifyPuk(
      {
        userId: member.userId,
        generation: puk.generation,
        publicKey: unb64(puk.publicKey)
      },
      unb64(puk.signature),
      unb64(identity.publicKey)
    )
  ) {
    throw new ChatEngineError(
      'badKeys',
      `The keys published for user ${member.userId} do not check out`
    )
  }
  await pinCurrent(ctx, member.userId, identity.publicKey)
  return {
    userId: member.userId,
    identityId: identity.id,
    generation: puk.generation,
    publicKey: unb64(puk.publicKey)
  }
}

/** Makes epoch `state.latest + 1`. Answers the epoch to send under. */
async function makeEpoch(
  ctx: EngineContext,
  state: ConversationState,
  mode: Mode
): Promise<number> {
  const conversationId = state.summary.id
  const identity = ctx.keys.record.identity
  if (identity == null) {
    throw new ChatEngineError('notReady', 'This device is not linked')
  }
  const head = await syncLog(ctx, conversationId)
  if (head.broken) {
    throw new ChatEngineError(
      'unverified',
      'Membership record could not be verified'
    )
  }
  const verified = new Set(head.members)
  const members = (await syncMembers(ctx, conversationId)).members ?? []
  const chosen = members.filter(member =>
    mode === 'chainBreak' ? member.hasIdentity : member.eligible
  )
  const stranger = chosen.find(member => !verified.has(member.userId))
  if (stranger != null) {
    throw new ChatEngineError(
      'unverifiedMember',
      `User ${stranger.userId} is not in the verified membership record`
    )
  }
  const recipients: Recipient[] = []
  for (const member of chosen) recipients.push(await recipientOf(ctx, member))

  const epoch = state.latest + 1
  const key = newEpochKey()
  const previous =
    mode === 'chained'
      ? epochKeyOf(ctx.keys.record, conversationId, state.latest)
      : undefined
  const previousKeyBox =
    previous == null
      ? null
      : sealPreviousEpochKey({
          conversationId,
          epoch,
          epochKey: key,
          previousEpochKey: previous
        })
  try {
    await ctx.client.postChatEpoch(conversationId, {
      epoch,
      previousKeyBox: previousKeyBox == null ? null : b64(previousKeyBox),
      signature: b64(
        signEpoch(
          { conversationId, epoch, previousKeyBox },
          identity.keys.secretKey
        )
      ),
      boxes: recipients.map(recipient => ({
        userId: recipient.userId,
        pukGeneration: recipient.generation,
        box: b64(
          hpkeSeal(
            'epoch',
            recipient.publicKey,
            epochAad({
              conversationId,
              epoch,
              recipientUserId: recipient.userId,
              identityId: recipient.identityId,
              generation: recipient.generation
            }),
            key
          )
        )
      }))
    })
  } catch (error) {
    if (reasonOf(error) !== 'epochTaken') throw error
    // Another device made it first: take theirs, if it boxed this one.
    const now = await syncEpochs(ctx, conversationId)
    if (!holdsLatest(ctx, now)) {
      throw new ChatEngineError('locked', 'History is locked')
    }
    return now.latest
  }
  await ctx.keys.update(record =>
    withEpochKey(record, conversationId, epoch, key)
  )
  await syncEpochs(ctx, conversationId)
  return epoch
}

/** Whether a refusal means "this device makes no epoch here". */
const declines = (error: unknown): boolean =>
  error instanceof ChatEngineError &&
  (error.code === 'unverified' ||
    error.code === 'unverifiedMember' ||
    error.code === 'badKeys')

/**
 * The epoch to send under now, making the next one first when the chat has
 * none, needs a rotation, or has no holder left. Throws `locked` when this
 * device holds no key for the latest epoch and somebody else does.
 */
export async function epochForSend(
  ctx: EngineContext,
  conversationId: string
): Promise<number> {
  const state = await syncEpochs(ctx, conversationId)
  if (state.summary.closed) {
    throw new ChatEngineError('readOnly', 'This chat is closed')
  }
  if (state.latest === 0) return await makeEpoch(ctx, state, 'first')
  if (!holdsLatest(ctx, state)) {
    if (state.noHolder) return await makeEpoch(ctx, state, 'chainBreak')
    throw new ChatEngineError('locked', 'History is locked')
  }
  if (!state.needsRotation) return state.latest
  try {
    return await makeEpoch(ctx, state, 'chained')
  } catch (error) {
    if (declines(error)) return state.latest
    throw error
  }
}
