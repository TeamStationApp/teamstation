import type { Migration } from '../runner'

/**
 * Notifications on a person's phones and browsers: each signed-in device's
 * push address, with that device's own two switches (both off until it says
 * otherwise) and when a push service last refused it for good, until it is
 * posted again; and the RSVP reminders already sent. A reminder is keyed on
 * the event's start, so a rescheduled event earns one of its own.
 */
export const migration124PushNotifications: Migration = {
  name: '124pushNotifications',
  up: `
create table push_registrations (
  id text primary key,
  user_id text not null references users(id) on delete cascade,
  session_id text not null references auth_sessions(id) on delete cascade,
  platform text not null check (platform in ('ios', 'android', 'web')),
  address_key text not null,
  address text not null,
  environment text not null check (environment in ('production', 'development')),
  messages boolean not null default false,
  rsvp_events boolean not null default false,
  created_at timestamptz not null default now(),
  seen_at timestamptz not null default now(),
  rejected_at timestamptz,
  unique (platform, address_key)
);
create index push_registrations_user on push_registrations(user_id);
create index push_registrations_session on push_registrations(session_id);
create table push_reminders_sent (
  event_kind text not null check (event_kind in ('game', 'teamEvent')),
  event_id text not null,
  user_id text not null,
  start_at timestamptz not null,
  sent_at timestamptz not null default now(),
  primary key (event_kind, event_id, user_id, start_at)
);
`,
  down: `
drop table push_reminders_sent;
drop table push_registrations;
`
}
