import type { Migration } from '../runner'

/**
 * A version per team for the rows its roster's core is built from, so a
 * cached core is read under the version it was built at and no later one.
 *
 * - `team_roster_bumps` holds one row per bump, and a team's version is its
 *   newest row's. Rows are only ever added, so two writers of the same team
 *   never lock one row: a transaction of several statements over several
 *   teams waits for nobody's bump and cannot deadlock on them. It has no
 *   foreign key. A team's delete cascades to its memberships and songs, whose
 *   triggers find the team row gone and bump nothing; an `after delete`
 *   trigger on `teams` takes the team's rows away, so a team recreated with
 *   the same id reads directly until its first membership gives it a version.
 *   Each row is stamped with the time it is written (`clock_timestamp()`),
 *   not its transaction's start. Rows that are not their team's newest are
 *   pruned in the background once that stamp is ten minutes old
 *   (`pruneRosterBumps`): readers read only the newest row, and an entry is
 *   stored only by a read outside a transaction that found no bump of the
 *   team open, so no read or store needs the older rows.
 * - Every bump takes its value from `team_roster_version_seq`, so a version
 *   is never used twice, even after the table is emptied.
 * - Every bump also holds a shared advisory key on its team until it commits
 *   (`rosterBumpKey`). Shared holds never wait for each other. A reader that
 *   finds a key held knows a bump of the team may still commit under a
 *   version lower than the newest it sees, so it stores no entry
 *   (`teamRosterCore`). A read inside a transaction never stores its own
 *   rows: a bump that committed after its snapshot began is neither seen nor
 *   held, so it has a refresh outside the transaction store the team's.
 * - `roster_cache_epoch` is one random id per database, part of every cache
 *   key, so a recreated database never reads an earlier one's entries. A
 *   database restored from a backup or a point-in-time copy keeps the epoch
 *   it had, but Valkey is not restored with it, and its sequence, wound back
 *   to the restore point, hands out versions already used: each would find an
 *   entry built from rows the restored database does not hold. So before a
 *   restored database serves, run `npm run roster-cache-epoch`
 *   (`src/server/dev/rosterCacheEpoch.ts`), which gives it a new epoch, or
 *   flush the `roster:` keys under its prefix from Valkey.
 *
 * Statement-level triggers with transition tables bump every team a
 * statement touched in one call to `ts_bump_team_rosters`. The `users` and
 * `gumbo_ids` triggers bump every team the person is a member of. The `users`
 * comparison names the columns `ROSTER_USER_COLUMNS` lists
 * (`src/server/teams/rosterCore.ts`): those the member query selects and
 * filters by.
 *
 * Those two find the person's teams in `memberships` as their statement sees
 * it, which leaves out a membership another transaction has written and not
 * yet committed. So each waits for the other on the person's `users` row, a
 * row lock, which costs no slot in the shared lock table however many people
 * a statement names, and holds nothing beyond those people:
 *
 * - The `memberships` triggers take `for key share`, in id order, on every
 *   person a row of theirs newly places on a team (each inserted row, and an
 *   updated row whose person or team changed), before they bump; an inserted
 *   row's foreign key takes the same. `for key share` conflicts only with
 *   `for update`, so a membership write never waits on it for another
 *   membership write, an import or a merge holding the person
 *   `for no key update`, or a player's gumbo id allocation. A row that keeps
 *   its person and team, and a deleted row, take nothing: a rename sees that
 *   row in any case, committed or not, and bumps its team.
 * - The `users` trigger takes `for update`, in id order, on every person a
 *   `ROSTER_USER_COLUMNS` column changed for, and the `gumbo_ids` triggers on
 *   the rows' people, before they read `memberships`. The update's own
 *   `for no key update` does not conflict with `for key share`, so it is this
 *   lock that makes the two wait. It also waits for any open transaction
 *   that wrote a row referencing the person by a foreign key, and makes such
 *   a write wait, until it commits.
 *
 * A membership written while a rename of the person is open waits for the
 * rename to commit before it bumps, so any read after its bump reads the new
 * name. A rename made while a membership of the person is open waits for that
 * membership to commit; its trigger then reads `memberships` in a statement
 * of its own, which in a read committed transaction takes a new snapshot,
 * sees the membership, and bumps its team. A rename in a repeatable read or
 * serializable transaction does not: it waits the same, then reads with the
 * snapshot its transaction began with, misses the membership and commits
 * without error, leaving that team's entry with the old name until its next
 * bump or its TTL. Every repeatable read transaction here only reads, and
 * none is serializable. A membership written in a repeatable read
 * transaction waits for an open rename the same way and bumps once it
 * commits.
 *
 * The order is memberships, then users, as the player gumbo id allocation
 * (`ts_ensure_gumbo_id`, migrations 069 and 070) already takes them for a
 * player's membership; that allocation is the only writer of `gumbo_ids`,
 * and it takes the person's row before it writes theirs. The waits this adds
 * are between a write that references a person by a foreign key (a
 * membership among them) and a rename or gumbo id write of that person,
 * which waits for `for update` while its update holds the row
 * `for no key update`. Postgres aborts one of the two as a deadlock (40P01)
 * only if the first then wants that row itself (it updates the person, or
 * locks them as an import or a player's settings do) or something else the
 * second holds: two transactions that each rename one person and then write
 * the other's membership, say. The writers that change people and
 * memberships together take those rows or keys first:
 *
 * - A team merge takes its two teams' people `for no key update`, then their
 *   memberships, and renames nobody: it waits for no membership write, and a
 *   rename of one of its people waits for it in its update.
 * - An import takes its existing people `for no key update`, then writes
 *   their memberships. A new hand or gumbo id waits for an open membership
 *   of the person on another team, whose writer waits for nothing the import
 *   holds unless it then changes the person too.
 * - An account merge takes its people `for update`, which already waits for
 *   every open write that references them, before any membership.
 * - A player's settings take the person's row before their membership, and
 *   the roster writers take the merge key (`lockPlayerEdits`) and their
 *   team's key (`lockTeams`) shared before any row.
 */
export const migration109TeamRosterVersions: Migration = {
  name: '109teamRosterVersions',
  up: `
create table team_roster_bumps (
  team_id text not null,
  version bigint not null,
  bumped_at timestamptz not null default clock_timestamp(),
  primary key (team_id, version)
);
create sequence team_roster_version_seq;
create table roster_cache_epoch (epoch text not null);
create unique index roster_cache_epoch_one on roster_cache_epoch ((true));
insert into roster_cache_epoch (epoch) values (gen_random_uuid()::text);
insert into team_roster_bumps (team_id, version)
  select id, nextval('team_roster_version_seq') from teams order by id;

create function ts_bump_team_rosters(team_ids text[]) returns void
language plpgsql as $$
begin
  perform pg_advisory_xact_lock_shared(
    hashtextextended('rosterBump:' || teams.id, 0)
  )
  from teams
  where teams.id = any(team_ids)
  order by teams.id;
  insert into team_roster_bumps (team_id, version)
  select teams.id, nextval('team_roster_version_seq')
  from teams
  where teams.id = any(team_ids)
  order by teams.id;
end
$$;

create function ts_memberships_roster_bump() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    perform 1 from users
    where users.id = any(array(select user_id from new_rows))
    order by users.id
    for key share;
    perform ts_bump_team_rosters(array(select distinct team_id from new_rows));
  elsif tg_op = 'DELETE' then
    perform ts_bump_team_rosters(array(select distinct team_id from old_rows));
  else
    perform 1 from users
    where users.id = any(array(
      select new_rows.user_id
      from new_rows
      left join old_rows on old_rows.id = new_rows.id
        and old_rows.user_id = new_rows.user_id
        and old_rows.team_id = new_rows.team_id
      where old_rows.id is null
    ))
    order by users.id
    for key share;
    perform ts_bump_team_rosters(array(
      select team_id from new_rows union select team_id from old_rows
    ));
  end if;
  return null;
end
$$;

create function ts_team_rows_roster_bump() returns trigger
language plpgsql as $$
begin
  if tg_op = 'INSERT' then
    perform ts_bump_team_rosters(array(select distinct team_id from new_rows));
  elsif tg_op = 'DELETE' then
    perform ts_bump_team_rosters(array(select distinct team_id from old_rows));
  else
    perform ts_bump_team_rosters(array(
      select team_id from new_rows union select team_id from old_rows
    ));
  end if;
  return null;
end
$$;

create function ts_users_roster_bump() returns trigger
language plpgsql as $$
declare
  people text[];
begin
  people := array(
    select new_rows.id
    from new_rows
    inner join old_rows on old_rows.id = new_rows.id
    where (
      old_rows.display_name, old_rows.first_name, old_rows.last_name,
      old_rows.bats, old_rows.throws, old_rows.avatar_path,
      old_rows.merged_into
    ) is distinct from (
      new_rows.display_name, new_rows.first_name, new_rows.last_name,
      new_rows.bats, new_rows.throws, new_rows.avatar_path,
      new_rows.merged_into
    )
  );
  if cardinality(people) = 0 then
    return null;
  end if;
  perform 1 from users
  where users.id = any(people)
  order by users.id
  for update;
  perform ts_bump_team_rosters(array(
    select distinct memberships.team_id
    from memberships
    where memberships.user_id = any(people)
  ));
  return null;
end
$$;

create function ts_gumbo_ids_roster_bump() returns trigger
language plpgsql as $$
declare
  people text[];
begin
  if tg_op = 'INSERT' then
    people := array(select user_id from new_rows);
  else
    people := array(
      select user_id from new_rows union select user_id from old_rows
    );
  end if;
  perform 1 from users
  where users.id = any(people)
  order by users.id
  for update;
  perform ts_bump_team_rosters(array(
    select distinct memberships.team_id
    from memberships
    where memberships.user_id = any(people)
  ));
  return null;
end
$$;

create function ts_forget_team_roster_versions() returns trigger
language plpgsql as $$
begin
  delete from team_roster_bumps
  where team_id in (select id from old_rows);
  return null;
end
$$;

create trigger memberships_roster_inserted after insert on memberships
referencing new table as new_rows
for each statement execute function ts_memberships_roster_bump();
create trigger memberships_roster_updated after update on memberships
referencing old table as old_rows new table as new_rows
for each statement execute function ts_memberships_roster_bump();
create trigger memberships_roster_deleted after delete on memberships
referencing old table as old_rows
for each statement execute function ts_memberships_roster_bump();

create trigger walk_up_songs_roster_inserted after insert on walk_up_songs
referencing new table as new_rows
for each statement execute function ts_team_rows_roster_bump();
create trigger walk_up_songs_roster_updated after update on walk_up_songs
referencing old table as old_rows new table as new_rows
for each statement execute function ts_team_rows_roster_bump();
create trigger walk_up_songs_roster_deleted after delete on walk_up_songs
referencing old table as old_rows
for each statement execute function ts_team_rows_roster_bump();

create trigger users_roster_updated after update on users
referencing old table as old_rows new table as new_rows
for each statement execute function ts_users_roster_bump();

create trigger gumbo_ids_roster_inserted after insert on gumbo_ids
referencing new table as new_rows
for each statement execute function ts_gumbo_ids_roster_bump();
create trigger gumbo_ids_roster_updated after update on gumbo_ids
referencing old table as old_rows new table as new_rows
for each statement execute function ts_gumbo_ids_roster_bump();

create trigger teams_roster_version_forget after delete on teams
referencing old table as old_rows
for each statement execute function ts_forget_team_roster_versions();
`,
  down: `
drop trigger teams_roster_version_forget on teams;
drop trigger gumbo_ids_roster_updated on gumbo_ids;
drop trigger gumbo_ids_roster_inserted on gumbo_ids;
drop trigger users_roster_updated on users;
drop trigger walk_up_songs_roster_deleted on walk_up_songs;
drop trigger walk_up_songs_roster_updated on walk_up_songs;
drop trigger walk_up_songs_roster_inserted on walk_up_songs;
drop trigger memberships_roster_deleted on memberships;
drop trigger memberships_roster_updated on memberships;
drop trigger memberships_roster_inserted on memberships;
drop function ts_forget_team_roster_versions();
drop function ts_gumbo_ids_roster_bump();
drop function ts_users_roster_bump();
drop function ts_team_rows_roster_bump();
drop function ts_memberships_roster_bump();
drop function ts_bump_team_rosters(text[]);
drop table roster_cache_epoch;
drop sequence team_roster_version_seq;
drop table team_roster_bumps;
`
}
