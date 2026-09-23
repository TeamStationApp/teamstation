import type { Migration } from '../runner'

/**
 * `admin_roles` becomes `scope_roles`, and holds the four role flags beside
 * the administrator.
 *
 * A row is one role for one person on one league, season or team: `admin`,
 * or one of `coach`, `scorekeeper`, `songkeeper` and `videographer`. So the
 * one-row-per-person-and-scope key widens to take the role, and the check
 * that allowed only `admin` allows the flags too. Every admin row stays as
 * it is.
 *
 * The old check and key were declared inline in 001 and carry the names
 * Postgres gave them, so they are found by what they constrain rather than
 * named here.
 *
 * Down deletes every flag row, since the old key allows one row per person
 * and scope and the old check allows only `admin`, and restores both.
 */
export const migration043RoleFlags: Migration = {
  name: '043roleFlags',
  up: `
alter table admin_roles rename to scope_roles;
alter index admin_roles_pkey rename to scope_roles_pkey;
alter index admin_roles_scope rename to scope_roles_scope;
do $$
declare
  role_column smallint;
  found text;
begin
  select attnum into role_column from pg_attribute
    where attrelid = 'scope_roles'::regclass and attname = 'role';
  for found in
    select conname from pg_constraint
    where conrelid = 'scope_roles'::regclass
      and (
        (contype = 'c' and conkey = array[role_column])
        or contype = 'u'
      )
  loop
    execute format('alter table scope_roles drop constraint %I', found);
  end loop;
end
$$;
alter table scope_roles add constraint scope_roles_role_check
  check (role in ('admin', 'coach', 'scorekeeper', 'songkeeper', 'videographer'));
alter table scope_roles add constraint scope_roles_one_role
  unique (user_id, scope_type, scope_id, role);
`,
  down: `
delete from scope_roles where role <> 'admin';
alter table scope_roles drop constraint scope_roles_one_role;
alter table scope_roles drop constraint scope_roles_role_check;
alter table scope_roles add constraint admin_roles_role_check
  check (role in ('admin'));
alter table scope_roles add constraint admin_roles_user_id_scope_type_scope_id_key
  unique (user_id, scope_type, scope_id);
alter index scope_roles_scope rename to admin_roles_scope;
alter index scope_roles_pkey rename to admin_roles_pkey;
alter table scope_roles rename to admin_roles;
`
}
