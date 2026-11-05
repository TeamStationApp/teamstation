import type { Migration } from '../runner'

export const migration107ChatUserBlocks: Migration = {
  name: '107chatUserBlocks',
  up: `
create table chat_user_blocks (
  blocker_user_id text not null references users(id),
  blocked_user_id text not null references users(id),
  created_at timestamptz not null default now(),
  primary key (blocker_user_id, blocked_user_id),
  check (blocker_user_id <> blocked_user_id)
);
create index chat_user_blocks_blocked on chat_user_blocks(blocked_user_id);
`,
  down: 'drop table chat_user_blocks;'
}
