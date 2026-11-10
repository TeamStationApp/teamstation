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
  'mail.accountMessages': true,
  // Ordinary scenarios never hit a limit. The rate-limit block lowers it.
  'test.rateLimitScale': 100
}

/** Keys the server reads that need no row, and why. */
export const UNSET_SETTINGS: Record<string, string> = {
  'highlights.':
    'Each falls back to its default, the same as a production node',
  'radar.': 'Each falls back to its default, the same as a production node',
  'replay.': 'Each falls back to its default, the same as a production node',
  'scoreboard.': 'Each falls back to its default, the same as a production node'
}
