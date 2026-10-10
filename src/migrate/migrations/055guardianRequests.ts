import type { Migration } from '../runner'

/**
 * `guardian` joins the request kinds: a team's staff inviting somebody to be
 * a player's guardian, or anybody asking to be one.
 *
 * An invitation is sent from a team like every other request. A request is
 * sent by a person on their own behalf, so it has no sending scope, and the
 * check keeps every other kind's scope required. The index serves the
 * sender's limits: their pending requests, and their declines in order.
 *
 * Down deletes every guardian request, which the old checks would refuse,
 * with its notifications, and restores the checks of 051.
 */
export const migration055GuardianRequests: Migration = {
  name: '055guardianRequests',
  up: `
alter table group_requests drop constraint group_requests_kind_check;
alter table group_requests add constraint group_requests_kind_check
  check (kind in ('parent','participation','promotion','person','guardian','game','gameChange'));
alter table group_requests alter column sender_scope_type drop not null;
alter table group_requests alter column sender_scope_id drop not null;
alter table group_requests add constraint group_requests_sender_scope_check
  check (kind = 'guardian' or (sender_scope_type is not null and sender_scope_id is not null));
create index group_requests_guardian_sender
  on group_requests(sender_id, kind, status, resolved_at);
`,
  down: `
drop index group_requests_guardian_sender;
delete from notification_events
  where source_type = 'groupRequest'
    and source_id in (select id from group_requests where kind = 'guardian');
delete from group_requests where kind = 'guardian';
alter table group_requests drop constraint group_requests_sender_scope_check;
alter table group_requests alter column sender_scope_type set not null;
alter table group_requests alter column sender_scope_id set not null;
alter table group_requests drop constraint group_requests_kind_check;
alter table group_requests add constraint group_requests_kind_check
  check (kind in ('parent','participation','promotion','person','game','gameChange'));
`
}
