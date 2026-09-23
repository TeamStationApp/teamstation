import type { Migration } from '../runner'

/**
 * How many cameras a recording holds.
 *
 * A count, not a type. The videos of a game are otherwise independent and we
 * do not claim to know what any of them is; the one thing worth recording is
 * whether a viewer is about to see one view or several.
 *
 * The count is **cameras**, not tiles. A multi-angle recording lays the
 * program output alongside them, so a mosaic of four tiles is three cameras
 * and one of three tiles is two. One tile is always the program, which is
 * not a camera.
 *
 * Nine is not a real limit, just a bound that catches a mistake: a value in
 * the hundreds means something read a duration into this column.
 */
export const migration011Cameras: Migration = {
  name: '011cameras',
  up: `
alter table videos add column num_cameras integer not null default 1
  check (num_cameras between 1 and 9);
`,
  down: `
alter table videos drop column if exists num_cameras;
`
}
