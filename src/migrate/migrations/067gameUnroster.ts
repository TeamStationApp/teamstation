import type { Migration } from '../runner'

/** All roster players start available; exclusions belong to this game only. */
export const migration067GameUnroster: Migration = {
  name: '067gameUnroster',
  up: `alter table games add column unrostered jsonb not null default '{"away":[],"home":[]}'::jsonb;
    create table game_guest_details (
      game_id text not null references games(id) on delete cascade,
      user_id bigint not null references users(id),
      jersey text,
      positions text[] not null default '{}',
      primary key (game_id, user_id)
    );`,
  down: 'drop table game_guest_details; alter table games drop column unrostered;'
}
