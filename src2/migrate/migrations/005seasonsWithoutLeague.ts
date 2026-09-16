import type { Migration } from '../runner'

/**
 * A season can exist before its league does.
 *
 * The migration imports seasons with no league on purpose: Paul creates the
 * league himself in the app and moves the seasons into it, because a league is
 * an organisational decision and the importer has no business guessing at one.
 * `league_id not null` made that impossible.
 *
 * Down is only safe while no such season exists, and says so rather than
 * inventing a league to hang them on.
 */
export const migration005SeasonsWithoutLeague: Migration = {
  name: '005seasonsWithoutLeague',
  up: `
alter table seasons alter column league_id drop not null;
create index seasons_without_league on seasons (id) where league_id is null;
`,
  down: `
drop index if exists seasons_without_league;
do $$
begin
  if exists (select 1 from seasons where league_id is null) then
    raise exception
      'Seasons exist with no league; give them one before rolling this back';
  end if;
end $$;
alter table seasons alter column league_id set not null;
`
}
