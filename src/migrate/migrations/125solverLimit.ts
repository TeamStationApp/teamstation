import type { Migration } from '../runner'

/**
 * The time a device's solver may spend on a league's build before it asks
 * whether to go on, when a test server sets one for the league (null keeps
 * the two minutes every server gives), and whether a stored preview was
 * proven the best schedule (null for one built before this was recorded).
 */
export const migration125SolverLimit: Migration = {
  name: '125solverLimit',
  up: `alter table league_schedule_setups add column solver_limit_ms integer check (solver_limit_ms > 0);
alter table schedule_previews add column proven_optimal boolean;`,
  down: `alter table schedule_previews drop column proven_optimal;
alter table league_schedule_setups drop column solver_limit_ms;`
}
