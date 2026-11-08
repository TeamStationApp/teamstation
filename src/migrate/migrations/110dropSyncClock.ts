import type { Migration } from '../runner'

/**
 * Screen scope notices carry no revision, and list reads no longer take one,
 * so the single clock row every noting write took in turn goes. Down puts
 * the table back with its one row at 0.
 *
 * The ingest has to restart along with a deploy past this migration: it
 * runs the build it was started on, and an older build still writes
 * `sync_clock`, so until it restarts each of its writes that notes a scope
 * fails and rolls back. The app is pre-release, so dropping the table in the
 * release that stops using it is acceptable here.
 */
export const migration110DropSyncClock: Migration = {
  name: '110dropSyncClock',
  up: `
drop table sync_clock;
`,
  down: `
create table sync_clock (
  id integer primary key,
  value bigint not null
);
insert into sync_clock (id, value) values (1, 0);
`
}
