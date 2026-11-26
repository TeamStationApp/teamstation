import type { Migration } from '../runner'

/** Index the live player-add lookup and recorded-recipient inbox selection. */
export const migration132NotificationInboxIndexes: Migration = {
  name: '132notificationInboxIndexes',
  up: `
create index group_requests_player_add_later
  on group_requests ((terms->>'userId'), sent_at)
  where kind = 'playerAdd' and status in ('applied', 'accepted');
create index notification_events_recipients
  on notification_events using gin (recorded_recipients);
`,
  down: `
drop index notification_events_recipients;
drop index group_requests_player_add_later;
`
}
