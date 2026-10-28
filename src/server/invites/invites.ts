import { randomBytes } from 'node:crypto'

import type { Kysely } from 'kysely'

import { badRequest, conflict, forbidden } from '../../common/errors'
import { makeId } from '../../common/ids'
import type { RequestTerms } from '../../common/notifications'
import type { AdminScopes } from '../access'
import type { Actor } from '../auth/sessions'
import { lockKeys } from '../db/advisoryLocks'
import { atomic } from '../db/atomic'
import type { Database } from '../db/database'
import {
  approvesSide,
  decideRelationshipRequest,
  relationshipSides,
  withdrawRelationshipRequest
} from '../groups/requests'
import { linkGuardian, type RelativeKind } from '../people/guardians'
import { addToScope } from './people'

/**
 * Invite codes: who may make one, what one is worth, and what redeeming does.
 *
 * An invite is scoped to a league, a season or a team, and may only be made by
 * somebody who administers that scope — which, because rights inherit
 * downwards, means a league admin can invite to any of its teams and a team
 * admin only to their own.
 *
 * Redeeming makes a plain **member** of that level, never an editor: a team
 * invite a member of the team, a season invite a member of the season, a
 * league invite a member of the league, the same kind of member at every
 * level, who reaches every team below it as a team member does
 * (`addToScope`). Somebody who already has stronger access — a coach, a
 * parent on the roster — keeps it: redeeming is a floor, not a setting.
 */

export type InviteScopeType = 'league' | 'season' | 'team'

export interface Invite {
  id: string
  code: string
  scopeType: InviteScopeType
  scopeId: string
  label: string | null
  maxUses: number | null
  uses: number
  expiresAt: Date | null
  revokedAt: Date | null
  createdAt: Date
  /** The one person it was made out to, or null for a link anybody may use. */
  forEmail: string | null
  requestId?: string | null
  /** Who made it, or null when nobody is recorded. */
  createdBy: string | null
  /**
   * The player whose guardian, or adult family member by `relativeKind`,
   * redeeming this makes somebody. Only the address it was made out to may
   * redeem it.
   */
  guardianOfUserId: string | null
  relativeKind: RelativeKind | null
}

/** Why an invite cannot be redeemed, or null when it can. */
export type InviteProblem = 'revoked' | 'expired' | 'exhausted'

const FIELDS = [
  'id',
  'code',
  'scope_type',
  'scope_id',
  'label',
  'max_uses',
  'uses',
  'expires_at',
  'revoked_at',
  'created_at',
  'for_email',
  'request_id',
  'created_by',
  'guardian_of_user_id',
  'relative_kind'
] as const

interface InviteFields {
  id: string
  code: string
  scope_type: InviteScopeType
  scope_id: string
  label: string | null
  max_uses: number | null
  uses: number
  expires_at: Date | string | null
  revoked_at: Date | string | null
  created_at: Date | string
  for_email: string | null
  request_id?: string | null
  created_by: string | null
  guardian_of_user_id: string | null
  relative_kind: RelativeKind | null
}

const asDate = (value: Date | string | null): Date | null =>
  value == null ? null : new Date(value)

function shape(row: InviteFields): Invite {
  return {
    id: row.id,
    code: row.code,
    scopeType: row.scope_type,
    scopeId: row.scope_id,
    label: row.label,
    maxUses: row.max_uses,
    uses: row.uses,
    expiresAt: asDate(row.expires_at),
    revokedAt: asDate(row.revoked_at),
    createdAt: asDate(row.created_at) ?? new Date(),
    forEmail: row.for_email,
    requestId: row.request_id ?? null,
    createdBy: row.created_by,
    guardianOfUserId: row.guardian_of_user_id,
    relativeKind: row.relative_kind
  }
}

/**
 * The alphabet a generated code is drawn from.
 *
 * No `0`, `O`, `1`, `l` or `I`: a code is read off one screen and typed into
 * another, often by somebody holding a phone in a car park, and the pairs that
 * look alike are the ones that come back as "the link doesn't work". An
 * administrator who wants `demo2026` types it in instead, which is why a
 * custom code is allowed at all.
 */
const ALPHABET = 'abcdefghjkmnpqrstuvwxyz23456789'
const GENERATED_LENGTH = 8

export function makeInviteCode(): string {
  const bytes = randomBytes(GENERATED_LENGTH)
  let code = ''
  for (const byte of bytes) code += ALPHABET[byte % ALPHABET.length]
  return code
}

/**
 * A code somebody typed, checked before it goes anywhere near the database.
 *
 * Kept to what survives a URL, an e-mail client's line wrapping and being read
 * aloud. The length floor is what stops a two-character code that anybody
 * could guess by trying every pair.
 */
const CODE_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{3,63}$/

export function cleanInviteCode(raw: string): string {
  const code = raw.trim()
  if (!CODE_PATTERN.test(code)) {
    throw badRequest(
      'A code is 4 to 64 letters, digits, dots, dashes or underscores'
    )
  }
  return code
}

/** Whether this person may make invites at all, which puts the panel on screen. */
export function mayInvite(scopes: AdminScopes): boolean {
  return (
    scopes.isAdmin ||
    scopes.leagueIds.size > 0 ||
    scopes.seasonIds.size > 0 ||
    scopes.teamIds.size > 0
  )
}

/** Whether this person administers one particular league, season or team. */
export function mayInviteTo(
  scopes: AdminScopes,
  scopeType: InviteScopeType,
  scopeId: string
): boolean {
  if (scopes.isAdmin) return true
  if (scopeType === 'league') return scopes.leagueIds.has(scopeId)
  if (scopeType === 'season') return scopes.seasonIds.has(scopeId)
  return scopes.teamIds.has(scopeId)
}

/** What the thing being invited to is called, or undefined if there is no such thing. */
export async function scopeName(
  db: Kysely<Database>,
  scopeType: InviteScopeType,
  scopeId: string
): Promise<string | undefined> {
  const table =
    scopeType === 'league'
      ? 'leagues'
      : scopeType === 'season'
        ? 'seasons'
        : 'teams'
  const row = await db
    .selectFrom(table)
    .select(['name'])
    .where('id', '=', scopeId)
    .executeTakeFirst()
  return row?.name
}

export async function findInviteByCode(
  db: Kysely<Database>,
  code: string
): Promise<Invite | undefined> {
  const wanted = code.trim().toLowerCase()
  if (wanted === '') return undefined
  const row = await db
    .selectFrom('invites')
    .select(FIELDS)
    .where(eb => eb.fn('lower', ['code']), '=', wanted)
    .executeTakeFirst()
  return row == null ? undefined : shape(row)
}

export async function findInviteById(
  db: Kysely<Database>,
  id: string
): Promise<Invite | undefined> {
  const row = await db
    .selectFrom('invites')
    .select(FIELDS)
    .where('id', '=', id)
    .executeTakeFirst()
  return row == null ? undefined : shape(row)
}

/** Why this invite is no good, or null when it is. */
export function inviteProblem(
  invite: Invite,
  now: Date = new Date()
): InviteProblem | null {
  if (invite.revokedAt != null) return 'revoked'
  if (invite.expiresAt != null && invite.expiresAt.getTime() <= now.getTime()) {
    return 'expired'
  }
  if (invite.maxUses != null && invite.uses >= invite.maxUses)
    return 'exhausted'
  return null
}

export interface NewInvite {
  scopeType: InviteScopeType
  scopeId: string
  /** Null for one that came across from PeerTube, where nobody is recorded. */
  createdBy: string | null
  code?: string
  label?: string
  maxUses?: number
  expiresAt?: Date
  source?: 'peertube' | 'manual'
  uses?: number
  createdAt?: Date
  /** Made out to one address, mailed to it, and good for one use. */
  forEmail?: string
  requestId?: string
  /** For a team invite that makes its redeemer a relative of this player. */
  guardianOf?: { userId: string; kind: RelativeKind }
}

export async function createInvite(
  db: Kysely<Database>,
  invite: NewInvite
): Promise<Invite> {
  const code =
    invite.code == null ? makeInviteCode() : cleanInviteCode(invite.code)
  const taken = await findInviteByCode(db, code)
  if (taken != null) throw conflict('That code is already in use')

  const row = {
    id: makeId('invite'),
    code,
    scope_type: invite.scopeType,
    scope_id: invite.scopeId,
    created_by: invite.createdBy,
    label: invite.label ?? null,
    max_uses: invite.maxUses ?? null,
    uses: invite.uses ?? 0,
    expires_at:
      invite.expiresAt ??
      (invite.forEmail == null
        ? null
        : new Date(
            (invite.createdAt ?? new Date()).getTime() + 7 * 24 * 3600 * 1000
          )),
    source: invite.source ?? 'manual',
    for_email: invite.forEmail ?? null,
    request_id: invite.requestId ?? null,
    guardian_of_user_id: invite.guardianOf?.userId ?? null,
    relative_kind: invite.guardianOf?.kind ?? null,
    ...(invite.createdAt == null ? {} : { created_at: invite.createdAt })
  }
  await db.insertInto('invites').values(row).execute()
  const made = await findInviteById(db, row.id)
  if (made == null) throw new Error('The invite was written but cannot be read')
  return made
}

/** Every invite for one scope, newest first. Revoked ones stay, greyed out. */
export async function listInvites(
  db: Kysely<Database>,
  scopeType: InviteScopeType,
  scopeId: string
): Promise<Invite[]> {
  const rows = await db
    .selectFrom('invites')
    .select(FIELDS)
    .where('scope_type', '=', scopeType)
    .where('scope_id', '=', scopeId)
    .orderBy('created_at', 'desc')
    .execute()
  return rows.map(row => shape(row as InviteFields))
}

/**
 * Stops an invite without deleting it.
 *
 * Deleting would take the redemptions with it, and "how did this person get
 * in" is a question that outlives the invite that answered it.
 */
export async function revokeInvite(
  db: Kysely<Database>,
  id: string,
  actor?: Actor
): Promise<void> {
  const invitation = await findInviteById(db, id)
  if (invitation?.requestId != null) {
    if (actor == null)
      throw forbidden('Sign in to withdraw a personal invitation')
    await withdrawRelationshipRequest(db, actor, invitation.requestId)
    return
  }
  await db
    .updateTable('invites')
    .set({ revoked_at: new Date() })
    .where('id', '=', id)
    .where('revoked_at', 'is', null)
    .execute()
}

/** Whether this person already has what the invite offers. */
export async function alreadyInScope(
  db: Kysely<Database>,
  invite: Invite,
  userId: string
): Promise<boolean> {
  if (invite.scopeType === 'team') {
    const row = await db
      .selectFrom('memberships')
      .select(['id'])
      .where('user_id', '=', userId)
      .where('team_id', '=', invite.scopeId)
      .executeTakeFirst()
    return row != null
  }
  if (invite.scopeType === 'season') {
    const row = await db
      .selectFrom('season_members')
      .select(['id'])
      .where('user_id', '=', userId)
      .where('season_id', '=', invite.scopeId)
      .executeTakeFirst()
    return row != null
  }
  const row = await db
    .selectFrom('league_members')
    .select(['id'])
    .where('user_id', '=', userId)
    .where('league_id', '=', invite.scopeId)
    .executeTakeFirst()
  return row != null
}

export interface Redemption {
  /** False when this person already had the access, which is not a failure. */
  granted: boolean
  scopeType: InviteScopeType
  scopeId: string
}

/**
 * Spends the invite for one person.
 *
 * A second redemption by the same person is not an error and does not count
 * against the uses — a link sits in a mailbox and gets opened twice, and
 * charging for that would exhaust an invite nobody used twice over. Somebody
 * who already belongs keeps the membership they have: this only ever adds one
 * that was missing.
 */
export async function redeemInvite(
  db: Kysely<Database>,
  invite: Invite,
  userId: string,
  options: { createdAccount?: boolean } = {}
): Promise<Redemption> {
  const problem = inviteProblem(invite)
  if (problem != null) throw badRequest(`That invite is ${problem}`)
  if (invite.guardianOfUserId != null) {
    await mustHoldInvitedAddress(db, invite, userId)
  }

  return await atomic(db, async trx => {
    await lockKeys(trx, [
      ...(invite.requestId == null
        ? []
        : ['creation:parent-graph', `request:${invite.requestId}`]),
      `invite:${invite.id}`
    ])
    await trx
      .selectFrom('invites')
      .select('id')
      .where('id', '=', invite.id)
      .forUpdate()
      .executeTakeFirst()
    const current = await findInviteById(trx, invite.id)
    if (current == null) throw badRequest('That invite is no longer available')
    const currentProblem = inviteProblem(current)
    if (currentProblem != null)
      throw badRequest(`That invite is ${currentProblem}`)
    let requestGrant: boolean | undefined
    if (current.requestId != null) {
      const request = await trx
        .selectFrom('group_requests')
        .selectAll()
        .where('id', '=', current.requestId)
        .executeTakeFirstOrThrow()
      const terms = request.terms as RequestTerms
      const personal = relationshipSides(terms).find(
        side => side.kind === 'user'
      )
      if (
        terms.kind !== 'person' ||
        personal == null ||
        !(await approvesSide(
          trx,
          { userId, isAdmin: false, scopes: [] },
          personal,
          request
        ))
      )
        throw forbidden('This invitation belongs to its named recipient')
      const decided = await decideRelationshipRequest(
        trx,
        { userId, isAdmin: false, scopes: [] },
        request.id,
        'accept'
      )
      if (decided.status !== 'accepted')
        return {
          granted: false,
          scopeType: invite.scopeType,
          scopeId: invite.scopeId
        }
      requestGrant = request.status !== 'accepted'
    }
    const recorded = await trx
      .insertInto('invite_redemptions')
      .values({
        id: makeId('inviteRedemption'),
        invite_id: invite.id,
        user_id: userId,
        created_account: options.createdAccount ?? false
      })
      .onConflict(oc => oc.columns(['invite_id', 'user_id']).doNothing())
      .returning(['id'])
      .executeTakeFirst()

    const granted =
      requestGrant ??
      (current.scopeType === 'team' && current.guardianOfUserId != null
        ? (
            await linkGuardian(
              trx,
              current.guardianOfUserId,
              userId,
              current.scopeId,
              current.createdBy,
              current.relativeKind ?? 'guardian'
            )
          ).created
        : (await addToScope(trx, current.scopeType, current.scopeId, userId))
            .added)

    if (recorded != null) {
      await trx
        .updateTable('invites')
        .set(eb => ({ uses: eb('uses', '+', 1) }))
        .where('id', '=', invite.id)
        .execute()
    }

    return { granted, scopeType: invite.scopeType, scopeId: invite.scopeId }
  })
}

/**
 * A guardian invite is good only for the address it was made out to.
 *
 * The redeemer must hold that address on `user_emails`, compared without
 * regard to case. An account made by signing in through the invite from
 * that address holds it, so a forwarded link opens nothing under any other
 * account, and is refused with reason `inviteForAnotherEmail`.
 */
async function mustHoldInvitedAddress(
  db: Kysely<Database>,
  invite: Invite,
  userId: string
): Promise<void> {
  const wanted = (invite.forEmail ?? '').trim().toLowerCase()
  const held =
    wanted === ''
      ? undefined
      : await db
          .selectFrom('user_emails')
          .select(['id'])
          .where('user_id', '=', userId)
          .where(eb => eb.fn('lower', ['email']), '=', wanted)
          .executeTakeFirst()
  if (held == null) {
    throw forbidden('This invitation was sent to another address', {
      reason: 'inviteForAnotherEmail'
    })
  }
}
