import type { Migration } from '../runner'

/**
 * Following a team: anybody signed in may, with nobody's permission.
 *
 * A follow is one row per person and team. It grants the team's schedule,
 * roster and staff, and nothing else of it; `visibleScopes` reads it as
 * `followedTeamIds`, apart from the teams a person is on.
 *
 * A row goes with its person or its team. A team merge moves its follows to
 * the survivor (`mergeTeams`). Down drops the table.
 */
export const migration050TeamFollows: Migration = {
  name: '050teamFollows',
  up: `
create table team_follows (
  user_id    bigint      not null references users(id) on delete cascade,
  team_id    text        not null references teams(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (user_id, team_id)
);
create index team_follows_team on team_follows (team_id);
`,
  down: `
drop table team_follows;
`
}
