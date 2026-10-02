import type { Migration } from '../runner'

/**
 * Who deserves the credit for each play, and how it reads in one line.
 *
 * A list rather than a column per field, because **a play yields more than one
 * credited outcome**: a single that scores a runner is a hit and a run, and the
 * two happened at different moments — a run can be a steal of home or a wild
 * pitch during the at-bat. One row per play stays true; the fan-out happens
 * here.
 *
 * Stored rather than worked out on every read, which is where the highlight
 * *timing* is worked out. Timing depends on settings that change; a label
 * depends only on the play's own wording, which cannot. Recomputing it per
 * request would mean rebuilding a name map every time to arrive at the same
 * answer.
 */
export const migration010Credits: Migration = {
  name: '010credits',
  up: `
alter table events add column credits jsonb;
comment on column events.credits is
  'Credited outcomes: [{ eventType, label, creditUserId, creditName, teamId, role, position }]';
`,
  down: `
alter table events drop column if exists credits;
`
}
