import type { Migration } from '../runner'

export const migration073UmpireManagement: Migration = {
  name: '073umpireManagement',
  up: `
alter table leagues add column umpire_management boolean not null default false;
alter table leagues add column umpire_credits boolean not null default false;
create table league_umpires (
  league_id text not null references leagues(id) on delete cascade,
  user_id text not null references users(id) on delete cascade,
  granted_by text not null references users(id) on delete cascade,
  granted_at timestamptz not null default now(),
  primary key (league_id, user_id)
);
create table umpire_levels (
  id text primary key,
  league_id text not null references leagues(id) on delete cascade,
  name text not null check (btrim(name) <> ''),
  position integer not null check (position >= 0)
);
create unique index umpire_levels_name on umpire_levels(league_id, lower(name));
create table season_umpire_requirements (
  season_id text primary key references seasons(id) on delete cascade,
  level_id text not null references umpire_levels(id) on delete cascade,
  plate boolean not null,
  field_count integer not null check (field_count between 0 and 6)
);
create table umpire_certifications (
  user_id text not null references users(id) on delete cascade,
  level_id text not null references umpire_levels(id) on delete cascade,
  plate boolean not null default false,
  field boolean not null default false,
  primary key (user_id, level_id)
);
create table umpire_assignments (
  game_id text not null references games(id) on delete restrict,
  slot text not null check (slot = 'plate' or slot ~ '^field:[1-6]$'),
  user_id text not null references users(id) on delete cascade,
  assigned_by text not null references users(id) on delete cascade,
  credit_team_id text references teams(id) on delete restrict,
  created_at timestamptz not null default now(),
  primary key (game_id, slot),
  unique (game_id, user_id)
);
create index umpire_assignments_user on umpire_assignments(user_id);
create index umpire_assignments_credit_team on umpire_assignments(credit_team_id);
create function clear_game_umpire_assignments() returns trigger language plpgsql as $$
begin
  if new.status = 'cancelled' or new.withdrawn_at is not null then
    delete from umpire_assignments where game_id = new.id;
  end if;
  return new;
end $$;
create trigger games_clear_umpire_assignments after update of status, withdrawn_at on games
  for each row execute function clear_game_umpire_assignments();
`,
  down: `
drop trigger games_clear_umpire_assignments on games;
drop function clear_game_umpire_assignments();
drop table umpire_assignments;
drop table umpire_certifications;
drop table season_umpire_requirements;
drop table umpire_levels;
drop table league_umpires;
alter table leagues drop column umpire_credits;
alter table leagues drop column umpire_management;
`
}
