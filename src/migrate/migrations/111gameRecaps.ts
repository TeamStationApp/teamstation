import type { Migration } from '../runner'

export const migration111GameRecaps: Migration = {
  name: '111gameRecaps',
  up: `
create table game_recaps (
  game_id text primary key references games(id) on delete cascade,
  request_id text not null,
  digest text not null,
  context_digest text,
  status text not null check (status in ('pending', 'ready', 'failed')),
  attempts integer not null default 0 check (attempts between 0 and 3),
  available_at timestamptz not null default now(),
  lease_id text,
  document jsonb,
  check ((status = 'ready') = (document is not null))
);
create index game_recaps_pending on game_recaps(available_at) where status = 'pending';
`,
  down: 'drop table game_recaps;'
}
