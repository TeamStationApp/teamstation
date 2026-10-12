import type { Migration } from '../runner'

/**
 * One kind of member at every level. A season or league member is the same
 * member a team has, reaching every team below the level as a team member
 * reaches their team, so `season_members.role` and `league_members.role` are
 * `member` and nothing else: every `spectator` row becomes one, and the
 * checks and defaults allow only `member`. The column stays, so a person's
 * grant on every level reads `{ id, name, role }` from a stored role, as a
 * team membership's does.
 *
 * `memberships.is_spectator` is dropped: no rule ever read it, and a team
 * member is a member whether an invite, a roster import or a person
 * invitation made them one.
 *
 * Down restores the earlier shape: both checks allow `spectator` and `member`
 * again with `spectator` the default, every `member` row of the two tables
 * goes back to `spectator` (before this change nothing wrote `member`
 * there), and `is_spectator` comes back as false for every membership.
 */
export const migration056OneMemberKind: Migration = {
  name: '056oneMemberKind',
  up: `
alter table season_members drop constraint season_members_role_check;
update season_members set role = 'member' where role <> 'member';
alter table season_members alter column role set default 'member';
alter table season_members add constraint season_members_role_check
  check (role = 'member');

alter table league_members drop constraint league_members_role_check;
update league_members set role = 'member' where role <> 'member';
alter table league_members alter column role set default 'member';
alter table league_members add constraint league_members_role_check
  check (role = 'member');

alter table memberships drop column is_spectator;
`,
  down: `
alter table memberships add column is_spectator boolean not null default false;

alter table league_members drop constraint league_members_role_check;
update league_members set role = 'spectator';
alter table league_members alter column role set default 'spectator';
alter table league_members add constraint league_members_role_check
  check (role in ('spectator', 'member'));

alter table season_members drop constraint season_members_role_check;
update season_members set role = 'spectator';
alter table season_members alter column role set default 'spectator';
alter table season_members add constraint season_members_role_check
  check (role in ('spectator', 'member'));
`
}
