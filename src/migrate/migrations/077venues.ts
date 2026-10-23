import type { Migration } from '../runner'

/**
 * The venue registry: real places from Google Maps, each with fields that can
 * be set up in one or more of the fixed sizes, and the leagues that claim the
 * right to edit them.
 *
 * Hours are a weekly list of `{ weekday, start, end }` wall times in the
 * venue's time zone. A field's own `hours` replace the venue's default hours
 * when set; its blackouts add to the venue's.
 *
 * A claim is `pending` for seven days (`approves_at`) and counts once it is
 * approved or that time has passed. `kind` says whether it was the venue's
 * first claim, which only a site administrator decides, or a request to
 * co-own a venue already claimed, which an owner may decide too.
 */
export const migration077Venues: Migration = {
  name: '077venues',
  up: `
create table venues (
  id text primary key,
  google_place_id text not null unique,
  name text not null check (length(name) between 1 and 200),
  address text not null default '' check (length(address) <= 400),
  latitude double precision not null check (latitude between -90 and 90),
  longitude double precision not null check (longitude between -180 and 180),
  timezone text not null,
  size_switch_minutes integer not null default 0
    check (size_switch_minutes between 0 and 240),
  default_hours jsonb not null default '[]',
  default_blackouts date[] not null default '{}',
  photo_path text,
  photo_sha256 text,
  photo_updated_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create table venue_fields (
  id text primary key,
  venue_id text not null references venues(id),
  name text not null check (length(name) between 1 and 100),
  sizes text[] not null check (
    cardinality(sizes) > 0 and sizes <@ array['46/60','50/70','55/80','60/90']
  ),
  pin_latitude double precision check (pin_latitude between -90 and 90),
  pin_longitude double precision check (pin_longitude between -180 and 180),
  starts_on date,
  ends_on date,
  hours jsonb,
  blackouts date[] not null default '{}',
  photo_path text,
  photo_sha256 text,
  photo_updated_at timestamptz,
  deleted_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint venue_fields_pin check ((pin_latitude is null) = (pin_longitude is null)),
  constraint venue_fields_dates check (
    (starts_on is null) = (ends_on is null) and (ends_on is null or ends_on >= starts_on)
  )
);
create index venue_fields_venue on venue_fields(venue_id) where deleted_at is null;
create table venue_claims (
  id text primary key,
  venue_id text not null references venues(id),
  league_id text not null references leagues(id),
  kind text not null check (kind in ('claim', 'coOwner')),
  requested_by text not null references users(id),
  status text not null default 'pending'
    check (status in ('pending', 'approved', 'rejected', 'left', 'removed')),
  requested_at timestamptz not null default now(),
  approves_at timestamptz not null,
  decided_by text references users(id),
  decided_at timestamptz,
  constraint venue_claims_window check (approves_at > requested_at),
  constraint venue_claims_decided check ((status = 'pending') = (decided_at is null))
);
create unique index venue_claims_live on venue_claims(venue_id, league_id)
  where status in ('pending', 'approved');
create index venue_claims_league on venue_claims(league_id)
  where status in ('pending', 'approved');
`,
  down: `
do $refuse$ begin
  if exists (select 1 from venues) then
    raise exception 'Venues exist; delete them before rolling this back';
  end if;
end $refuse$;
drop table venue_claims;
drop table venue_fields;
drop table venues;
`
}
