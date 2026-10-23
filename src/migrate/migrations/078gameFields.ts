import type { Migration } from '../runner'

/**
 * A game can be linked to one field of the venue registry, in one of the
 * sizes the field can be set up in. `game_field_warnings` remembers which
 * warnings about a game have been announced to its teams, so each is
 * announced once: `other_ref` is the conflicting game's id, or `''` for a
 * warning with no other side.
 */
export const migration078GameFields: Migration = {
  name: '078gameFields',
  up: `
alter table games add column field_id text references venue_fields(id);
alter table games add column field_size text
  check (field_size in ('46/60','50/70','55/80','60/90'));
alter table games add constraint games_field_and_size
  check ((field_id is null) = (field_size is null));
create index games_field_start on games(field_id, start_at) where field_id is not null;
create table game_field_warnings (
  game_id text not null references games(id) on delete cascade,
  kind text not null check (kind in ('conflict','outsideAvailability','fieldDeleted','sizeRemoved')),
  other_ref text not null default '',
  notified_at timestamptz not null default now(),
  primary key (game_id, kind, other_ref)
);
`,
  down: `
do $refuse$ begin
  if exists (select 1 from games where field_id is not null) then
    raise exception 'Games are linked to fields; unlink them before rolling this back';
  end if;
end $refuse$;
drop table game_field_warnings;
alter table games drop constraint games_field_and_size;
drop index games_field_start;
alter table games drop column field_size;
alter table games drop column field_id;
`
}
