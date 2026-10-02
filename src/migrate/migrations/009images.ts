import type { Migration } from '../runner'

/**
 * Where a team's, a league's or a person's picture came from.
 *
 * The `logo_path` and `avatar_path` columns have existed since `001identity`
 * and have never been written. A season gains one here, because an imported
 * organisation *is* a GameStation season — a league is the body above it,
 * which the import has no equivalent for — so the mark it serves belongs to
 * the season that shows it. What was missing was not somewhere to put the
 * key but the provenance beside it: without a hash, a re-import cannot tell a
 * picture that changed from one it has already fetched, and re-uploads every
 * face on every run.
 *
 * The path columns hold a key *prefix* — `images/team/tem_abc/1f4c2a90` — and
 * the size and extension are appended at read time, so one row serves both the
 * list tile and the profile. The hash is of the normalised bytes, not of what
 * the import sent, because the same photograph re-encoded is the same
 * picture and should not churn the key.
 */
export const migration009Images: Migration = {
  name: '009images',
  up: `
alter table teams
  add column logo_sha256 text,
  add column logo_source text
    check (logo_source in ('import', 'peertube', 'upload')),
  add column logo_updated_at timestamptz;

alter table seasons
  add column logo_path text,
  add column logo_sha256 text,
  add column logo_source text
    check (logo_source in ('import', 'peertube', 'upload')),
  add column logo_updated_at timestamptz;

alter table leagues
  add column logo_sha256 text,
  add column logo_source text
    check (logo_source in ('import', 'peertube', 'upload')),
  add column logo_updated_at timestamptz;

alter table users
  add column avatar_sha256 text,
  add column avatar_source text
    check (avatar_source in ('import', 'peertube', 'upload')),
  add column avatar_updated_at timestamptz;
`,
  down: `
alter table users
  drop column if exists avatar_updated_at,
  drop column if exists avatar_source,
  drop column if exists avatar_sha256;

alter table leagues
  drop column if exists logo_updated_at,
  drop column if exists logo_source,
  drop column if exists logo_sha256;

alter table seasons
  drop column if exists logo_updated_at,
  drop column if exists logo_source,
  drop column if exists logo_sha256,
  drop column if exists logo_path;

alter table teams
  drop column if exists logo_updated_at,
  drop column if exists logo_source,
  drop column if exists logo_sha256;
`
}
