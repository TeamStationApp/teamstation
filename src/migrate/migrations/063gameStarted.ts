import type { Migration } from '../runner'

/** Setup and roster edits do not start a game; only a pitch or ball in play does. */
export const migration063GameStarted: Migration = {
  name: '063gameStarted',
  up: `
create function ts_play_has_started(play jsonb) returns boolean
language sql immutable parallel safe as $$
  select coalesce(
    play @? '$.teamStation.actions[*] ? (@.type == "pitch" || @.type == "ballInPlay")'
    or play @? '$.playEvents[*] ? (@.isPitch == true || @.details.isInPlay == true)',
    false
  )
$$;

update games set status = 'scheduled', updated_at = now()
where status = 'inProgress'
  and not ts_play_has_started("currentPlay")
  and not exists (
    select 1 from events
    where events."gameId" = games.id and ts_play_has_started(events.gumbo)
  );
`,
  // Reinstating an incorrect in-progress status would invent scoring activity.
  down: 'drop function if exists ts_play_has_started(jsonb);'
}
