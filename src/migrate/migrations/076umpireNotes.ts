import type { Migration } from '../runner'

export const migration076UmpireNotes: Migration = {
  name: '076umpireNotes',
  up: `
create table umpire_note_types (
  id text primary key,
  league_id text not null references leagues(id) on delete cascade,
  name text not null check (btrim(name) <> '' and length(name) <= 100),
  position integer not null check (position >= 0)
);
create unique index umpire_note_types_name on umpire_note_types(league_id, lower(name));
create table game_umpire_notes (
  game_id text not null references games(id) on delete cascade,
  note_type_id text not null references umpire_note_types(id) on delete cascade,
  value text not null check (btrim(value) <> '' and length(value) <= 2000),
  primary key (game_id,note_type_id)
);`,
  down: `drop table game_umpire_notes; drop table umpire_note_types;`
}
