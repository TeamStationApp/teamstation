import type { Migration } from '../runner'

/**
 * A team that turned out to be a team we already had.
 *
 * A scorekeeping service gives every club its own account, and a club only
 * enters the teams it plays as opponents — so one real team exists once as
 * itself and again, under whatever name the opposition typed, inside each
 * opponent's account. `AAA Hawks` and `NP5 Hardy` are the same eleven children.
 *
 * That matters beyond tidiness, because the two copies hold *different halves
 * of the same game*: the club that scored the game has the plays, and the club
 * that recorded it has the video. Neither game row is complete on its own.
 *
 * `merged_into` mirrors the column on `users`, and for the same reason: the
 * row stays, so an id already handed out still resolves and the history of
 * what was joined to what is not thrown away.
 */
export const migration008MergedTeams: Migration = {
  name: '008mergedTeams',
  up: `
alter table teams
  add column merged_into text references teams (id) on delete set null;
create index teams_merged_into on teams (merged_into)
  where merged_into is not null;
`,
  down: `
drop index if exists teams_merged_into;
alter table teams drop column if exists merged_into;
`
}
