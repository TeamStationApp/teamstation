import type { Migration } from '../runner'

/** Game classification and local display time are independent of team identity. */
export const migration052SeasonGameRefinements: Migration = {
  name: '052seasonGameRefinements',
  up: `
alter table games add column exhibition boolean not null default false;
alter table games add column timezone text not null default 'UTC';
update games set timezone = seasons.timezone from seasons where seasons.id = games.season_id;
-- Keep the exact target host's approved legacy authorization before pruning its side.
update group_requests r set terms = r.terms || jsonb_build_object(
  'hostingAuthorizerUserId', s.approved_by,
  'hostingAuthorizationSource', 'legacyReceipt'
) from group_request_sides s
where r.id = s.request_id and r.kind = 'game' and r.status = 'pending'
  and s.scope_type = 'season' and s.scope_id = r.terms->'game'->>'seasonId'
  and s.approved_by is not null and s.approved_at is not null
  and r.terms->>'hostingAuthorizerUserId' is null;
-- Preserve one pending event identity through acceptance for pre-upgrade requests too.
update group_requests set terms = terms || jsonb_build_object(
  'proposedGameId', coalesce(terms->>'proposedGameId', game_id, terms->>'gameId', 'gam_' || replace(gen_random_uuid()::text, '-', '')),
  'replacesGameId', terms->'replacesGameId',
  'consentTeamIds', jsonb_build_array(terms->'game'->>'homeTeamId', terms->'game'->>'awayTeamId')
) where kind = 'game';
-- Existing pending games adopt two-participant consent without changing their terms/history.
delete from group_request_sides s using group_requests r
where s.request_id = r.id and r.kind = 'game' and r.status = 'pending'
  and (s.scope_type <> 'team' or s.scope_id not in
    (r.terms->'game'->>'homeTeamId', r.terms->'game'->>'awayTeamId'));
`,
  down: `
alter table games drop column exhibition, drop column timezone;
`
}
