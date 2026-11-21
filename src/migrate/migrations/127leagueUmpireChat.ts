import type { Migration } from '../runner'

/**
 * A league's umpire chat (`leagueUmpires`), kept by the chat reconciler like
 * the other scope chats: its umpires who are accepted into the league, while
 * it manages umpires.
 *
 * - The conversation kind is allowed.
 * - Granting, changing or taking away the umpire role marks the person: their
 *   umpire chats are reconciled, and nothing else of the league reads the
 *   role. Turning umpire management on or off marks the league, beside the
 *   SafeSport setting the leagues trigger already watched.
 * - Deleting a season, or moving it to another league, marks the league it
 *   left: acceptance into a league reads its seasons.
 * - A site administrator is accepted into every league, so becoming one or
 *   ceasing to be marks the person.
 * - Every league that manages umpires now is marked, so its chat is made at
 *   the next drain.
 * - A push registration keeps the newer chat kinds its app named when it
 *   registered (`x-teamstation-chat-kinds`): a wake of such a chat goes only
 *   to a device whose app can open it, as only it lists the chat.
 *
 * Down deletes the umpire chats (their members, log and epochs go with
 * them) and puts the kind check and the leagues trigger back as they were.
 */
export const migration127LeagueUmpireChat: Migration = {
  name: '127leagueUmpireChat',
  up: `
alter table chat_conversations drop constraint chat_conversations_kind_check;
alter table chat_conversations add constraint chat_conversations_kind_check
  check (kind in (
    'teamStaff', 'teamMembers', 'teamFans',
    'seasonStaff', 'seasonAllStaff', 'seasonAnnouncements',
    'leagueOrg', 'leagueUmpires', 'dm'
  ));

create trigger chat_dirty_league_umpires
  after insert or update or delete on league_umpires
  for each row execute function chat_dirty_row('user:user_id');

create trigger chat_dirty_users_site_admin after update on users
  for each row when (old.is_admin is distinct from new.is_admin)
  execute function chat_dirty_row('user:id');

create trigger chat_dirty_seasons_league_deleted after delete on seasons
  for each row execute function chat_dirty_row('league:league_id');
create trigger chat_dirty_seasons_league_moved after update on seasons
  for each row when (old.league_id is distinct from new.league_id)
  execute function chat_dirty_row('league:league_id');

drop trigger chat_dirty_leagues on leagues;
create trigger chat_dirty_leagues after update on leagues
  for each row when (
    old.safesport_lao is distinct from new.safesport_lao
    or old.umpire_management is distinct from new.umpire_management
  )
  execute function chat_dirty_row('league:id');

select chat_mark_dirty('league', id) from leagues where umpire_management;

alter table push_registrations
  add column chat_kinds text[] not null default '{}';
`,
  down: `
alter table push_registrations drop column chat_kinds;

delete from chat_conversations where kind = 'leagueUmpires';

drop trigger chat_dirty_leagues on leagues;
create trigger chat_dirty_leagues after update on leagues
  for each row when (old.safesport_lao is distinct from new.safesport_lao)
  execute function chat_dirty_row('league:id');

drop trigger chat_dirty_users_site_admin on users;
drop trigger chat_dirty_seasons_league_moved on seasons;
drop trigger chat_dirty_seasons_league_deleted on seasons;
drop trigger chat_dirty_league_umpires on league_umpires;

alter table chat_conversations drop constraint chat_conversations_kind_check;
alter table chat_conversations add constraint chat_conversations_kind_check
  check (kind in (
    'teamStaff', 'teamMembers', 'teamFans',
    'seasonStaff', 'seasonAllStaff', 'seasonAnnouncements',
    'leagueOrg', 'dm'
  ));
`
}
