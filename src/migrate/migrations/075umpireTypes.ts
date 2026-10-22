import type { Migration } from '../runner'

export const migration075UmpireTypes: Migration = {
  name: '075umpireTypes',
  up: `
create table umpire_types (
  id text primary key check (id !~ ':'),
  league_id text not null references leagues(id) on delete cascade,
  name text not null check (btrim(name) <> '' and length(name) <= 100),
  position integer not null check (position >= 0),
  legacy_kind text check (legacy_kind in ('plate','field')),
  unique (league_id, legacy_kind)
);
create unique index umpire_types_name on umpire_types(league_id, lower(name));
insert into umpire_types (id,league_id,name,position,legacy_kind)
select 'uty_' || md5(id || ':plate'), id, 'Plate', 0, 'plate' from leagues
union all select 'uty_' || md5(id || ':field'), id, 'Field', 1, 'field' from leagues;
create table season_umpire_type_requirements (
  season_id text not null references season_umpire_requirements(season_id) on delete cascade,
  type_id text not null references umpire_types(id) on delete cascade,
  required_count integer not null check (required_count between 0 and 6),
  optional_count integer not null check (optional_count between 0 and 6),
  primary key (season_id,type_id)
);
insert into season_umpire_type_requirements
select r.season_id,t.id,case when t.legacy_kind='plate' then r.plate::integer else r.field_count end,
 case when t.legacy_kind='plate' then 0 else r.optional_field_count end
from season_umpire_requirements r join seasons s on s.id=r.season_id join umpire_types t on t.league_id=s.league_id;
alter table umpire_certifications rename to old_umpire_certifications;
create table umpire_certifications (
  user_id text not null references users(id) on delete cascade,
  level_id text not null references umpire_levels(id) on delete cascade,
  type_id text not null references umpire_types(id) on delete cascade,
  enabled boolean not null default false,
  primary key (user_id,level_id,type_id)
);
insert into umpire_certifications
select c.user_id,c.level_id,t.id,case when t.legacy_kind='plate' then c.plate else c.field end
from old_umpire_certifications c join umpire_levels l on l.id=c.level_id join umpire_types t on t.league_id=l.league_id;
drop table old_umpire_certifications;
alter table umpire_assignments drop constraint umpire_assignments_slot_check;
update umpire_assignments a set slot=t.id || ':' || case when a.slot='plate' then '1' else split_part(a.slot,':',2) end
from games g join seasons s on s.id=g.season_id join umpire_types t on t.league_id=s.league_id
where a.game_id=g.id and t.legacy_kind=case when a.slot='plate' then 'plate' else 'field' end;
alter table umpire_assignments add constraint umpire_assignments_slot_check check (slot ~ '^[^:]+:([1-9]|1[0-2])$');
alter table season_umpire_requirements drop column plate, drop column field_count, drop column optional_field_count;
`,
  down: `
do $$ begin
 if exists(select 1 from umpire_types where legacy_kind is null) or
    exists(select 1 from season_umpire_type_requirements r join umpire_types t on t.id=r.type_id
      where t.legacy_kind='plate' and (r.required_count>1 or r.optional_count<>0)) or
    exists(select 1 from umpire_assignments a left join umpire_types t on t.id=split_part(a.slot,':',1)
      where t.id is null or (t.legacy_kind='plate' and split_part(a.slot,':',2)<>'1')) then
   raise exception 'Custom umpire types cannot be rolled back losslessly';
 end if;
end $$;
alter table season_umpire_requirements add column plate boolean not null default false,
 add column field_count integer not null default 0 check (field_count between 0 and 6),
 add column optional_field_count integer not null default 0 check (optional_field_count between 0 and 6);
update season_umpire_requirements r set plate=c.required_count=1 from season_umpire_type_requirements c join umpire_types t on t.id=c.type_id where c.season_id=r.season_id and t.legacy_kind='plate';
update season_umpire_requirements r set field_count=c.required_count,optional_field_count=c.optional_count from season_umpire_type_requirements c join umpire_types t on t.id=c.type_id where c.season_id=r.season_id and t.legacy_kind='field';
alter table umpire_assignments drop constraint umpire_assignments_slot_check;
update umpire_assignments a set slot=case when t.legacy_kind='plate' then 'plate' else 'field:' || split_part(a.slot,':',2) end from umpire_types t where t.id=split_part(a.slot,':',1);
alter table umpire_assignments add constraint umpire_assignments_slot_check check (slot='plate' or slot ~ '^field:([1-9]|1[0-2])$');
alter table umpire_certifications rename to typed_umpire_certifications;
create table umpire_certifications (
 user_id text not null references users(id) on delete cascade,
 level_id text not null references umpire_levels(id) on delete cascade,
 plate boolean not null default false,field boolean not null default false,
 primary key(user_id,level_id)
);
insert into umpire_certifications select c.user_id,c.level_id,
 bool_or(c.enabled and t.legacy_kind='plate'),bool_or(c.enabled and t.legacy_kind='field')
 from typed_umpire_certifications c join umpire_types t on t.id=c.type_id group by c.user_id,c.level_id;
drop table typed_umpire_certifications;
drop table season_umpire_type_requirements;
drop table umpire_types;
alter table season_umpire_requirements alter column plate drop default, alter column field_count drop default;
`
}
