import type { Migration } from '../runner'

/** Management, competition entry and scheduled games have independent lifetimes. */
export const migration050CreationHierarchy: Migration = {
  name: '050creationHierarchy',
  up: `
alter table users add column onboarding_step text not null default 'complete'
  check (onboarding_step in ('name', 'photo', 'complete'));
alter table users add column onboarding_completed_at timestamptz default now();
alter table users add column disabled_at timestamptz;
alter table users add column picture_catalog_id text;
alter table leagues add column locality jsonb;
alter table leagues add column picture_catalog_id text;
alter table seasons add column timezone text not null default 'UTC';
alter table seasons add column picture_catalog_id text;
alter table teams add column league_id text references leagues(id) on delete restrict;
alter table teams add column locality jsonb;
alter table teams add column picture_catalog_id text;
alter table teams add column custodian_type text
  check (custodian_type in ('league', 'season', 'team'));
alter table teams add column custodian_id text;
alter table teams add constraint teams_custodian_pair
  check ((custodian_type is null) = (custodian_id is null));
create index teams_parent_league on teams(league_id);
create table season_team_parents (
  season_id text not null references seasons(id) on delete restrict,
  team_id text not null references teams(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key(season_id, team_id)
);
create index season_team_parents_team on season_team_parents(team_id);
alter table season_teams add column active boolean not null default true;

create function creation_lock_parents() returns trigger language plpgsql as $$
begin
  perform pg_advisory_xact_lock(hashtextextended('creation:parent-graph', 0));
  if tg_op = 'DELETE' then return old; end if;
  return new;
end $$;
create trigger creation_parent_write_lock before insert or update or delete on season_team_parents
  for each row execute function creation_lock_parents();
create trigger creation_team_parent_write_lock before update of league_id on teams
  for each row execute function creation_lock_parents();
create trigger creation_season_parent_write_lock before update of league_id on seasons
  for each row execute function creation_lock_parents();

create function creation_check_parents() returns trigger language plpgsql as $$
begin
  if exists (
    select 1 from season_team_parents p
    join teams t on t.id = p.team_id join seasons s on s.id = p.season_id
    where t.league_id is distinct from s.league_id
  ) then
    raise exception 'Parent seasons and team must share their league'
      using errcode = '23514';
  end if;
  if exists (
    select p.team_id from season_team_parents p join seasons s on s.id = p.season_id
    group by p.team_id having count(*) > 1 and bool_or(s.league_id is null)
  ) then
    raise exception 'Multiple parent seasons require one non-null league'
      using errcode = '23514';
  end if;
  return null;
end $$;
create constraint trigger creation_parents_consistent
  after insert or update or delete on season_team_parents
  deferrable initially deferred for each row execute function creation_check_parents();
create constraint trigger creation_team_league_consistent
  after update of league_id on teams
  deferrable initially deferred for each row execute function creation_check_parents();
create constraint trigger creation_season_league_consistent
  after update of league_id on seasons
  deferrable initially deferred for each row execute function creation_check_parents();

alter table games add column outside_tournament text;
alter table games add column cancellation_reason text;
alter table games add column withdrawn_by_team_id text references teams(id) on delete restrict;
alter table games add column withdrawn_by_user_id bigint references users(id) on delete restrict;
alter table games add column withdrawn_at timestamptz;
alter table games add constraint games_withdrawal_reason
  check (cancellation_reason is distinct from 'withdrawal' or
    (status = 'cancelled' and withdrawn_by_team_id is not null and withdrawn_at is not null));
alter table games add constraint games_withdrawal_opponent
  check (withdrawn_by_team_id is null or withdrawn_by_team_id in (home_team_id, away_team_id));

create table creation_idempotency (
  user_id bigint not null references users(id) on delete cascade,
  key text not null,
  body_hash text not null,
  response jsonb not null,
  created_at timestamptz not null default now(),
  primary key(user_id, key)
);
create table group_requests (
  id text primary key,
  kind text not null check (kind in ('parent', 'participation', 'promotion', 'game', 'gameChange')),
  sender_id bigint not null references users(id) on delete restrict,
  sender_scope_type text not null check (sender_scope_type in ('league', 'season', 'team')),
  sender_scope_id text not null,
  terms jsonb not null,
  revision integer not null default 1 check (revision > 0),
  status text not null default 'pending'
    check (status in ('pending','accepted','declined','expired','cancelled','superseded')),
  sent_at timestamptz not null default now(),
  expires_at timestamptz not null,
  resolved_at timestamptz,
  resolved_by bigint references users(id) on delete restrict,
  game_id text references games(id) on delete restrict,
  initiating_team_id text references teams(id) on delete restrict,
  sender_hidden boolean not null default false,
  supersedes_id text references group_requests(id) on delete restrict,
  check (expires_at > sent_at)
);
create index group_requests_pending on group_requests(status, expires_at, sent_at, id);
create index group_requests_sender on group_requests(sender_scope_type, sender_scope_id, sent_at, id);
create table group_request_sides (
  request_id text not null references group_requests(id) on delete cascade,
  scope_type text not null check (scope_type in ('league','season','team','user')),
  scope_id text not null,
  approved_by bigint references users(id) on delete restrict,
  approved_at timestamptz,
  primary key(request_id, scope_type, scope_id),
  check ((approved_by is null) = (approved_at is null))
);
create index group_request_sides_scope on group_request_sides(scope_type, scope_id);
create table notification_events (
  id text primary key,
  source_type text not null,
  source_id text not null,
  revision integer not null,
  actor_id bigint references users(id) on delete restrict,
  metadata jsonb not null default '{}',
  recorded_recipients bigint[] not null default '{}',
  created_at timestamptz not null default now(),
  unique(source_type, source_id, revision)
);
create index notification_events_order on notification_events(created_at,id);
create table notification_receipts (
  event_id text not null references notification_events(id) on delete cascade,
  user_id bigint not null references users(id) on delete cascade,
  viewed_at timestamptz not null default now(),
  primary key(event_id,user_id)
);
`,
  down: `
drop table notification_receipts;
drop table notification_events;
drop table group_request_sides;
drop table group_requests;
drop table creation_idempotency;
alter table games drop constraint games_withdrawal_opponent;
alter table games drop constraint games_withdrawal_reason;
alter table games drop column outside_tournament, drop column cancellation_reason,
  drop column withdrawn_by_team_id, drop column withdrawn_by_user_id, drop column withdrawn_at;
drop trigger creation_parents_consistent on season_team_parents;
drop trigger creation_team_league_consistent on teams;
drop trigger creation_season_league_consistent on seasons;
drop trigger creation_parent_write_lock on season_team_parents;
drop trigger creation_team_parent_write_lock on teams;
drop trigger creation_season_parent_write_lock on seasons;
drop function creation_check_parents();
drop function creation_lock_parents();
drop table season_team_parents;
alter table season_teams drop column active;
alter table teams drop constraint teams_custodian_pair;
alter table teams drop column league_id, drop column locality, drop column picture_catalog_id,
  drop column custodian_type, drop column custodian_id;
alter table seasons drop column timezone, drop column picture_catalog_id;
alter table leagues drop column locality, drop column picture_catalog_id;
alter table users drop column onboarding_step, drop column onboarding_completed_at,
  drop column disabled_at, drop column picture_catalog_id;
`
}
