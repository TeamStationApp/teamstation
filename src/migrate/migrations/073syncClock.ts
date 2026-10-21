import type { Migration } from '../runner'

/**
 * The one revision every screen scope is told about: a single row, bumped
 * as the last write of a transaction that changes what a screen shows.
 */
export const migration073SyncClock: Migration = {
  name: '073syncClock',
  up: `
create table sync_clock (
  id integer primary key,
  value bigint not null
);
insert into sync_clock (id, value) values (1, 0);
`,
  down: `
drop table sync_clock;
`
}
