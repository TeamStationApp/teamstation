import type { Migration } from '../runner'

/**
 * Belonging to a **season** rather than to a team.
 *
 * PeerTube's channel allow-list is the model: 16 people were allowed to watch
 * the Spring QPLL channel without being on any team in it. Paul's rule
 * (2026-09-16) is that a season member sees every team in the season, while
 * being *on* a team is a different and stronger thing — the app shows your
 * teams above the seasons you can merely watch.
 *
 * `memberships` cannot express this: its `team_id` is not null, and giving a
 * spectator a membership on all five teams would put five teams at the top of
 * their home screen, which is precisely what Paul asked against.
 */
export const migration006SeasonMembers: Migration = {
  name: '006seasonMembers',
  up: `
create table season_members (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  season_id text not null references seasons (id) on delete cascade,
  role text not null default 'spectator'
    check (role in ('spectator', 'member')),
  source text not null default 'manual'
    check (source in ('peertube', 'import', 'manual')),
  joined_at timestamptz not null default now(),
  unique (user_id, season_id)
);
create index season_members_season on season_members (season_id);
`,
  down: `
drop table if exists season_members;
`
}
