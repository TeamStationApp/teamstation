import type { Migration } from '../runner'

export const migration103TeamHeadCoach: Migration = {
  name: '103TeamHeadCoach',
  // Earlier feature checkouts already installed the same column and index.
  up: `
do $migration$
begin
  delete from schema_migrations where name = '100TeamHeadCoach';
  if not found then
    alter table scope_roles add column is_head_coach boolean not null default false
      check (not is_head_coach or (scope_type = 'team' and role = 'coach'));
    create unique index team_one_head_coach on scope_roles(scope_id) where is_head_coach;
  end if;
end $migration$;
`,
  down: 'alter table scope_roles drop column is_head_coach;'
}
