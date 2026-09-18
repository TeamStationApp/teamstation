import type { Migration } from '../runner'

/**
 * Invite codes, the way PeerTube's channel invites worked and this did not.
 *
 * A code is a standing offer to let somebody in, made by an administrator of
 * whatever it is an offer to: a league, a season or a team. Redeeming it gives
 * exactly the access belonging to that scope and nothing else — a team invite
 * makes a spectator of that team, a season invite a `season_members` row, a
 * league invite a `league_members` row.
 *
 * `code` is what a person is sent, so it is unique without regard to case: a
 * link typed as `DEMO2026` must reach the same invite as `demo2026`, and two
 * invites that differ only in case would be two doors nobody could tell apart.
 *
 * `uses` is kept on the row and `invite_redemptions` records who: PeerTube
 * counted uses and never wrote down who redeemed what, so the only answer to
 * "who let this person in" was nobody's to give.
 *
 * `league_members` closes the gap that stopped a league-scoped invite meaning
 * anything. A season has members, a team has memberships, and a league had
 * neither — so a league invite could only have been written as a snapshot of
 * that league's seasons on the day it was redeemed, which goes stale the next
 * time a season is created. A row here is the durable statement: this person
 * may watch this league, including the seasons it does not have yet.
 *
 * The two columns on `email_codes` are what lets an invite create an account.
 * A stranger with a link has no account to redeem into, so the invite rides on
 * the sign-in it asks for: whichever door they come back through — the code
 * typed here, the link opened on a laptop, the phone still waiting — finds the
 * invite on the row and makes the account then, once, verified.
 */
export const migration019Invites: Migration = {
  name: '019invites',
  up: `
create table invites (
  id text primary key,
  code text not null,
  scope_type text not null check (scope_type in ('league', 'season', 'team')),
  scope_id text not null,
  created_by text references users (id) on delete set null,
  -- What it is for, in the words of whoever made it: "Fall parents".
  label text,
  max_uses integer check (max_uses is null or max_uses > 0),
  uses integer not null default 0,
  expires_at timestamptz,
  revoked_at timestamptz,
  source text not null default 'manual'
    check (source in ('peertube', 'manual')),
  created_at timestamptz not null default now()
);
create unique index invites_code on invites (lower(code));
create index invites_scope on invites (scope_type, scope_id);

create table invite_redemptions (
  id text primary key,
  invite_id text not null references invites (id) on delete cascade,
  user_id text not null references users (id) on delete cascade,
  -- True when this redemption is also where the account came from.
  created_account boolean not null default false,
  redeemed_at timestamptz not null default now(),
  unique (invite_id, user_id)
);
create index invite_redemptions_user on invite_redemptions (user_id);

create table league_members (
  id text primary key,
  user_id text not null references users (id) on delete cascade,
  league_id text not null references leagues (id) on delete cascade,
  role text not null default 'spectator'
    check (role in ('spectator', 'member')),
  source text not null default 'manual'
    check (source in ('peertube', 'import', 'manual')),
  joined_at timestamptz not null default now(),
  unique (user_id, league_id)
);
create index league_members_league on league_members (league_id);

alter table email_codes add column invite_id text
  references invites (id) on delete set null;
alter table email_codes add column display_name text;
`,
  down: `
alter table email_codes drop column if exists display_name;
alter table email_codes drop column if exists invite_id;
drop table if exists league_members;
drop table if exists invite_redemptions;
drop table if exists invites;
`
}
