import type { Migration } from '../runner'

/**
 * `assistant` joins the role flags: everything a coach may do, shown as
 * Assistant rather than Coach.
 *
 * Down deletes every assistant row, which the old check would refuse, and
 * restores the check of 043.
 */
export const migration054AssistantRole: Migration = {
  name: '054assistantRole',
  up: `
alter table scope_roles drop constraint scope_roles_role_check;
alter table scope_roles add constraint scope_roles_role_check
  check (role in ('admin', 'coach', 'assistant', 'scorekeeper', 'songkeeper', 'videographer'));
`,
  down: `
delete from scope_roles where role = 'assistant';
alter table scope_roles drop constraint scope_roles_role_check;
alter table scope_roles add constraint scope_roles_role_check
  check (role in ('admin', 'coach', 'scorekeeper', 'songkeeper', 'videographer'));
`
}
