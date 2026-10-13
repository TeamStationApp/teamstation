import type { Migration } from '../runner'

export const migration058EventDetails: Migration = {
  name: '058eventDetails',
  up: `
alter table games add column notes text check (length(notes) <= 2000),
  add column arrival_time_delta integer check (arrival_time_delta between 0 and 10080);
alter table team_events add column notes text check (length(notes) <= 2000),
  add column arrival_time_delta integer check (arrival_time_delta between 0 and 10080),
  add column event_type text not null default 'other' check (event_type in ('practice', 'other'));
`,
  down: `
alter table team_events drop column event_type, drop column arrival_time_delta, drop column notes;
alter table games drop column arrival_time_delta, drop column notes;
`
}
