import type { Migration } from '../runner'

/**
 * A fan following a league, season or team: nothing more than a line on their
 * Home. It grants no access — what a follower sees is the public page.
 */
export const migration053Follows: Migration = {
  name: '053follows',
  up: `
create table follows (
  user_id bigint not null references users(id) on delete cascade,
  group_type text not null check (group_type in ('league','season','team')),
  group_id text not null,
  created_at timestamptz not null default now(),
  primary key (user_id, group_type, group_id)
);
create index follows_group on follows(group_type, group_id);
`,
  down: `
drop table follows;
`
}
