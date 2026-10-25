import type { Migration } from '../runner'

/**
 * A game's guests and the players left off its lineups, kept under each
 * team's id rather than under home or away, so they stay with their team
 * when home and away are exchanged. Down keys them by side again, as the
 * game's teams stand.
 */
export const migration081TeamKeyedAvailability: Migration = {
  name: '081teamKeyedAvailability',
  up: `update games set
      guests = jsonb_build_object(
        away_team_id, coalesce(guests->'away', '[]'::jsonb),
        home_team_id, coalesce(guests->'home', '[]'::jsonb)),
      unrostered = jsonb_build_object(
        away_team_id, coalesce(unrostered->'away', '[]'::jsonb),
        home_team_id, coalesce(unrostered->'home', '[]'::jsonb));
    alter table games alter column guests set default '{}'::jsonb;
    alter table games alter column unrostered set default '{}'::jsonb;`,
  down: `update games set
      guests = jsonb_build_object(
        'away', coalesce(guests->away_team_id, '[]'::jsonb),
        'home', coalesce(guests->home_team_id, '[]'::jsonb)),
      unrostered = jsonb_build_object(
        'away', coalesce(unrostered->away_team_id, '[]'::jsonb),
        'home', coalesce(unrostered->home_team_id, '[]'::jsonb));
    alter table games alter column guests set default '{"away":[],"home":[]}'::jsonb;
    alter table games alter column unrostered set default '{"away":[],"home":[]}'::jsonb;`
}
