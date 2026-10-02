import type { Migration } from '../runner'

/**
 * The names stored in the database become TeamStation's.
 *
 * - The three extension event codes, `gs_manual_placement`, `gs_batter_out`
 *   and `gs_batting_order`, become `ts_`. They are stored in each play's
 *   result, its runners' details, its play events and its credits, in the
 *   at-bat in progress on `games`, in `"eventCredits"."eventType"` and in the
 *   record migration 040 kept of what it renamed.
 * - The engine's record on a scored play, the `gameStation` key, becomes
 *   `teamStation`, and the scoring system that wrote a play, `gamestation`,
 *   becomes `teamstation` wherever a play names it.
 * - `events.source` and `games."scoringOwner"` say `teamstation`, and the
 *   source check allows it in place of the old name.
 * - The two SQL helpers become `ts_make_id` and `ts_user_id_number`, and the
 *   trigger that copies a play's credits out calls the new one.
 * - Sessions a Director signed in say `TS Director`.
 *
 * The stored JSON is rewritten as text, one exact quoted token at a time: each
 * token is a whole JSON string, so it is a code, a key or a system name and
 * nothing a person typed. The trigger function is rewritten from its own live
 * definition, so it keeps whatever the earlier migrations made it.
 */

const CODES = ['manual_placement', 'batter_out', 'batting_order']

/** `column`'s JSON with every token in `pairs` replaced, as one expression. */
function rewritten(column: string, pairs: Array<[string, string]>): string {
  return pairs.reduce(
    (text, [from, to]) => `replace(${text}, '"${from}"', '"${to}"')`,
    `${column}::text`
  )
}

/** `column`'s JSON holds one of the tokens in `pairs`. */
function holds(column: string, pairs: Array<[string, string]>): string {
  const pattern = pairs.map(([from]) => `"${from}"`).join('|')
  return `${column}::text ~ '${pattern}'`
}

function names(from: 'gs' | 'ts'): Array<[string, string]> {
  const to = from === 'gs' ? 'ts' : 'gs'
  const [name, system, key] =
    from === 'gs'
      ? ['gamestation', 'teamstation', ['gameStation', 'teamStation']]
      : ['teamstation', 'gamestation', ['teamStation', 'gameStation']]
  return [
    ...CODES.map((code): [string, string] => [
      `${from}_${code}`,
      `${to}_${code}`
    ]),
    [key[0], key[1]],
    [name, system]
  ]
}

function userIdNumber(prefix: 'gs' | 'ts'): string {
  return `
create or replace function ${prefix}_user_id_number(id text) returns bigint
language plpgsql immutable as $fn$
declare
  raw bytea;
  n bigint := 0;
  i int;
begin
  if id is null then
    return null;
  end if;
  if id !~ '^usr_[A-Za-z0-9_-]{16}$' then
    raise exception
      'user id is not usr_ plus 16 base64url characters: %', id;
  end if;
  raw := decode(translate(substr(id, 5), '-_', '+/'), 'base64');
  for i in 0..6 loop
    n := (n << 8) | get_byte(raw, i);
  end loop;
  return n >> 3;
end
$fn$;
`
}

function makeId(prefix: 'gs' | 'ts'): string {
  return `
create or replace function ${prefix}_make_id(prefix text) returns text
language sql volatile as $fn$
  select prefix || '_' || rtrim(
    translate(encode(gen_random_bytes(12), 'base64'), '+/', '-_'),
    '='
  );
$fn$;
`
}

/** The trigger function again, calling `to`_make_id where it called `from`'s. */
function syncChildrenCalling(from: 'gs' | 'ts', to: 'gs' | 'ts'): string {
  return `
do $body$
declare
  definition text;
begin
  select pg_get_functiondef('events_sync_children()'::regprocedure)
  into definition;
  execute replace(definition, '${from}_make_id(', '${to}_make_id(');
end
$body$;
`
}

function sourceCheck(from: string, to: string): string {
  return `
alter table events drop constraint if exists events_source_check;
update events set source = '${to}' where source = '${from}';
alter table events add constraint events_source_check
  check (source in ('external', 'manual', '${to}'));
update games set "scoringOwner" = '${to}' where "scoringOwner" = '${from}';
`
}

function rename(from: 'gs' | 'ts'): string {
  const to = from === 'gs' ? 'ts' : 'gs'
  const pairs = names(from)
  const codes = CODES.map((code): [string, string] => [
    `${from}_${code}`,
    `${to}_${code}`
  ])
  return `
${makeId(to)}
${userIdNumber(to)}
${syncChildrenCalling(from, to)}
drop function ${from}_make_id(text);
drop function ${from}_user_id_number(text);

update events
set gumbo = ${rewritten('gumbo', pairs)}::jsonb
where ${holds('gumbo', pairs)};

update games
set "currentPlay" = ${rewritten('"currentPlay"', pairs)}::jsonb
where "currentPlay" is not null and ${holds('"currentPlay"', pairs)};

${codes
  .map(
    ([old, renamed]) => `
update "eventCredits" set "eventType" = '${renamed}' where "eventType" = '${old}';
update legacy_event_type_renames
set new_event_type = '${renamed}' where new_event_type = '${old}';`
  )
  .join('')}
${sourceCheck(pairs[4][0], pairs[4][1])}
update auth_sessions
set device_name = '${to.toUpperCase()} Director'
where device_name = '${from.toUpperCase()} Director';
`
}

export const migration047TeamStation: Migration = {
  name: '047teamStation',
  up: rename('gs'),
  down: rename('ts')
}
