import type { Migration } from '../runner'

/**
 * A coach's per-inning game plan for one side of a game (`GamePlan` in
 * `src/common/gamePlan.ts`): whether the scorekeeper's game follows it, how
 * many innings it plans, and its rows as JSON, one per batter with a cell per
 * inning. One per team in a game; a game's delete takes its plans with it.
 * A team's plans are read together, for its season's history and its other
 * games that day, so they are indexed by team.
 *
 * Rolling back drops the table, and every plan with it.
 */
export const migration114GamePlans: Migration = {
  name: '114gamePlans',
  up: `
create table game_plans (
  game_id text not null references games(id) on delete cascade,
  team_id text not null references teams(id),
  enabled boolean not null default false,
  innings smallint not null check (innings between 1 and 12),
  rows jsonb not null,
  updated_at timestamptz not null default now(),
  updated_by text references users(id),
  primary key (game_id, team_id)
);
create index game_plans_team on game_plans(team_id);
`,
  down: 'drop table game_plans;'
}
