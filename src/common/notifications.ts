import { asArray, asBoolean, asObject, asString } from 'cleaners'

import { asLiteral } from './asLiteral'
import type { GameRequestTerms } from './gameApprovals'
import type { GroupRef } from './groupCreation'
import type { ParentAction, ParentPreview } from './groupLinks'
import type { RoleFlag } from './roles'

export type RelationshipRequestInput = {
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

export interface RelationshipInvitation {
  sender: GroupRef
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
