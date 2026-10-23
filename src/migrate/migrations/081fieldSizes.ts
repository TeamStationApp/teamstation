import type { Migration } from '../runner'

/**
 * T-ball and machine pitch (`'46/60 MP'`) become field sizes of their own,
 * apart from 46/60. The three checks that hold a size, a field's sizes, a
 * game's size and a season's scheduling size, take both as well. A size
 * already stored keeps its meaning: 46/60 stays 46/60.
 *
 * Rolling back narrows the checks again, and is refused while any field,
 * game or season uses T-ball or machine pitch.
 */
export const migration081FieldSizes: Migration = {
  name: '081fieldSizes',
  up: `
alter table venue_fields drop constraint venue_fields_sizes_check;
alter table venue_fields add constraint venue_fields_sizes_check check (
  cardinality(sizes) > 0
  and sizes <@ array['T-ball','46/60 MP','46/60','50/70','55/80','60/90']
);
alter table games drop constraint games_field_size_check;
alter table games add constraint games_field_size_check
  check (field_size in ('T-ball','46/60 MP','46/60','50/70','55/80','60/90'));
alter table season_schedule_settings
  drop constraint season_schedule_settings_field_size_check;
alter table season_schedule_settings
  add constraint season_schedule_settings_field_size_check
  check (field_size in ('T-ball','46/60 MP','46/60','50/70','55/80','60/90'));
`,
  down: `
do $refuse$ begin
  if exists (select 1 from venue_fields where sizes && array['T-ball','46/60 MP'])
    or exists (select 1 from games where field_size in ('T-ball','46/60 MP'))
    or exists (select 1 from season_schedule_settings where field_size in ('T-ball','46/60 MP')) then
    raise exception 'Fields, games or seasons use the T-ball or machine pitch size; change them before rolling this back';
  end if;
end $refuse$;
alter table venue_fields drop constraint venue_fields_sizes_check;
alter table venue_fields add constraint venue_fields_sizes_check check (
  cardinality(sizes) > 0 and sizes <@ array['46/60','50/70','55/80','60/90']
);
alter table games drop constraint games_field_size_check;
alter table games add constraint games_field_size_check
  check (field_size in ('46/60','50/70','55/80','60/90'));
alter table season_schedule_settings
  drop constraint season_schedule_settings_field_size_check;
alter table season_schedule_settings
  add constraint season_schedule_settings_field_size_check
  check (field_size in ('46/60','50/70','55/80','60/90'));
`
}
