import type { Migration } from '../runner'

/**
 * The app a sign-in was asked for in, by its link host, so the e-mail's link
 * goes to that host and opens the app rather than the browser. Null for a
 * sign-in asked for on the web, whose link stays on the server's own address.
 */
export const migration054AppOrigin: Migration = {
  name: '054appOrigin',
  up: `
alter table email_codes add column app_origin text;
`,
  down: `
alter table email_codes drop column app_origin;
`
}
