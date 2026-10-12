import type { Migration } from '../runner'

export const migration055EventInfo: Migration = {
  name: '055eventInfo',
  up: `
alter table games add column end_at timestamptz,
  add column address text, add column latitude double precision,
  add column longitude double precision;
alter table games add constraint games_event_end check (end_at > start_at),
  add constraint games_event_coordinates check (
    (latitude is null and longitude is null) or
    (latitude is not null and longitude is not null and latitude between -90 and 90 and longitude between -180 and 180));
create table team_events (
  id text primary key,
  team_id text not null references teams(id) on delete restrict,
  title text not null check (length(trim(title)) between 1 and 200),
  start_at timestamptz not null,
  end_at timestamptz check (end_at > start_at),
  timezone text not null default 'UTC',
  venue text,
  address text,
  latitude double precision,
  longitude double precision,
  status text not null default 'scheduled' check (status in ('scheduled','cancelled')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((latitude is null and longitude is null) or
    (latitude is not null and longitude is not null and latitude between -90 and 90 and longitude between -180 and 180))
);
create index team_events_schedule on team_events(team_id, start_at);
create table game_rsvps (
  event_id text not null references games(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  response text not null check (response in ('yes','maybe','no')),
  updated_by bigint references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key(event_id,user_id)
);
create table team_event_rsvps (
  event_id text not null references team_events(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  response text not null check (response in ('yes','maybe','no')),
  updated_by bigint references users(id) on delete set null,
  updated_at timestamptz not null default now(),
  primary key(event_id,user_id)
);
create table event_geocodes (
  address text primary key,
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  updated_at timestamptz not null default now()
);
`,
  down: `
drop table event_geocodes, team_event_rsvps, game_rsvps, team_events;
alter table games drop constraint games_event_end, drop constraint games_event_coordinates;
alter table games drop column end_at, drop column address, drop column latitude, drop column longitude;
`
}
