import type { Migration } from '../runner'

/** Personal membership requests use the existing two-party approval inbox. */
export const migration064MembershipRequests: Migration = {
  name: '064membershipRequests',
  up: `
alter table group_requests drop constraint group_requests_kind_check;
alter table group_requests add constraint group_requests_kind_check
  check (kind in ('parent','participation','promotion','person','guardian','membership','game','gameChange'));
alter table group_requests drop constraint group_requests_sender_scope_check;
alter table group_requests add constraint group_requests_sender_scope_check
  check (kind in ('guardian','membership') or (sender_scope_type is not null and sender_scope_id is not null));
`,
  down: `
delete from notification_events where source_type = 'groupRequest'
  and source_id in (select id from group_requests where kind = 'membership');
delete from group_requests where kind = 'membership';
alter table group_requests drop constraint group_requests_kind_check;
alter table group_requests add constraint group_requests_kind_check
  check (kind in ('parent','participation','promotion','person','guardian','game','gameChange'));
alter table group_requests drop constraint group_requests_sender_scope_check;
alter table group_requests add constraint group_requests_sender_scope_check
  check (kind = 'guardian' or (sender_scope_type is not null and sender_scope_id is not null));
`
}
