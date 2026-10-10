import { asArray, asBoolean, asObject, asString } from 'cleaners'

import { asLiteral } from './asLiteral'
import type { GameRequestTerms } from './gameApprovals'
import type { GroupRef } from './groupCreation'
import type { ParentAction, ParentPreview } from './groupLinks'
import type { RoleFlag } from './roles'

/** Who is asked to be a guardian: an account, or an address. */
export type GuardianInput = { userId: number } | { email: string }

/**
 * The body of `POST /relationship-requests`. A guardian invitation comes from
 * a team its sender coaches; a guardian request, which a person sends for
 * themselves, has no sender.
 */
export type RelationshipRequestInput =
  | GroupRequestInput
  | {
      kind: 'guardian'
      playerUserId: number
      guardian: GuardianInput
      sender?: { kind: 'team'; id: string }
      idempotencyKey: string
    }

type GroupRequestInput = {
  sender: GroupRef
  confirmBoth?: boolean
  idempotencyKey: string
} & (
  | {
      kind: 'parent'
      actions: ParentAction[]
      expected?: Record<string, string>
    }
  | { kind: 'participation'; teamId: string; seasonId: string }
  | {
      kind: 'person'
      recipientEmail: string
      admin: boolean
      flags: RoleFlag[]
    }
  | ({ kind: 'promotion'; teamId: string } & (
      | { recipientUserId: number; recipientEmail?: never }
      | { recipientEmail: string; recipientUserId?: never }
    ))
)

export type RequestTerms =
  | GameRequestTerms
  | { kind: 'parent'; preview: ParentPreview }
  | {
      kind: 'participation'
      seasonId: string
      teamId: string
      range: {
        startsOn: string | null
        endsOn: string | null
        timezone: string
      }
    }
  | { kind: 'promotion'; teamId: string; recipientUserId: number }
  | {
      kind: 'person'
      scope: GroupRef
      recipientEmail: string
      recipientUserId: number | null
      admin: boolean
      flags: RoleFlag[]
    }
  | GuardianTerms

/**
 * The guardian is an account, with the address it was invited by when it was
 * invited by one, or an address no account has verified yet, bound to the
 * account that accepts.
 */
export interface GuardianTerms {
  kind: 'guardian'
  playerUserId: number
  guardian: { userId: number; email?: string } | { email: string }
}

export interface RelationshipInvitation {
  /** Absent only for a guardian request, which a person sends for themselves. */
  sender?: GroupRef
  terms: RequestTerms
  confirmBoth?: boolean
  idempotencyKey: string
}
export const asNotification = asObject({
  id: asString,
  requestId: asString,
  type: asString,
  title: asString,
  description: asString,
  sentAt: asString,
  expiresAt: asString,
  status: asLiteral(
    'pending',
    'accepted',
    'declined',
    'expired',
    'cancelled',
    'superseded'
  ),
  canAct: asBoolean,
  canWithdraw: asBoolean,
  canResend: asBoolean,
  viewed: asBoolean
})
export type Notification = ReturnType<typeof asNotification>
export const asNotificationPage = asObject({
  items: asArray(asNotification),
  hasPending: asBoolean,
  nextCursor: (raw: unknown): string | null =>
    raw == null ? null : asString(raw)
})
