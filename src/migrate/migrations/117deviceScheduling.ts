import type { Migration } from '../runner'

/** Explicit season field choices and dated field/venue availability. */
export const migration117DeviceScheduling: Migration = {
  name: '117deviceScheduling',
  up: `
alter table venues add column default_windows jsonb not null default '[{"from":"0001-01-01","hours":[]}]';
update venues set default_windows = jsonb_build_array(jsonb_build_object('from', '0001-01-01', 'hours', default_hours));
alter table venue_fields add column windows jsonb;
update venue_fields set windows = jsonb_build_array(jsonb_build_object('from', '0001-01-01', 'hours', hours)) where hours is not null;
alter table season_schedule_settings add column field_ids text[] not null default '{}';
update season_schedule_settings s set field_ids = array(
  select f.id from seasons season
  join league_schedule_setups setup on setup.league_id = season.league_id
  join venue_fields f on f.id = any(setup.field_ids)
  where season.id = s.season_id and s.field_size = any(f.sizes) and f.deleted_at is null
  order by f.id
);
-- Preserve each saved preview's historical field selection and availability.
update schedule_previews p set input = jsonb_set(jsonb_set(p.input, '{engine,seasons}',
  coalesce((select jsonb_agg(jsonb_set(s, '{settings,fieldIds}',
    coalesce((select jsonb_agg(f->'id') from jsonb_array_elements(p.input#>'{engine,fields}') f
      where f->'sizes' ? (s#>>'{settings,fieldSize}')), '[]'::jsonb)))
    from jsonb_array_elements(p.input#>'{engine,seasons}') s), '[]'::jsonb)), '{engine,fields}',
  coalesce((select jsonb_agg(jsonb_set(f, '{availability,windows}',
    jsonb_build_array(jsonb_build_object('from', '0001-01-01', 'hours', f#>'{availability,hours}'))))
    from jsonb_array_elements(p.input#>'{engine,fields}') f), '[]'::jsonb));
`,
  down: `
do $refuse$ begin
  if exists (select 1 from venues where default_windows <> jsonb_build_array(jsonb_build_object('from', '0001-01-01', 'hours', default_hours)))
    or exists (select 1 from venue_fields where windows is distinct from case when hours is null then null else jsonb_build_array(jsonb_build_object('from', '0001-01-01', 'hours', hours)) end) then
    raise exception 'Dated time windows cannot be represented as weekly hours';
  end if;
end $refuse$;
alter table season_schedule_settings drop column field_ids;
alter table venue_fields drop column windows;
alter table venues drop column default_windows;
`
}
