import type { Migration } from '../runner'

export const migration072SeasonDates: Migration = {
  name: '072seasonDates',
  up: `
update seasons set
  starts_on = coalesce(starts_on, ends_on, make_date(year, 3, 1)),
  ends_on = greatest(coalesce(ends_on, starts_on, make_date(year, 5, 31)), starts_on);
alter table seasons alter column starts_on set not null;
alter table seasons alter column ends_on set not null;
alter table seasons add constraint seasons_date_order check (ends_on >= starts_on);
`,
  down: `
alter table seasons drop constraint seasons_date_order;
alter table seasons alter column starts_on drop not null;
alter table seasons alter column ends_on drop not null;
`
}
