import type { Migration } from '../runner'

/**
 * Stored plays name MLB's event types, and a line counts sacrifice bunts.
 *
 * Three codes GameStation and an earlier import used are not on MLB's
 * list, and the server now stores each as the one that is:
 * `catcher_interference` as `catcher_interf`, `placed_runner` as
 * `runner_placed`, and `manual_placement` as GameStation's own
 * `gs_manual_placement`. This renames the ones already stored, in the result
 * and in each runner's details of every `events` play (the generated
 * `eventType` column follows the result), and of the at-bat in progress on
 * `games`. The `gameStation` action log keeps the engine's own words, because
 * that is what replays, and so do the credits.
 *
 * `sh` is the sacrifice bunt, which used to be counted in `sf`. The stats
 * builder writes it on the next build of each game.
 */
const RENAMES: Array<[legacy: string, listed: string]> = [
  ['catcher_interference', 'catcher_interf'],
  ['placed_runner', 'runner_placed'],
  ['manual_placement', 'gs_manual_placement']
]

/**
 * `document` with each runner whose `details.eventType` is `from` renamed to
 * `to`, the runners kept in order.
 */
function runnersRenamed(document: string, from: string, to: string): string {
  return `jsonb_set(${document}, '{runners}', (
  select jsonb_agg(
    case when runner #>> '{details,eventType}' = '${from}'
      then jsonb_set(runner, '{details,eventType}', '"${to}"'::jsonb)
      else runner end
    order by at)
  from jsonb_array_elements(${document}->'runners') with ordinality as r(runner, at)))`
}

/** `document` holds a runner whose `details.eventType` is `from`. */
function hasRunner(document: string, from: string): string {
  return `jsonb_typeof(${document}->'runners') = 'array'
  and exists (
    select 1 from jsonb_array_elements(${document}->'runners') as r(runner)
    where runner #>> '{details,eventType}' = '${from}')`
}

function rename(from: string, to: string): string {
  return `
update events
set gumbo = jsonb_set(gumbo, '{result,eventType}', '"${to}"'::jsonb)
where gumbo #>> '{result,eventType}' = '${from}';

update events
set gumbo = ${runnersRenamed('gumbo', from, to)}
where ${hasRunner('gumbo', from)};

update games
set "currentPlay" = jsonb_set("currentPlay", '{result,eventType}', '"${to}"'::jsonb)
where "currentPlay" #>> '{result,eventType}' = '${from}';

update games
set "currentPlay" = ${runnersRenamed('"currentPlay"', from, to)}
where ${hasRunner('"currentPlay"', from)};
`
}

export const migration039GumboEventTypes: Migration = {
  name: '039gumboEventTypes',
  up: `
${RENAMES.map(([legacy, listed]) => rename(legacy, listed)).join('')}
alter table game_player_stats add column sh integer not null default 0;
`,
  down: `
${RENAMES.map(([legacy, listed]) => rename(listed, legacy)).join('')}
alter table game_player_stats drop column if exists sh;
`
}
