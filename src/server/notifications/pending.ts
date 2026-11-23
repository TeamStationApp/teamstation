import type { ExpressionBuilder, ExpressionWrapper, SqlBool } from 'kysely'

import {
  CHAT_DEVICE_APPROVAL,
  LOCAL_COPY_EXPIRING,
  RECORDING_UPLOAD
} from '../../common/notifications'
import type { Database } from '../db/database'

/** The notice a team's roster managers get when a player's side rejected an add. */
export const PLAYER_ADD_REJECTED = 'playerAddRejected'

/**
 * The information that waits on this person, Pending and lighting the bell:
 * a device of theirs asking to be approved, unanswered and unexpired, and an
 * upload reminder or a rejected add they have not dismissed. A grant or a
 * scheduling notice is History from the moment it is recorded. The inbox
 * lists these and the badge asks whether any is there, by this one clause.
 */
export function pendingInformationWhere(
  eb: ExpressionBuilder<Database, 'notification_events'>,
  userId: string,
  now: Date
): ExpressionWrapper<Database, 'notification_events', SqlBool> {
  return eb.or([
    eb.and([
      eb('source_type', '=', CHAT_DEVICE_APPROVAL),
      eb.exists(
        eb
          .selectFrom('chat_links')
          .innerJoin(
            'chat_devices',
            'chat_devices.id',
            'chat_links.new_device_id'
          )
          .select('chat_links.id')
          .whereRef('chat_links.id', '=', 'notification_events.source_id')
          .where('chat_links.user_id', '=', userId)
          .where('chat_links.box', 'is', null)
          .where('chat_links.declined_at', 'is', null)
          .where('chat_links.expires_at', '>', now)
          .where('chat_devices.revoked_at', 'is', null)
      )
    ]),
    eb.and([
      eb('source_type', 'in', [
        RECORDING_UPLOAD,
        LOCAL_COPY_EXPIRING,
        PLAYER_ADD_REJECTED
      ]),
      eb.not(
        eb.exists(
          eb
            .selectFrom('notification_receipts')
            .select('notification_receipts.event_id')
            .whereRef(
              'notification_receipts.event_id',
              '=',
              'notification_events.id'
            )
            .where('notification_receipts.user_id', '=', userId)
            .where('notification_receipts.dismissed_at', 'is not', null)
        )
      )
    ])
  ])
}
