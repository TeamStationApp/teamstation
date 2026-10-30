import {
  asArray,
  asBoolean,
  asEither,
  asNull,
  asObject,
  asOptional,
  asString
} from 'cleaners'

import { asLiteral } from './asLiteral'
import type { GameRequestTerms } from './gameApprovals'
import type { GroupRef } from './groupCreation'
import type { ParentAction, ParentPreview } from './groupLinks'
import type { RoleFlag } from './roles'

/** Who is asked to be a guardian: an account, or an address. */
export type GuardianInput = { userId: string } | { email: string }

/**
 * The body of `POST /relationship-requests`. A guardian invitation comes from
 * a team its sender coaches; a guardian or membership request, which a person sends for
 * themselves, has no sender.
 */
export type RelationshipRequestInput =
  | GroupRequestInput
  | { kind: 'membership'; teamId: string; idempotencyKey: string }
  | {
      kind: 'guardian'
      playerUserId: string
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
      | { recipientUserId: string; recipientEmail?: never }
      | { recipientEmail: string; recipientUserId?: never }
    ))
)

export type RequestTerms =
  | GameRequestTerms
  | { kind: 'membership'; teamId: string; userId: string }
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
  | { kind: 'promotion'; teamId: string; recipientUserId: string }
  | {
      kind: 'person'
      scope: GroupRef
      recipientEmail: string
      recipientUserId: string | null
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
  playerUserId: string
  guardian: { userId: string; email?: string } | { email: string }
}

export interface RelationshipInvitation {
  /** Absent for a guardian or membership request sent on one’s own behalf. */
  sender?: GroupRef
  terms: RequestTerms
  confirmBoth?: boolean
  idempotencyKey: string
}
/**
 * The notification source type of a reminder to upload a phone's recording of
 * one camera angle. One per stream, to the stream's owner only.
 */
export const RECORDING_UPLOAD = 'recordingUpload'
export const CHAT_DEVICE_APPROVAL = 'chatDeviceApproval'

/**
 * The Auto-Scheduler's notices: claims on a venue, a game's field warnings
 * and the league's schedule. Each lights the bell until it is opened, and
 * names what it opens.
 */
export const SCHEDULING_NEWS = [
  'venueClaim',
  'venueOwnerRequest',
  'venueClaimDecided',
  'fieldWarning',
  'scheduleNeedsAttention',
  'schedulePublished'
] as const
export type SchedulingNews = (typeof SCHEDULING_NEWS)[number]
export function isSchedulingNews(type: string): type is SchedulingNews {
  return (SCHEDULING_NEWS as readonly string[]).includes(type)
}

const cleanNotification = asObject({
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
  viewed: asBoolean,
  /**
   * On a notification that somebody added you to a team, season or league
   * (`type` `grant`): that level, while you are still in it, so you can
   * leave it from here. Null once you have left, and on every other kind.
   */
  leave: asOptional(
    asEither(
      asNull,
      asObject({
        kind: asLiteral('league', 'season', 'team'),
        id: asString,
        name: asString
      })
    ),
    null
  ),
  /** On a `recordingUpload` reminder: the game and the angle's stream. */
  gameId: asOptional(asString),
  liveStreamId: asOptional(asString),
  /** On a scheduling notice: what it opens. */
  venueId: asOptional(asString),
  leagueId: asOptional(asString),
  seasonId: asOptional(asString),
  teamId: asOptional(asString)
})
type Cleaned = ReturnType<typeof cleanNotification>
export type Notification = Omit<
  Cleaned,
  | 'leave'
  | 'gameId'
  | 'liveStreamId'
  | 'venueId'
  | 'leagueId'
  | 'seasonId'
  | 'teamId'
> & {
  leave?: Cleaned['leave']
  gameId?: string
  liveStreamId?: string
  venueId?: string
  leagueId?: string
  seasonId?: string
  teamId?: string
}
export const asNotification: (raw: unknown) => Notification = cleanNotification
export const asNotificationPage = asObject({
  items: asArray(asNotification),
  hasPending: asBoolean,
  nextCursor: (raw: unknown): string | null =>
    raw == null ? null : asString(raw)
})
