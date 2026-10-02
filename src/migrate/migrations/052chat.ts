import type { Migration } from '../runner'

/**
 * End-to-end encrypted chat: the tables, and the triggers that say which
 * chats need their members worked out again.
 *
 * **Keys.** A device (`chat_devices`) is bound to the session that registered
 * or resumed it. A user's identity (`chat_identities`, at most one current,
 * the rest `replaced_at`) signs their per-user keys (`chat_user_keys`, by
 * generation), which are boxed to each linked device (`chat_user_key_boxes`).
 * `chat_links` carries the identity from a linked device to a new one.
 *
 * **Conversations.** A scope chat is one per `(kind, scope_id)`; a DM has no
 * scope. `last_seq` and `last_log_seq` count the messages and the membership
 * log rows: each new row takes its `seq` from `update … set last_seq =
 * last_seq + 1 returning`. `chat_members` is who is in it now (and who left),
 * `chat_membership_log` the hash-chained record of every change.
 *
 * **Epochs.** `chat_epochs` holds each epoch's previous key under its own key
 * (`previous_key_box`), absent on the first epoch and on a `chain_break`, when
 * no member still held the key. `chat_epoch_boxes` wraps an epoch key to a
 * member's per-user key; `chat_grant_requests` asks for one, and is closed by
 * `filled_at` or, at a chain break, `superseded_at`.
 *
 * **Messages.** `chat_messages` holds ciphertext only, under a client-made
 * `msg_` id, signed by `sender_identity_id`. Only the two delete kinds say
 * what they point at (`target_ids`). Attachments, read cursors and reports
 * hang off them; a report keeps its own copy of the message (`envelope`).
 *
 * **Membership upkeep.** `chat_dirty` holds one row per team, season, league
 * or user whose chats may have changed. Row triggers on every table an
 * audience is read from upsert it and `pg_notify('chat_dirty', '')`; an
 * update marks what the old row and the new row name, so a row moved to
 * another team or user marks both. The upsert rewrites `marked_at`, which
 * locks the row until the writer commits, so the reconciler's `delete …
 * returning` waits for that writer rather than taking the mark and reading
 * the data before it is visible. Every unmerged full team, every season and
 * every league is marked here, so data from before this migration gets its
 * chats on the reconciler's first run.
 *
 * Down drops all of it.
 */
export const migration052Chat: Migration = {
  name: '052chat',
  up: `
create table chat_devices (
  id              text        primary key,
  user_id         bigint      not null references users (id) on delete cascade,
  session_id      text        references auth_sessions (id) on delete set null,
  name            text        not null,
  platform        text        not null check (platform in ('web', 'ios', 'android')),
  box_public_key  bytea       not null,
  sign_public_key bytea       not null,
  created_at      timestamptz not null default now(),
  last_seen_at    timestamptz not null default now(),
  revoked_at      timestamptz
);
create index chat_devices_user on chat_devices (user_id);
create index chat_devices_session on chat_devices (session_id);

create table chat_identities (
  id                  text        primary key,
  user_id             bigint      not null references users (id) on delete cascade,
  identity_public_key bytea       not null,
  created_at          timestamptz not null default now(),
  replaced_at         timestamptz,
  unique (id, user_id)
);
create unique index chat_identities_current on chat_identities (user_id)
  where replaced_at is null;

create table chat_user_keys (
  user_id           bigint      not null,
  identity_id       text        not null,
  generation        integer     not null check (generation >= 1),
  public_key        bytea       not null,
  signature         bytea       not null,
  previous_keys_box bytea,
  created_at        timestamptz not null default now(),
  primary key (user_id, identity_id, generation),
  foreign key (identity_id, user_id)
    references chat_identities (id, user_id) on delete cascade
);

create table chat_user_key_boxes (
  user_id     bigint      not null,
  identity_id text        not null,
  generation  integer     not null,
  device_id   text        not null references chat_devices (id) on delete cascade,
  box         bytea       not null,
  created_at  timestamptz not null default now(),
  primary key (user_id, identity_id, generation, device_id),
  foreign key (user_id, identity_id, generation)
    references chat_user_keys (user_id, identity_id, generation) on delete cascade
);
create index chat_user_key_boxes_device on chat_user_key_boxes (device_id);

create table chat_links (
  id                    text        primary key,
  user_id               bigint      not null references users (id) on delete cascade,
  new_device_id         text        not null references chat_devices (id) on delete cascade,
  approved_by_device_id text        references chat_devices (id) on delete set null,
  box                   bytea,
  created_at            timestamptz not null default now(),
  expires_at            timestamptz not null
);
create index chat_links_user on chat_links (user_id);

create table chat_conversations (
  id             text        primary key,
  kind           text        not null check (kind in (
    'teamStaff', 'teamMembers', 'teamFans',
    'seasonStaff', 'seasonAllStaff', 'seasonAnnouncements',
    'leagueOrg', 'dm'
  )),
  scope_type     text,
  scope_id       text,
  created_by     bigint      references users (id) on delete set null,
  needs_rotation boolean     not null default false,
  closed_at      timestamptz,
  last_seq       bigint      not null default 0,
  last_log_seq   bigint      not null default 0,
  created_at     timestamptz not null default now(),
  constraint chat_conversations_scope_of_kind check (
    case
      when kind = 'dm' then scope_type is null and scope_id is null
      when kind like 'team%' then scope_type = 'team' and scope_id is not null
      when kind like 'season%' then scope_type = 'season' and scope_id is not null
      else scope_type = 'league' and scope_id is not null
    end
  )
);
create unique index chat_conversations_scope
  on chat_conversations (scope_id, kind) where scope_id is not null;

create table chat_members (
  conversation_id text        not null references chat_conversations (id) on delete cascade,
  user_id         bigint      not null references users (id) on delete cascade,
  joined_at       timestamptz not null default now(),
  left_at         timestamptz,
  created_at      timestamptz not null default now(),
  primary key (conversation_id, user_id)
);
create index chat_members_user on chat_members (user_id);

create table chat_membership_log (
  conversation_id text        not null references chat_conversations (id) on delete cascade,
  seq             bigint      not null check (seq >= 1),
  event           text        not null check (event in ('join', 'leave', 'identityReset', 'closed')),
  user_id         bigint      not null references users (id),
  actor_user_id   bigint      references users (id),
  reason          text,
  prev_hash       bytea       not null check (octet_length(prev_hash) = 32),
  hash            bytea       not null check (octet_length(hash) = 32),
  at              timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  primary key (conversation_id, seq)
);

create table chat_epochs (
  conversation_id    text        not null references chat_conversations (id) on delete cascade,
  epoch              integer     not null check (epoch >= 1),
  created_by_user_id bigint      not null,
  identity_id        text        not null,
  previous_key_box   bytea,
  chain_break        boolean     not null default false,
  signature          bytea       not null,
  created_at         timestamptz not null default now(),
  primary key (conversation_id, epoch),
  foreign key (identity_id, created_by_user_id)
    references chat_identities (id, user_id),
  constraint chat_epochs_chain check (
    case
      when epoch = 1 then previous_key_box is null and not chain_break
      else (previous_key_box is null) = chain_break
    end
  )
);

create table chat_epoch_boxes (
  conversation_id    text        not null,
  epoch              integer     not null,
  user_id            bigint      not null,
  identity_id        text        not null,
  generation         integer     not null,
  box                bytea       not null,
  granted_by_user_id bigint      references users (id),
  created_at         timestamptz not null default now(),
  primary key (conversation_id, epoch, user_id, identity_id, generation),
  foreign key (conversation_id, epoch)
    references chat_epochs (conversation_id, epoch) on delete cascade,
  foreign key (user_id, identity_id, generation)
    references chat_user_keys (user_id, identity_id, generation) on delete cascade
);
create index chat_epoch_boxes_user on chat_epoch_boxes (user_id);

create table chat_grant_requests (
  id              bigint      generated always as identity primary key,
  conversation_id text        not null references chat_conversations (id) on delete cascade,
  user_id         bigint      not null,
  identity_id     text        not null,
  generation      integer     not null,
  identity_reset  boolean     not null default false,
  opened_at       timestamptz not null default now(),
  filled_at       timestamptz,
  superseded_at   timestamptz,
  created_at      timestamptz not null default now(),
  foreign key (user_id, identity_id, generation)
    references chat_user_keys (user_id, identity_id, generation) on delete cascade
);
create unique index chat_grant_requests_open
  on chat_grant_requests (conversation_id, user_id, identity_id, generation)
  where filled_at is null and superseded_at is null;
create index chat_grant_requests_user on chat_grant_requests (user_id);

create table chat_messages (
  id                 text        primary key check (id ~ '^msg_[a-z2-7]{26}$'),
  conversation_id    text        not null,
  seq                bigint      not null check (seq >= 1),
  epoch              integer     not null,
  sender_user_id     bigint      not null,
  sender_identity_id text        not null,
  kind               text        not null check (kind in ('post', 'reaction', 'edit', 'delete', 'moderatorDelete')),
  target_ids         text[],
  nonce              bytea       not null,
  ciphertext         bytea       not null,
  signature          bytea       not null,
  cleared_at         timestamptz,
  created_at         timestamptz not null default now(),
  unique (conversation_id, seq),
  foreign key (conversation_id, epoch)
    references chat_epochs (conversation_id, epoch) on delete cascade,
  foreign key (sender_identity_id, sender_user_id)
    references chat_identities (id, user_id),
  constraint chat_messages_targets check (
    (kind in ('delete', 'moderatorDelete')) = (target_ids is not null)
  )
);

create table chat_attachments (
  id               text        primary key,
  conversation_id  text        not null references chat_conversations (id) on delete cascade,
  uploader_user_id bigint      not null references users (id),
  size             bigint      not null check (size >= 0),
  object_key       text        not null,
  digest           bytea       not null check (octet_length(digest) = 32),
  completed_at     timestamptz,
  created_at       timestamptz not null default now()
);
create index chat_attachments_conversation on chat_attachments (conversation_id);
create index chat_attachments_created on chat_attachments (created_at);

create table chat_message_attachments (
  message_id    text        not null references chat_messages (id) on delete cascade,
  attachment_id text        not null references chat_attachments (id) on delete cascade,
  created_at    timestamptz not null default now(),
  primary key (message_id, attachment_id)
);
create index chat_message_attachments_attachment
  on chat_message_attachments (attachment_id);

create table chat_read_cursors (
  conversation_id text        not null references chat_conversations (id) on delete cascade,
  user_id         bigint      not null references users (id) on delete cascade,
  seq             bigint      not null default 0,
  at              timestamptz not null default now(),
  created_at      timestamptz not null default now(),
  primary key (conversation_id, user_id)
);

create table chat_reports (
  id               text        primary key,
  conversation_id  text        not null references chat_conversations (id) on delete cascade,
  message_id       text        not null references chat_messages (id) on delete cascade,
  reporter_user_id bigint      not null references users (id),
  envelope         jsonb       not null,
  message_key      bytea       not null,
  plaintext        text        not null,
  verified         boolean     not null,
  created_at       timestamptz not null default now(),
  resolved_at      timestamptz
);
create index chat_reports_message on chat_reports (message_id);
create index chat_reports_open on chat_reports (created_at)
  where resolved_at is null;

create table chat_dirty (
  scope_type text        not null check (scope_type in ('team', 'season', 'league', 'user')),
  scope_id   text        not null,
  marked_at  timestamptz not null default now(),
  primary key (scope_type, scope_id)
);

create function chat_mark_dirty(kind text, id text) returns void
language plpgsql as $$
begin
  if id is null then
    return;
  end if;
  insert into chat_dirty (scope_type, scope_id, marked_at)
  values (kind, id, now())
  on conflict (scope_type, scope_id) do update
    set marked_at = excluded.marked_at
    where chat_dirty.marked_at is distinct from excluded.marked_at;
  perform pg_notify('chat_dirty', '');
end
$$;

-- Each argument is '<scope type>:<column>': the scope the column's value
-- names. Marks the old row's and the new row's.
create function chat_dirty_row() returns trigger
language plpgsql as $$
declare
  arg text;
begin
  foreach arg in array tg_argv loop
    if tg_op <> 'DELETE' then
      perform chat_mark_dirty(
        split_part(arg, ':', 1), to_jsonb(new) ->> split_part(arg, ':', 2)
      );
    end if;
    if tg_op <> 'INSERT' then
      perform chat_mark_dirty(
        split_part(arg, ':', 1), to_jsonb(old) ->> split_part(arg, ':', 2)
      );
    end if;
  end loop;
  return null;
end
$$;

-- A role's scope type is in the row itself.
create function chat_dirty_scope_role() returns trigger
language plpgsql as $$
begin
  if tg_op <> 'DELETE' then
    perform chat_mark_dirty(new.scope_type, new.scope_id);
    perform chat_mark_dirty('user', new.user_id::text);
  end if;
  if tg_op <> 'INSERT' then
    perform chat_mark_dirty(old.scope_type, old.scope_id);
    perform chat_mark_dirty('user', old.user_id::text);
  end if;
  return null;
end
$$;

create trigger chat_dirty_memberships after insert or delete on memberships
  for each row execute function chat_dirty_row('team:team_id', 'user:user_id');
create trigger chat_dirty_memberships_update after update on memberships
  for each row
  when ((old.team_id, old.user_id, old.role, old.is_player)
    is distinct from (new.team_id, new.user_id, new.role, new.is_player))
  execute function chat_dirty_row('team:team_id', 'user:user_id');

create trigger chat_dirty_scope_roles after insert or delete on scope_roles
  for each row execute function chat_dirty_scope_role();
create trigger chat_dirty_scope_roles_update after update on scope_roles
  for each row
  when ((old.scope_type, old.scope_id, old.user_id, old.role)
    is distinct from (new.scope_type, new.scope_id, new.user_id, new.role))
  execute function chat_dirty_scope_role();

create trigger chat_dirty_team_follows after insert or delete on team_follows
  for each row execute function chat_dirty_row('team:team_id', 'user:user_id');
create trigger chat_dirty_team_follows_update after update on team_follows
  for each row
  when ((old.team_id, old.user_id) is distinct from (new.team_id, new.user_id))
  execute function chat_dirty_row('team:team_id', 'user:user_id');

create trigger chat_dirty_season_members after insert or delete on season_members
  for each row execute function chat_dirty_row('season:season_id');
create trigger chat_dirty_season_members_update after update on season_members
  for each row
  when ((old.season_id, old.user_id, old.role)
    is distinct from (new.season_id, new.user_id, new.role))
  execute function chat_dirty_row('season:season_id');

create trigger chat_dirty_league_members after insert or delete on league_members
  for each row execute function chat_dirty_row('league:league_id');
create trigger chat_dirty_league_members_update after update on league_members
  for each row
  when ((old.league_id, old.user_id, old.role)
    is distinct from (new.league_id, new.user_id, new.role))
  execute function chat_dirty_row('league:league_id');

create trigger chat_dirty_season_teams after insert or delete on season_teams
  for each row execute function chat_dirty_row('season:season_id', 'team:team_id');
create trigger chat_dirty_season_teams_update after update on season_teams
  for each row
  when ((old.season_id, old.team_id) is distinct from (new.season_id, new.team_id))
  execute function chat_dirty_row('season:season_id', 'team:team_id');

create trigger chat_dirty_seasons after insert or delete on seasons
  for each row execute function chat_dirty_row('season:id');
create trigger chat_dirty_seasons_update after update on seasons
  for each row when (old.league_id is distinct from new.league_id)
  execute function chat_dirty_row('season:id');

create trigger chat_dirty_user_links after insert or delete on user_links
  for each row execute function chat_dirty_row('user:user_id', 'user:related_user_id');
create trigger chat_dirty_user_links_update after update on user_links
  for each row
  when ((old.user_id, old.related_user_id, old.kind)
    is distinct from (new.user_id, new.related_user_id, new.kind))
  execute function chat_dirty_row('user:user_id', 'user:related_user_id');

create trigger chat_dirty_user_emails after insert or delete on user_emails
  for each row execute function chat_dirty_row('user:user_id');
create trigger chat_dirty_user_emails_update after update on user_emails
  for each row when (old.user_id is distinct from new.user_id)
  execute function chat_dirty_row('user:user_id');

create trigger chat_dirty_users_merged after update on users
  for each row when (old.merged_into is distinct from new.merged_into)
  execute function chat_dirty_row('user:id', 'user:merged_into');
create trigger chat_dirty_users_account after update on users
  for each row
  when ((old.login_enabled, old.birth_year, old.birth_month)
    is distinct from (new.login_enabled, new.birth_year, new.birth_month))
  execute function chat_dirty_row('user:id');

create trigger chat_dirty_leagues after update on leagues
  for each row when (old.safesport_lao is distinct from new.safesport_lao)
  execute function chat_dirty_row('league:id');

insert into chat_dirty (scope_type, scope_id)
select 'team', id from teams where kind = 'full' and merged_into is null
union all
select 'season', id from seasons
union all
select 'league', id from leagues;
`,
  down: `
drop trigger chat_dirty_leagues on leagues;
drop trigger chat_dirty_users_account on users;
drop trigger chat_dirty_users_merged on users;
drop trigger chat_dirty_user_emails_update on user_emails;
drop trigger chat_dirty_user_emails on user_emails;
drop trigger chat_dirty_user_links_update on user_links;
drop trigger chat_dirty_user_links on user_links;
drop trigger chat_dirty_seasons_update on seasons;
drop trigger chat_dirty_seasons on seasons;
drop trigger chat_dirty_season_teams_update on season_teams;
drop trigger chat_dirty_season_teams on season_teams;
drop trigger chat_dirty_league_members_update on league_members;
drop trigger chat_dirty_league_members on league_members;
drop trigger chat_dirty_season_members_update on season_members;
drop trigger chat_dirty_season_members on season_members;
drop trigger chat_dirty_team_follows_update on team_follows;
drop trigger chat_dirty_team_follows on team_follows;
drop trigger chat_dirty_scope_roles_update on scope_roles;
drop trigger chat_dirty_scope_roles on scope_roles;
drop trigger chat_dirty_memberships_update on memberships;
drop trigger chat_dirty_memberships on memberships;
drop function chat_dirty_scope_role();
drop function chat_dirty_row();
drop function chat_mark_dirty(text, text);
drop table chat_dirty;
drop table chat_reports;
drop table chat_read_cursors;
drop table chat_message_attachments;
drop table chat_attachments;
drop table chat_messages;
drop table chat_grant_requests;
drop table chat_epoch_boxes;
drop table chat_epochs;
drop table chat_membership_log;
drop table chat_members;
drop table chat_conversations;
drop table chat_links;
drop table chat_user_key_boxes;
drop table chat_user_keys;
drop table chat_identities;
drop table chat_devices;
`
}
