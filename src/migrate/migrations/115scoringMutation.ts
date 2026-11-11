import type { Migration } from '../runner'

export const migration115ScoringMutation: Migration = {
  name: '115scoringMutation',
  // Adopt the same column from earlier development builds without losing
  // accepted identities, and remove their obsolete rollback entry.
  up: `alter table games add column if not exists scoring_mutation jsonb;
delete from schema_migrations where name = '113scoringMutation';`,
  down: 'alter table games drop column scoring_mutation;'
}
