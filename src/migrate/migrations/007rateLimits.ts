import type { Migration } from '../runner'

/**
 * One row per attempt at something worth limiting.
 *
 * Counting rows in a window, rather than keeping a counter, is deliberate: the
 * server runs a worker per core, so anything held in memory is divided by the
 * worker count and the real limit becomes whatever the load balancer happens to
 * do. A shared table is the only place the workers agree.
 *
 * Rows are pruned by the limiter itself — each write drops that key's rows older
 * than the window — so the table stays proportional to recent traffic rather
 * than growing forever, and no sweeper has to exist to keep it honest.
 *
 * `key` is an e-mail address or a client IP. Both identify a person, so nothing
 * here is kept longer than the window needs.
 */
export const migration007RateLimits: Migration = {
  name: '007rateLimits',
  up: `
create table rate_events (
  id text primary key,
  scope text not null,
  key text not null,
  at timestamptz not null default now()
);
create index rate_events_lookup on rate_events (scope, key, at desc);
`,
  down: `
drop table if exists rate_events;
`
}
