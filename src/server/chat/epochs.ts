import { type Kysely, sql } from 'kysely'

import { verifyEpoch } from '../../common/chatCrypto/chain'
import { badRequest, conflict, forbidden, notFound } from '../../common/errors'
import type { ChatKind, Database } from '../db/database'
import { isEligible } from './audiences'
import { type ChatCaller, requireHolder } from './keys'
import { isApprover } from './listing'
import { notifyChat, openGrantRequests } from './membershipLog'
import { b64 } from './wire'

/**
 * Epochs and history grants.
 *
 * - **Epochs.** A member's linked device makes epoch n+1 with a fresh key,
 *   boxed (HPKE `epoch`) to every **eligible** member at their current PUK
 *   generation: a current member with a chat identity and no open,
 *   unsuperseded `identity_reset` request here. Any other box set is
 *   refused (`boxSet`). Epoch 1 may come from any eligible member. Epoch
 *   n+1 needs a creator who holds epoch n (a box for it under their current
 *   identity) and carries `previous_key_box`, epoch n's key under n+1's
 *   (`notHolder` otherwise). The creator's current identity signs it
 *   (`badSignature`). The first writer of n+1 wins (`epochTaken`).
 * - **Chain breaks.** When no current member holds epoch n under their
 *   current identity, any current member with an identity (a reset awaiting
 *   approval included) may make n+1 with no `previous_key_box`; it is
 *   recorded `chain_break`, boxed to every member with an identity, and it
 *   supersedes every grant request still open here, since nobody could
 *   fill them.
 * - A new epoch clears `needs_rotation`, fills the open requests of the
 *   members it boxes, and opens requests for the members it leaves out.
 * - **Grants.** A holder of the latest epoch boxes it (HPKE `grant`) to a
 *   member whose request is open. A request opened for a reset identity is
 *   filled only by an approver (`notApprover`).
 *
 * Every write takes the conversation's row `for update`, which serialises
 * it with the reconciler, the DM routes and every other epoch or grant.
 */

/** At most this many boxes in one `POST /chat/grants`. */
export const MAX_GRANTS = 500

export interface EpochBox {
  userId: string
  pukGeneration: number
  box: Uint8Array
}

export interface EpochBody {
  epoch: number
  previousKeyBox: Uint8Array | null
  signature: Uint8Array
  boxes: EpochBox[]
}

export interface GrantBox {
  conversationId: string
  epoch: number
  userId: string
  identityId: string
  pukGeneration: number
  box: Uint8Array
}

export interface EpochView {
  epoch: number
  createdByUserId: string
  identityId: string
  previousKeyBox: string | null
  chainBreak: boolean
  signature: string
  createdAt: string
}

export interface EpochBoxView {
  epoch: number
  identityId: string
  pukGeneration: number
  box: string
  grantedByUserId: string | null
}

export interface EpochsView {
  /** The latest epoch, 0 when there is none. */
  latest: number
  needsRotation: boolean
  /** No current member holds the latest epoch under their current identity. */
  noHolder: boolean
  /** The epochs after `after`, oldest first. */
  epochs: EpochView[]
  /** The caller's boxes, under their current identity, from epoch `after` on. */
  boxes: EpochBoxView[]
}

export interface GrantRequestView {
  id: number
  conversationId: string
  /** The epoch to box: the conversation's latest. */
  epoch: number
  userId: string
  identityId: string
  identityKey: string
  pukGeneration: number
  pukPublicKey: string
  pukSignature: string
  /** The identity replaced one this conversation had seen. */
  identityReset: boolean
  /**
   * The server takes the caller's box for it: approvers only, for a reset,
   * and never the requester themself for their own reset.
   */
  canApprove: boolean
  openedAt: string
}

export interface GrantSkip {
  conversationId: string
  userId: string
  identityId: string
  pukGeneration: number
  /** `notOpen`: filled, superseded, or the requester left; `staleEpoch`: a newer epoch exists. */
  reason: 'notOpen' | 'staleEpoch'
}

const iso = (at: Date | string): string => new Date(at).toISOString()

/** Where a current member with a chat identity stands on keys. */
interface Standing {
  userId: string
  identityId: string
  generation: number
  /** Not waiting for approval after an identity reset. */
  eligible: boolean
}

/** Every current member with a chat identity, by user id. */
async function standingsOf(
  db: Kysely<Database>,
  conversationId: string
): Promise<Map<string, Standing>> {
  const { rows } = await sql<{
    userId: string
    identityId: string
    generation: number
    waiting: boolean
  }>`
    select m.user_id as "userId", i.id as "identityId",
      max(k.generation)::int as generation,
      exists (
        select 1 from chat_grant_requests r
        where r.conversation_id = m.conversation_id and r.user_id = m.user_id
          and r.identity_id = i.id and r.identity_reset
          and r.filled_at is null and r.superseded_at is null
      ) as waiting
    from chat_members m
    join chat_identities i on i.user_id = m.user_id and i.replaced_at is null
    join chat_user_keys k on k.user_id = i.user_id and k.identity_id = i.id
    where m.conversation_id = ${conversationId} and m.left_at is null
    group by m.conversation_id, m.user_id, i.id
  `.execute(db)
  return new Map(
    rows.map(row => [
      row.userId,
      {
        userId: row.userId,
        identityId: row.identityId,
        generation: row.generation,
        eligible: !row.waiting
      }
    ])
  )
}

/** The latest epoch of a conversation, 0 when it has none. */
export async function latestEpoch(
  db: Kysely<Database>,
  conversationId: string
): Promise<number> {
  const row = await db
    .selectFrom('chat_epochs')
    .select(eb => eb.fn.max('epoch').as('epoch'))
    .where('conversation_id', '=', conversationId)
    .executeTakeFirst()
  return row?.epoch ?? 0
}

/** Current members holding `epoch` under their current identity. */
async function holdersOf(
  db: Kysely<Database>,
  conversationId: string,
  epoch: number
): Promise<Set<string>> {
  if (epoch < 1) return new Set()
  const { rows } = await sql<{ userId: string }>`
    select distinct b.user_id as "userId"
    from chat_epoch_boxes b
    join chat_identities i
      on i.id = b.identity_id and i.user_id = b.user_id
      and i.replaced_at is null
    join chat_members m
      on m.conversation_id = b.conversation_id and m.user_id = b.user_id
      and m.left_at is null
    where b.conversation_id = ${conversationId} and b.epoch = ${epoch}
  `.execute(db)
  return new Set(rows.map(row => row.userId))
}

/** The conversation's row, locked until the transaction ends; 404 when missing. */
export async function lockConversation(
  trx: Kysely<Database>,
  conversationId: string
): Promise<{
  id: string
  kind: ChatKind
  scope_id: string | null
  closed_at: Date | null
  needs_rotation: boolean
}> {
  const row = await trx
    .selectFrom('chat_conversations')
    .select(['id', 'kind', 'scope_id', 'closed_at', 'needs_rotation'])
    .where('id', '=', conversationId)
    .forUpdate()
    .executeTakeFirst()
  if (row == null) throw notFound()
  return row
}

async function isMember(
  db: Kysely<Database>,
  conversationId: string,
  userId: string
): Promise<boolean> {
  const row = await db
    .selectFrom('chat_members')
    .select(['user_id'])
    .where('conversation_id', '=', conversationId)
    .where('user_id', '=', userId)
    .where('left_at', 'is', null)
    .executeTakeFirst()
  return row != null
}

const refuse = (reason: string, message: string): Error =>
  forbidden(message, { reason })

/**
 * `GET /chat/conversations/:id/epochs?after=`: the epochs after `after`,
 * and the caller's boxes under their current identity (any generation of
 * it, since each generation carries the older ones) from epoch `after` on,
 * so a box granted for an epoch the device already knew still arrives.
 */
export async function epochsFor(
  db: Kysely<Database>,
  caller: ChatCaller,
  conversationId: string,
  after: number
): Promise<EpochsView> {
  const conversation = await db
    .selectFrom('chat_conversations')
    .select(['needs_rotation'])
    .where('id', '=', conversationId)
    .executeTakeFirstOrThrow()
  const latest = await latestEpoch(db, conversationId)
  const epochs = await db
    .selectFrom('chat_epochs')
    .selectAll()
    .where('conversation_id', '=', conversationId)
    .where('epoch', '>', after)
    .orderBy('epoch')
    .execute()
  const boxes = await db
    .selectFrom('chat_epoch_boxes')
    .innerJoin('chat_identities', join =>
      join
        .onRef('chat_identities.id', '=', 'chat_epoch_boxes.identity_id')
        .onRef('chat_identities.user_id', '=', 'chat_epoch_boxes.user_id')
    )
    .select([
      'chat_epoch_boxes.epoch',
      'chat_epoch_boxes.identity_id',
      'chat_epoch_boxes.generation',
      'chat_epoch_boxes.box',
      'chat_epoch_boxes.granted_by_user_id'
    ])
    .where('chat_epoch_boxes.conversation_id', '=', conversationId)
    .where('chat_epoch_boxes.user_id', '=', caller.userId)
    .where('chat_identities.replaced_at', 'is', null)
    .where('chat_epoch_boxes.epoch', '>=', after)
    .orderBy('chat_epoch_boxes.epoch')
    .orderBy('chat_epoch_boxes.generation')
    .execute()
  const holders = await holdersOf(db, conversationId, latest)
  return {
    latest,
    needsRotation: conversation.needs_rotation,
    noHolder: latest > 0 && holders.size === 0,
    epochs: epochs.map(row => ({
      epoch: row.epoch,
      createdByUserId: row.created_by_user_id,
      identityId: row.identity_id,
      previousKeyBox:
        row.previous_key_box == null ? null : b64(row.previous_key_box),
      chainBreak: row.chain_break,
      signature: b64(row.signature),
      createdAt: iso(row.created_at)
    })),
    boxes: boxes.map(row => ({
      epoch: row.epoch,
      identityId: row.identity_id,
      pukGeneration: row.generation,
      box: b64(row.box),
      grantedByUserId: row.granted_by_user_id
    }))
  }
}

/**
 * `POST /chat/conversations/:id/epochs`: epoch n+1, from a linked device of
 * a member, under the rules at the top of this file.
 */
export async function createEpoch(
  db: Kysely<Database>,
  caller: ChatCaller,
  conversationId: string,
  body: EpochBody,
  now: Date
): Promise<{
  epoch: number
  chainBreak: boolean
  boxed: number
  grantRequests: number
}> {
  return await db.transaction().execute(async trx => {
    const conversation = await lockConversation(trx, conversationId)
    if (!(await isMember(trx, conversationId, caller.userId))) {
      throw notFound()
    }
    if (conversation.closed_at != null) {
      throw conflict('This chat is closed', { reason: 'closed' })
    }
    const { keys } = await requireHolder(trx, caller)
    const latest = await latestEpoch(trx, conversationId)
    if (body.epoch <= latest) {
      throw conflict(`Epoch ${body.epoch} is taken; sync and try again`, {
        reason: 'epochTaken'
      })
    }
    if (body.epoch !== latest + 1) {
      throw badRequest(`The next epoch is ${latest + 1}`, {
        reason: 'epochGap'
      })
    }
    const standings = await standingsOf(trx, conversationId)
    const holders = await holdersOf(trx, conversationId, latest)
    const chainBreak = latest > 0 && holders.size === 0
    if (latest === 0) {
      if (body.previousKeyBox != null) {
        throw badRequest('The first epoch has no previous key', {
          reason: 'previousKeyBox'
        })
      }
      // Any member with an identity is eligible here: reset requests open
      // only where an epoch exists.
    } else if (
      chainBreak
        ? body.previousKeyBox != null
        : body.previousKeyBox == null || !holders.has(caller.userId)
    ) {
      throw refuse(
        'notHolder',
        `Only a holder of epoch ${latest} may make the next one`
      )
    }
    if (
      !verifyEpoch(
        {
          conversationId,
          epoch: body.epoch,
          previousKeyBox: body.previousKeyBox
        },
        body.signature,
        keys.identityKey
      )
    ) {
      throw badRequest('The epoch is not signed by your identity', {
        reason: 'badSignature'
      })
    }

    // Who must be boxed: the eligible members, or at a chain break
    // everybody with an identity.
    const expected = [...standings.values()].filter(
      standing => chainBreak || standing.eligible
    )
    const named = new Map(body.boxes.map(box => [box.userId, box]))
    if (
      named.size !== body.boxes.length ||
      named.size !== expected.length ||
      expected.some(
        standing =>
          named.get(standing.userId)?.pukGeneration !== standing.generation
      )
    ) {
      throw badRequest(
        'Box the key to exactly the eligible members at their current keys',
        { reason: 'boxSet' }
      )
    }

    if (chainBreak) {
      await trx
        .updateTable('chat_grant_requests')
        .set({ superseded_at: now })
        .where('conversation_id', '=', conversationId)
        .where('filled_at', 'is', null)
        .where('superseded_at', 'is', null)
        .execute()
    }
    await trx
      .insertInto('chat_epochs')
      .values({
        conversation_id: conversationId,
        epoch: body.epoch,
        created_by_user_id: caller.userId,
        identity_id: keys.identityId,
        previous_key_box: body.previousKeyBox,
        chain_break: chainBreak,
        signature: body.signature,
        created_at: now
      })
      .execute()
    if (expected.length > 0) {
      await trx
        .insertInto('chat_epoch_boxes')
        .values(
          expected.map(standing => ({
            conversation_id: conversationId,
            epoch: body.epoch,
            user_id: standing.userId,
            identity_id: standing.identityId,
            generation: standing.generation,
            box: named.get(standing.userId)!.box,
            granted_by_user_id: null,
            created_at: now
          }))
        )
        .execute()
      // The boxed now hold the latest key, which opens all they asked for.
      await sql`
        update chat_grant_requests r set filled_at = ${now}
        from unnest(
          ${expected.map(standing => standing.userId)}::text[],
          ${expected.map(standing => standing.identityId)}::text[],
          ${expected.map(standing => standing.generation)}::int[]
        ) as boxed (user_id, identity_id, generation)
        where r.conversation_id = ${conversationId}
          and r.user_id = boxed.user_id
          and r.identity_id = boxed.identity_id
          and r.generation = boxed.generation
          and r.filled_at is null and r.superseded_at is null
      `.execute(trx)
    }
    await trx
      .updateTable('chat_conversations')
      .set({ needs_rotation: false })
      .where('id', '=', conversationId)
      .execute()
    await notifyChat(trx, conversationId, 'epoch')
    // Left out: those awaiting approval after a reset. Their request stays
    // (or opens) as a reset request, for an approver.
    const leftOut = [...standings.values()]
      .filter(standing => !named.has(standing.userId))
      .map(standing => standing.userId)
    const grantRequests = await openGrantRequests(
      trx,
      conversationId,
      leftOut,
      true
    )
    return {
      epoch: body.epoch,
      chainBreak,
      boxed: expected.length,
      grantRequests
    }
  })
}

/**
 * `GET /chat/grants`: the open grant requests of current members in every
 * conversation the caller is in, oldest first, with what a holder needs to
 * box the latest epoch to them.
 */
export async function grantsFor(
  db: Kysely<Database>,
  caller: ChatCaller,
  now: Date
): Promise<GrantRequestView[]> {
  if (!(await isEligible(db, caller.userId, now))) return []
  const { rows } = await sql<{
    id: number
    conversationId: string
    kind: ChatKind
    scopeId: string | null
    epoch: number
    userId: string
    identityId: string
    identityKey: Uint8Array
    generation: number
    pukPublicKey: Uint8Array
    pukSignature: Uint8Array
    identityReset: boolean
    openedAt: Date
  }>`
    select r.id, r.conversation_id as "conversationId", c.kind,
      c.scope_id as "scopeId",
      (select max(e.epoch) from chat_epochs e
        where e.conversation_id = r.conversation_id) as epoch,
      r.user_id as "userId", r.identity_id as "identityId",
      i.identity_public_key as "identityKey", r.generation,
      k.public_key as "pukPublicKey", k.signature as "pukSignature",
      r.identity_reset as "identityReset", r.opened_at as "openedAt"
    from chat_members mine
    join chat_conversations c on c.id = mine.conversation_id
    join chat_grant_requests r on r.conversation_id = mine.conversation_id
    join chat_members theirs
      on theirs.conversation_id = r.conversation_id
      and theirs.user_id = r.user_id and theirs.left_at is null
    join chat_identities i
      on i.id = r.identity_id and i.user_id = r.user_id
      and i.replaced_at is null
    join chat_user_keys k
      on k.user_id = r.user_id and k.identity_id = r.identity_id
      and k.generation = r.generation
    where mine.user_id = ${caller.userId} and mine.left_at is null
      and r.filled_at is null and r.superseded_at is null
    order by r.opened_at, r.id
  `.execute(db)
  const approves = new Map<string, boolean>()
  const views: GrantRequestView[] = []
  for (const row of rows) {
    let canApprove = true
    if (row.identityReset && row.userId === caller.userId) {
      // Nobody approves their own history: a reset identity holds no key,
      // so only another member can open it for them.
      canApprove = false
    } else if (row.identityReset) {
      let approver = approves.get(row.conversationId)
      if (approver == null) {
        approver = await isApprover(
          db,
          { kind: row.kind, scope_id: row.scopeId },
          caller.userId
        )
        approves.set(row.conversationId, approver)
      }
      canApprove = approver
    }
    views.push({
      id: Number(row.id),
      conversationId: row.conversationId,
      epoch: row.epoch,
      userId: row.userId,
      identityId: row.identityId,
      identityKey: b64(row.identityKey),
      pukGeneration: row.generation,
      pukPublicKey: b64(row.pukPublicKey),
      pukSignature: b64(row.pukSignature),
      identityReset: row.identityReset,
      canApprove,
      openedAt: iso(row.openedAt)
    })
  }
  return views
}

/**
 * `POST /chat/grants`: up to 500 boxes of the latest epoch (HPKE `grant`),
 * each for an open request. In one transaction, every conversation named
 * is locked; the caller must be a member holding its latest epoch under
 * their current identity (`notHolder`), and an approver for a reset
 * identity (`notApprover`); a refusal refuses the whole batch. A box whose
 * request is no longer open, or that names an older epoch, is skipped and
 * reported. Each filled request is closed, with a `grant` hint per
 * conversation for its requester.
 */
export async function postGrants(
  db: Kysely<Database>,
  caller: ChatCaller,
  boxes: GrantBox[],
  now: Date
): Promise<{ filled: number; skipped: GrantSkip[] }> {
  return await db.transaction().execute(async trx => {
    const { keys } = await requireHolder(trx, caller)
    const ids = [...new Set(boxes.map(box => box.conversationId))].sort()
    const conversations = new Map<
      string,
      {
        kind: ChatKind
        scope_id: string | null
        latest: number
        holds: boolean
        approver: boolean | undefined
      }
    >()
    for (const id of ids) {
      const conversation = await lockConversation(trx, id)
      if (!(await isMember(trx, id, caller.userId))) throw notFound()
      const latest = await latestEpoch(trx, id)
      const held = await trx
        .selectFrom('chat_epoch_boxes')
        .select(['epoch'])
        .where('conversation_id', '=', id)
        .where('epoch', '=', latest)
        .where('user_id', '=', caller.userId)
        .where('identity_id', '=', keys.identityId)
        .executeTakeFirst()
      conversations.set(id, {
        kind: conversation.kind,
        scope_id: conversation.scope_id,
        latest,
        holds: held != null,
        approver: undefined
      })
    }

    const skipped: GrantSkip[] = []
    const touched = new Set<string>()
    let filled = 0
    for (const box of boxes) {
      const conversation = conversations.get(box.conversationId)
      if (conversation == null) throw notFound()
      const skip = (reason: GrantSkip['reason']): void => {
        skipped.push({
          conversationId: box.conversationId,
          userId: box.userId,
          identityId: box.identityId,
          pukGeneration: box.pukGeneration,
          reason
        })
      }
      if (box.epoch !== conversation.latest) {
        skip('staleEpoch')
        continue
      }
      if (!conversation.holds) {
        throw refuse(
          'notHolder',
          `You hold no key for epoch ${conversation.latest} here`
        )
      }
      const request = await trx
        .selectFrom('chat_grant_requests')
        .innerJoin('chat_members', join =>
          join
            .onRef(
              'chat_members.conversation_id',
              '=',
              'chat_grant_requests.conversation_id'
            )
            .onRef('chat_members.user_id', '=', 'chat_grant_requests.user_id')
        )
        .select([
          'chat_grant_requests.id',
          'chat_grant_requests.identity_reset'
        ])
        .where('chat_grant_requests.conversation_id', '=', box.conversationId)
        .where('chat_grant_requests.user_id', '=', box.userId)
        .where('chat_grant_requests.identity_id', '=', box.identityId)
        .where('chat_grant_requests.generation', '=', box.pukGeneration)
        .where('chat_grant_requests.filled_at', 'is', null)
        .where('chat_grant_requests.superseded_at', 'is', null)
        .where('chat_members.left_at', 'is', null)
        .executeTakeFirst()
      if (request == null) {
        skip('notOpen')
        continue
      }
      if (request.identity_reset && box.userId === caller.userId) {
        throw refuse(
          'notApprover',
          'Nobody approves history for their own reset identity'
        )
      }
      if (request.identity_reset) {
        conversation.approver ??= await isApprover(
          trx,
          conversation,
          caller.userId
        )
        if (!conversation.approver) {
          throw refuse(
            'notApprover',
            'Only an approver may open history for a reset identity'
          )
        }
      }
      await trx
        .insertInto('chat_epoch_boxes')
        .values({
          conversation_id: box.conversationId,
          epoch: box.epoch,
          user_id: box.userId,
          identity_id: box.identityId,
          generation: box.pukGeneration,
          box: box.box,
          granted_by_user_id: caller.userId,
          created_at: now
        })
        .onConflict(oc =>
          oc
            .columns([
              'conversation_id',
              'epoch',
              'user_id',
              'identity_id',
              'generation'
            ])
            .doNothing()
        )
        .execute()
      await trx
        .updateTable('chat_grant_requests')
        .set({ filled_at: now })
        .where('id', '=', request.id)
        .execute()
      filled += 1
      touched.add(box.conversationId)
    }
    for (const id of [...touched].sort()) {
      await notifyChat(trx, id, 'grant')
    }
    return { filled, skipped }
  })
}
