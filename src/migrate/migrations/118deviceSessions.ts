import type { Migration } from '../runner'

export const migration118DeviceSessions: Migration = {
  name: '118deviceSessions',
  // A device session starts on a sign-in's first use after an hour or more
  // of none: `recordCredentialUse` writes a row here then. Nothing older is
  // known, so the table starts empty. Its rows go with their sign-in, which
  // the nightly purge removes, so they are kept exactly as long, and with
  // their person, whose deletion removes their sign-ins. `user_id` is the
  // sign-in's own, copied for reading; it has no key of its own on `users`,
  // whose check would make every first use wait on a merge or a suspension
  // holding that person's row.
  up: `
create table device_sessions (
  id text primary key,
  auth_session_id text not null references auth_sessions(id) on delete cascade,
  user_id text not null,
  started_at timestamptz not null
);
create index device_sessions_started on device_sessions (started_at desc, (id collate "C") desc);
create index device_sessions_auth_session on device_sessions (auth_session_id);
create index device_sessions_user on device_sessions (user_id);
create index auth_sessions_created on auth_sessions (created_at desc, (id collate "C") desc);
`,
  down: 'drop table device_sessions; drop index auth_sessions_created;'
}
