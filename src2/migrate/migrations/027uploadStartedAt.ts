import type { Migration } from '../runner'

/**
 * When the recording an upload carries actually began.
 *
 * The library places a video on the game's wall clock, and the multi-camera
 * view lays a take's angles side by side on that clock — so a video's
 * `start_at` is not a label, it is the thing alignment is computed from. An
 * upload had nowhere to keep it, and the finish step fell back to the moment
 * the upload was opened. Two cameras of one take, uploaded one after the
 * other, landed as far apart as the second upload was late: a real take went
 * up with its home-plate camera thirty-four minutes down the timeline from
 * its programme output, which is exactly how long the first file took to send.
 *
 * The app knows the answer — every file of an export starts at the take's own
 * wall clock — so it says so when it opens the upload, and this is where that
 * answer waits for the finish step that needs it.
 */
export const migration027UploadStartedAt: Migration = {
  name: '027uploadStartedAt',
  up: `
alter table director_uploads add column started_at timestamptz;
`,
  down: `
alter table director_uploads drop column started_at;
`
}
