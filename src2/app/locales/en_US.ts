/**
 * The master string list, in the manner of edge-react-gui's `en_US.ts`: this
 * file is the source of truth, and every other language is a JSON file of the
 * same keys merged over it, so a missing translation falls back to English
 * rather than showing a key.
 *
 * English is the only language for now. The framework is here so that adding
 * one later is a file, not a refactor.
 *
 * Keys read as `area_thing`, and no screen contains a literal sentence.
 */
export const enUs = {
  // Sign in
  login_title: 'Sign in',
  login_email: 'E-mail address',
  login_password: 'Password',
  login_submit: 'Sign in',
  login_send_code: 'E-mail me a code instead',
  login_code: 'The six-digit code',
  login_code_sent: 'If that address has an account, a code is on its way.',
  login_wrong: 'That e-mail address or password is wrong.',
  login_code_wrong: 'That code is wrong or has expired.',

  // Teams
  teams_title: 'Teams',
  teams_none: 'You are not on a team yet.',

  // Games
  games_title: 'Games',
  games_none: 'No games yet.',
  games_final: 'Final',
  games_scheduled: 'Scheduled',
  games_in_progress: 'In progress',
  games_video_count_one: '1 video',
  games_video_count_other: '%s videos',

  // One game
  game_videos: 'Videos',
  game_highlights: 'Highlights',
  game_box_score: 'Box score',
  game_no_video: 'No video for this game.',
  game_score_mismatch:
    'The plays do not add up to the final score, so highlights are held back until somebody has checked them.',

  // Highlights
  highlight_jump: 'Jump to this play',
  highlights_none: 'No highlights for this video.',

  // Box score and stats
  stats_title: 'Stats',
  stats_season: 'Season',
  stats_career: 'Career',
  stats_plate_appearances: 'PA',
  stats_at_bats: 'AB',
  stats_hits: 'H',
  stats_walks: 'BB',
  stats_strikeouts: 'K',
  stats_runs_batted_in: 'RBI',
  stats_average: 'AVG',
  stats_on_base: 'OBP',
  stats_slugging: 'SLG',
  stats_no_average: '—',
  stats_show_plays: 'Show the plays behind this',
  stats_runs_not_counted:
    'Runs scored, stolen bases and caught stealing come from an import, because the plays alone do not say who moved where.',

  // Standings
  standings_title: 'Standings',
  standings_wins: 'W',
  standings_losses: 'L',
  standings_ties: 'T',
  standings_runs_for: 'RF',
  standings_runs_against: 'RA',

  // Shared
  common_back: 'Back',
  common_retry: 'Try again',
  common_loading: 'Loading…',
  common_not_found: 'Not found.',
  common_offline: 'You appear to be offline.'
}

export type StringKey = keyof typeof enUs
