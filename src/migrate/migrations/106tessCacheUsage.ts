import type { Migration } from '../runner'

/**
 * Tess's cache reads and writes kept apart from the week's input, so its hit
 * rate can be read; the turn a stop names, and the turn running; and the
 * plain-language details of a proposed change.
 */
export const migration106TessCacheUsage: Migration = {
  name: '106tessCacheUsage',
  up: `
alter table tess_usage_weeks
  add column cache_read_tokens bigint not null default 0,
  add column cache_write_tokens bigint not null default 0;
alter table tess_conversations
  add column turn_client_id text,
  add column turn_stop text;
alter table tess_changes add column details jsonb;
`,
  down: `
alter table tess_changes drop column details;
alter table tess_conversations
  drop column turn_stop,
  drop column turn_client_id;
alter table tess_usage_weeks
  drop column cache_write_tokens,
  drop column cache_read_tokens;
`
}
