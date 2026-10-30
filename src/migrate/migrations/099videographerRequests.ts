import type { Migration } from '../runner'

/**
 * A member asking to film their team's games: the `videographer` request,
 * which they send for themselves, with no sending group, as a membership
 * request is.
 *
 * Rolling back is refused while any such request exists, since the old checks
 * would no longer hold it.
 */
export const migration099VideographerRequests: Migration = {
  name: '099videographerRequests',
  up: `
alter table group_requests drop constraint group_requests_kind_check;
alter table group_requests add constraint group_requests_kind_check
  check (kind in ('parent','participation','promotion','person','guardian',
                  'membership','game','gameChange','playerAdd','videographer'));
alter table group_requests drop constraint group_requests_sender_scope_check;
alter table group_requests add constraint group_requests_sender_scope_check
  check (kind in ('guardian','membership','videographer')
         or (sender_scope_type is not null and sender_scope_id is not null));
`,
  down: `
do $refuse$ begin
  if exists (select 1 from group_requests where kind = 'videographer') then
    raise exception 'Videographer requests are recorded; remove them before rolling this back';
  end if;
end $refuse$;
alter table group_requests drop constraint group_requests_sender_scope_check;
alter table group_requests add constraint group_requests_sender_scope_check
  check (kind in ('guardian','membership')
         or (sender_scope_type is not null and sender_scope_id is not null));
alter table group_requests drop constraint group_requests_kind_check;
alter table group_requests add constraint group_requests_kind_check
  check (kind in ('parent','participation','promotion','person','guardian',
                  'membership','game','gameChange','playerAdd'));
`
}
