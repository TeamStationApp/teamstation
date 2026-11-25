import type { Migration } from '../runner'

/**
 * Umpire Management Notifications: each league admin's own choice of umpire
 * notices for a league, and the League management push category.
 *
 * `league_umpire_notifications` holds one row per admin and league: the
 * daily missing-slot digest (`missing_slots`, `days_before` 1–30), sign-up
 * notices (`sign_ups`) and withdraw notices (`withdrawals`). No row reads as
 * the defaults (all off, 7 days). It goes with the league and with the
 * person.
 *
 * `push_registrations.league_management` is a device's third switch: League
 * management notices are pushed only to registrations with it on. Every
 * existing registration is on, as a new device's is after it allows
 * notifications.
 *
 * Down drops the column and the table.
 */
export const migration130UmpireNotifications: Migration = {
  name: '130umpireNotifications',
  up: `
create table league_umpire_notifications (
  league_id     text        not null references leagues (id) on delete cascade,
  user_id       text        not null references users (id) on delete cascade,
  missing_slots boolean     not null default false,
  days_before   integer     not null default 7 check (days_before between 1 and 30),
  sign_ups      boolean     not null default false,
  withdrawals   boolean     not null default false,
  updated_at    timestamptz not null default now(),
  primary key (league_id, user_id)
);
alter table push_registrations
  add column league_management boolean not null default true;
`,
  down: `
alter table push_registrations drop column league_management;
drop table league_umpire_notifications;
`
}
