import type { Migration } from '../runner'

/** Retain the highest active organizational grant and every owner membership. */
export const migration123CoveredAdmins: Migration = {
  name: '123coveredAdmins',
  up: `
    SELECT pg_advisory_xact_lock(hashtextextended('creation:parent-graph', 0));
    -- Before the ownership cutover a team's parents and league may still be
    -- reassigned, so only season grants are cleaned up then: a team keeps its
    -- grants until its parents are fixed.
    WITH permission_parents AS (
      SELECT season_id, team_id FROM season_team_parents
      WHERE EXISTS (SELECT 1 FROM system_settings
        WHERE key = 'creation.hierarchyReady' AND value = 'true'::jsonb)
    ), ancestors AS (
      SELECT 'season'::text AS child_type, id AS child_id,
        'league'::text AS parent_type, league_id AS parent_id FROM seasons
      UNION ALL
      SELECT 'team', id, 'league', league_id FROM teams
      WHERE EXISTS (SELECT 1 FROM system_settings
        WHERE key = 'creation.hierarchyReady' AND value = 'true'::jsonb)
      UNION ALL
      SELECT 'team', team_id, 'season', season_id FROM permission_parents
      UNION ALL
      SELECT 'team', p.team_id, 'league', s.league_id
      FROM permission_parents p JOIN seasons s ON s.id = p.season_id
    )
    DELETE FROM scope_roles child
    USING ancestors a, scope_roles parent, users u
    WHERE child.role = 'admin' AND parent.role = 'admin'
      AND child.scope_type = a.child_type AND child.scope_id = a.child_id
      AND parent.scope_type = a.parent_type AND parent.scope_id = a.parent_id
      AND parent.user_id = child.user_id AND u.id = child.user_id
      AND u.login_enabled = true AND u.disabled_at IS NULL
      AND u.merged_into IS NULL;
  `,
  // The removed grants have no provenance from which to restore them safely.
  down: 'select 1;'
}
