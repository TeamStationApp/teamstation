import type { Migration } from '../runner'

export const migration104ManagerScheduling: Migration = {
  name: '104ManagerScheduling',
  // Preserve the preference already stored by earlier feature checkouts.
  up: `
do $migration$
begin
  delete from schema_migrations where name = '101ManagerScheduling';
  if not found then
    alter table league_schedule_setups add column avoid_head_coach_conflicts boolean not null default true;
  end if;
end $migration$;
`,
  down: 'alter table league_schedule_setups drop column avoid_head_coach_conflicts;'
}
