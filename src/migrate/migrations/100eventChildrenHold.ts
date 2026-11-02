import type { Migration } from '../runner'

/**
 * Lets one transaction hold back the row-by-row sync of an event's children
 * when it rewrites many events, and rebuild their children once, in a set.
 * Every other writer leaves the setting unset, so it fires as it always has.
 * `create or replace` so the table's lock stays one that readers pass.
 */
export const migration099EventChildrenHold: Migration = {
  name: '099eventChildrenHold',
  up: `
create or replace trigger events_sync_children_trg
after insert or update of gumbo, "battingTeamId" on events
for each row
when (current_setting('teamstation.event_children_held', true) is distinct from 'on')
execute function events_sync_children();
`,
  down: `
create or replace trigger events_sync_children_trg
after insert or update of gumbo, "battingTeamId" on events
for each row
execute function events_sync_children();
`
}
