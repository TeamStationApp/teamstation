import type { Migration } from '../runner'

/**
 * A change that is made at once and told to the people who would have
 * approved it, who may then reject it: the `applied` request. Its first use is
 * `playerAdd`, a coach putting a player who already exists on their roster or
 * into one game.
 *
 * A guest of a game who already existed before it is a pool player
 * (`game_guest_details.pool`): playing as one shows on the team's stats but
 * lets nobody open the player's page who could not before.
 *
 * `game_withdrawn_players` keeps the games a rejected add had already been
 * played in: the game still adds up, under `label` in place of the person,
 * and the person's own record leaves it out.
 *
 * Rolling back is refused while any request is a `playerAdd` or `applied`,
 * since the old checks would no longer hold them.
 */
export const migration097NoticeRequests: Migration = {
  name: '097noticeRequests',
  up: `
alter table group_requests drop constraint group_requests_kind_check;
alter table group_requests add constraint group_requests_kind_check
  check (kind in ('parent','participation','promotion','person','guardian',
                  'membership','game','gameChange','playerAdd'));
alter table group_requests drop constraint group_requests_status_check;
alter table group_requests add constraint group_requests_status_check
  check (status in ('pending','accepted','declined','expired','cancelled',
                    'superseded','applied'));
alter table game_guest_details add column pool boolean not null default false;
create table game_withdrawn_players (
  game_id text not null references games(id) on delete cascade,
  user_id text not null references users(id),
  side text not null check (side in ('away','home')),
  request_id text not null references group_requests(id) on delete cascade,
  label text not null,
  withdrawn_at timestamptz not null default now(),
  primary key (game_id, user_id)
);
create index game_withdrawn_players_user on game_withdrawn_players (user_id);
`,
  down: `
do $refuse$ begin
  if exists (select 1 from group_requests
              where kind = 'playerAdd' or status = 'applied') then
    raise exception 'Player additions are recorded as requests; remove them before rolling this back';
  end if;
end $refuse$;
drop table game_withdrawn_players;
alter table game_guest_details drop column pool;
alter table group_requests drop constraint group_requests_status_check;
alter table group_requests add constraint group_requests_status_check
  check (status in ('pending','accepted','declined','expired','cancelled',
                    'superseded'));
alter table group_requests drop constraint group_requests_kind_check;
alter table group_requests add constraint group_requests_kind_check
  check (kind in ('parent','participation','promotion','person','guardian',
                  'membership','game','gameChange'));
`
}
