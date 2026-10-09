import type { Migration } from '../runner'

export const migration051EventTags: Migration = {
  name: '051eventTags',
  up: `
create sequence tag_use_sequence;
create table event_tag_catalog (tag text primary key);
create table event_tags (
  game_id text not null references games(id) on delete cascade,
  target_id text not null,
  at_bat_index integer not null,
  event_index integer,
  tag text not null references event_tag_catalog(tag),
  assigned_by bigint not null references users(id),
  primary key (game_id, target_id)
);
create index event_tags_popularity on event_tags(tag);
create table user_tags (
  user_id bigint not null references users(id) on delete cascade,
  tag text not null references event_tag_catalog(tag),
  last_used bigint not null default nextval('tag_use_sequence'),
  primary key (user_id, tag)
);
create index user_tags_recent on user_tags(user_id, last_used desc);
`,
  down: `
drop table user_tags;
drop table event_tags;
drop table if exists event_tag_catalog;
drop sequence tag_use_sequence;
`
}
