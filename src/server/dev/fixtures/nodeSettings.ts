/**
 * What a deployed node holds in `system_settings` that no migration writes, so a seat
 * or an isolated stack takes production's paths from its first request and no scenario
 * depends on an earlier one's side effects.
 */
export const NODE_SETTINGS: Record<string, unknown> = {
  // Production set this once, when its ownership preflight passed. An empty database
  // has nothing to fail that check.
  'creation.hierarchyReady': true,
  // Off in production. Everything a test sends goes to a test address.
  'mail.accountMessages': true
}

/** Keys the server reads that need no row, and why. */
export const UNSET_SETTINGS: Record<string, string> = {
  'distribution.iosAppStoreUrl':
    'An absent link turns off the Safari app banner',
  'highlights.':
    'Each falls back to its default, the same as a production node',
  'radar.': 'Each falls back to its default, the same as a production node',
  'replay.': 'Each falls back to its default, the same as a production node',
  'scoreboard.':
    'Each falls back to its default, the same as a production node',
  'test.rateLimitScale':
    'Rate limits use a scale of 1 unless a synthetic test fixture overrides it'
}
