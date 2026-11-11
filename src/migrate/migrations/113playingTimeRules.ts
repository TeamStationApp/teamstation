import type { Migration } from '../runner'

/**
 * A season's and a team's Playing Time Rules, the whole set as JSON
 * (`PlayingTimeRules` in `src/common/playingTimeRules.ts`). Null on a season
 * is no rules; null on a team follows its managing season's. A team that
 * overrides stores a full copy, so a later change to the season never
 * reaches it.
 *
 * Rolling back drops both columns, and every season and team has no rules.
 */
export const migration113PlayingTimeRules: Migration = {
  name: '113playingTimeRules',
  up: `
alter table seasons add column playing_time_rules jsonb;
alter table teams add column playing_time_rules jsonb;
`,
  down: `
alter table seasons drop column playing_time_rules;
alter table teams drop column playing_time_rules;
`
}
