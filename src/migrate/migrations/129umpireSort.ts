import type { Migration } from '../runner'

/**
 * The umpire schedule's league default sort and the league's season order.
 *
 * `leagues.umpire_sort` holds up to two sort keys (`date`, `season`,
 * `seasonPriority`, `certification`, each optionally `-`), `{}` for the
 * empty sort, null for the built-in default. `season_umpire_priorities`
 * holds a season's position in its league's order, 1 first; a season with no
 * row has none and sorts after those that do.
 *
 * Down drops the table and the column.
 */
export const migration129UmpireSort: Migration = {
  name: '129umpireSort',
  up: `
alter table leagues add column umpire_sort text[]
  check (umpire_sort is null or cardinality(umpire_sort) <= 2);
create table season_umpire_priorities (
  season_id text    primary key references seasons (id) on delete cascade,
  position  integer not null check (position >= 1)
);
`,
  down: `
drop table season_umpire_priorities;
alter table leagues drop column umpire_sort;
`
}
