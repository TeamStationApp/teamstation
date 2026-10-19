import type { Migration } from '../runner'

/** All roster players start available; exclusions belong to this game only. */
export const migration067GameUnroster: Migration = {
  name: '067gameUnroster',
  up: `alter table games add column unrostered jsonb not null default '{"away":[],"home":[]}'::jsonb;`,
  down: 'alter table games drop column unrostered;'
}
