import type { Migration } from '../runner'

export const migration117ScoringAuthorship: Migration = {
  name: '117scoringAuthorship',
  // Who authored each stored scoring action, and who removed which: written
  // by the server with every write of a game's plays, never read from a
  // request, and holding no description text.
  up: 'alter table games add column if not exists scoring_authorship jsonb;',
  down: 'alter table games drop column scoring_authorship;'
}
