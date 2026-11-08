import type { Migration } from '../runner'

export const migration113ScoringMutation: Migration = {
  name: '113scoringMutation',
  up: 'alter table games add column scoring_mutation jsonb;',
  down: 'alter table games drop column scoring_mutation;'
}
