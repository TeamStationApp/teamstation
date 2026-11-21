import type { Migration } from '../runner'

/**
 * Each person's saved umpire availability filter for a league: the levels,
 * the weekdays (0 is Monday … 6 is Sunday), the `from`/`to` time-of-day range
 * and the time zone it was written in. At most one per person and league;
 * no levels or days means every one, and no range means any time.
 *
 * Down drops the table.
 */
export const migration128UmpireAvailability: Migration = {
  name: '128umpireAvailability',
  up: `
create table umpire_availability (
  user_id    text        not null references users (id) on delete cascade,
  league_id  text        not null references leagues (id) on delete cascade,
  levels     text[]      not null default '{}',
  days       smallint[]  not null default '{}',
  from_time  text,
  to_time    text,
  timezone   text        not null,
  updated_at timestamptz not null default now(),
  primary key (user_id, league_id),
  check ((from_time is null) = (to_time is null))
);
`,
  down: `
drop table umpire_availability;
`
}
