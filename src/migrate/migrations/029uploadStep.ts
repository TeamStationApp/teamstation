import type { Migration } from '../runner'

/**
 * What the server is doing with an upload right now.
 *
 * Taking a finished upload in is minutes of work — assemble the parts, probe
 * them, remux to HLS, copy to the Space, write the row — and it used to
 * happen inside the request that asked for it. An app on a ball field cannot
 * hold a request open for four to seven minutes, and did not: it timed out,
 * decided the upload had failed, and in the Distributor's case stopped the
 * rest of the export, while the server carried on and finished the job.
 *
 * So the request now answers at once and the work goes on behind it, which
 * means the app has to be able to *ask* what is happening. `state` already
 * says open, assembling, ready or failed; this says which part of assembling,
 * so a screen can tell somebody their recording is being converted rather
 * than showing a bar that has not moved for four minutes.
 */
export const migration029UploadStep: Migration = {
  name: '029uploadStep',
  up: `
alter table director_uploads add column step text;
`,
  down: `
alter table director_uploads drop column step;
`
}
