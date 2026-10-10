import type { Migration } from '../runner'

/** Personal group grants use the same bilateral request lifecycle as affiliations. */
export const migration051PersonalRequests: Migration = {
  name: '051personalRequests',
  up: `
alter table group_requests drop constraint group_requests_kind_check;
alter table group_requests add constraint group_requests_kind_check
  check (kind in ('parent','participation','promotion','person','game','gameChange'));
alter table invites add column request_id text references group_requests(id) on delete restrict;
create unique index invites_request on invites(request_id) where request_id is not null;
update invites set expires_at = created_at + interval '7 days'
  where for_email is not null and (expires_at is null or expires_at > created_at + interval '7 days');
`,
  down: `
drop index invites_request;
alter table invites drop column request_id;
delete from group_requests where kind = 'person';
alter table group_requests drop constraint group_requests_kind_check;
alter table group_requests add constraint group_requests_kind_check
  check (kind in ('parent','participation','promotion','game','gameChange'));
`
}
