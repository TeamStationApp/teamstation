import type { Migration } from '../runner'

/**
 * Stored results name no imported code that is on no list.
 *
 * An import parser, since retired, stored some results as the source's own
 * names snake-cased. None of those plays names a player, and every game
 * holding one is already incomplete, so no stat line changes. This renames
 * each one's `result.eventType` in `events` (the generated `eventType`
 * column follows) to the code MLB or GameStation has for it. Their runners
 * carry none of these codes, and the action log and credits are left alone.
 *
 * `inning_changed_by_scorekeeper` is each game's only play, carrying the final
 * score, so it becomes `final_score`.
 *
 * Every row renamed is recorded in `legacy_event_type_renames`, so the down
 * path puts back exactly those rows, and not a play that carried the new code
 * already. A row whose code has changed since is left as it is.
 */
const LEGACY_RESULT_RENAMES: Array<[legacy: string, listed: string]> = [
  ['runner_out', 'other_out'],
  ['batter_out', 'field_out'],
  ['catcher_s_interference', 'catcher_interf'],
  ['fc_double_play', 'double_play'],
  ['offensive_interference', 'batter_interference'],
  ['batter_put_on_base', 'gs_manual_placement'],
  ['inning_changed_by_scorekeeper', 'final_score']
]

const listedOf = `case gumbo #>> '{result,eventType}'
${LEGACY_RESULT_RENAMES.map(
  ([legacy, listed]) => `    when '${legacy}' then '${listed}'`
).join('\n')}
  end`

export const migration040LegacyEventTypes: Migration = {
  name: '040legacyEventTypes',
  up: `
create table legacy_event_type_renames (
  event_id text primary key references events (id) on delete cascade,
  old_event_type text not null,
  new_event_type text not null
);

insert into legacy_event_type_renames (event_id, old_event_type, new_event_type)
select id, gumbo #>> '{result,eventType}', ${listedOf}
from events
where gumbo #>> '{result,eventType}' in (${LEGACY_RESULT_RENAMES.map(
    ([legacy]) => `'${legacy}'`
  ).join(', ')});

update events
set gumbo = jsonb_set(gumbo, '{result,eventType}', to_jsonb(r.new_event_type))
from legacy_event_type_renames r
where r.event_id = events.id;
`,
  down: `
update events
set gumbo = jsonb_set(gumbo, '{result,eventType}', to_jsonb(r.old_event_type))
from legacy_event_type_renames r
where r.event_id = events.id
  and events.gumbo #>> '{result,eventType}' = r.new_event_type;

drop table legacy_event_type_renames;
`
}
