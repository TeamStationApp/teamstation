import type { Migration } from '../runner'

/**
 * A team's default lineup (`teams.default_lineup`) keeps each player by his
 * id and jersey. His name is read from `users` when the default is read, so
 * every person with a `gumboId`, in the batting order and in the field,
 * loses his stored `name`. A placeholder (a null `gumboId`) keeps the name
 * the team typed. A default that is not a lineup is left as it is.
 *
 * Names cannot be put back: rolling back raises.
 */
export const migration093DefaultLineupIds: Migration = {
  name: '093defaultLineupIds',
  up: `
create function ts_093_person(person jsonb) returns jsonb
language sql immutable as $person$
  select case
    when jsonb_typeof(person) = 'object'
      and jsonb_typeof(person->'gumboId') = 'number'
      then person - 'name'
    else person
  end
$person$;

create function ts_093_default(held jsonb) returns jsonb
language sql immutable as $default$
  select case
    when coalesce(jsonb_typeof(held->'lineup'), '') <> 'object' then held
    else jsonb_set(held, '{lineup}', (held->'lineup')
      || case
        when jsonb_typeof(held #> '{lineup,batters}') = 'array' then
          jsonb_build_object('batters', (
            select coalesce(
              jsonb_agg(ts_093_person(value) order by ordinal), '[]'::jsonb)
            from jsonb_array_elements(held #> '{lineup,batters}')
              with ordinality as batter(value, ordinal)))
        else '{}'::jsonb
      end
      || case
        when jsonb_typeof(held #> '{lineup,defense}') = 'object' then
          jsonb_build_object('defense', (
            select coalesce(
              jsonb_object_agg(key, ts_093_person(value)), '{}'::jsonb)
            from jsonb_each(held #> '{lineup,defense}')))
        else '{}'::jsonb
      end)
  end
$default$;

update teams set default_lineup = ts_093_default(default_lineup)
  where default_lineup is not null
    and default_lineup is distinct from ts_093_default(default_lineup);

drop function ts_093_default(jsonb);
drop function ts_093_person(jsonb);
`,
  down: `do $restore$ begin
    raise exception 'Restore the verified pre-cutover backup and matching code; names taken out of default lineups cannot be put back';
  end $restore$;`
}
