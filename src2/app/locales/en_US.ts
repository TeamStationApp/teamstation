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

  // Home
  home_title: 'GameStation',
  home_your_teams: 'Your teams',
  home_seasons: 'Seasons',
  home_nothing_yet:
    'You do not have access to anything yet. When somebody adds you to a team or a season, it will appear here.',

  // Seasons
  season_schedule: 'Schedule',
  season_teams: 'Teams',
  season_standings: 'Standings',
  season_no_games: 'No games yet.',
  season_counts: '%s teams · %s games · %s videos',
  season_no_video: 'no video',

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
  video_primary: 'Primary',
  video_multi_angle: 'Multi-angle',
  videos_count_one: '%s video',
  videos_count_many: '%s videos',
  game_box_score: 'Box score',
  game_no_video: 'No video for this game.',
  game_video_unavailable: 'This video is not available right now.',
  /** Marks a video in the picker whose file is no longer on the server. */
  game_video_gone_suffix: '(unavailable)',
  game_batting: 'Batting',
  game_box_score_empty: 'No batting to show for this game yet.',
  game_at: 'at',
  game_score_mismatch:
    'The plays do not add up to the final score, so highlights are held back until somebody has checked them.',

  // Highlights
  highlight_jump: 'Jump to this play',
  highlights_none: 'No highlights for this video.',
  highlights_none_named:
    'No highlights we can name for this video. The plays are there, but the players on them are not in our records.',
  /**
   * Some games were scored from the recording afterwards, sometimes days
   * later. The plays are real and the box score is right; the tap times just
   * say when somebody sat down with the video, so nothing can place them on
   * it. Said plainly, because an empty list with no reason reads as a fault.
   */
  highlights_scored_after:
    'This game was scored after the video was recorded, so the plays cannot be placed on it. The box score and stats are still complete.',
  highlights_no_play_times:
    'This game\u2019s plays have no times recorded, so they cannot be placed on the video.',
  highlights_no_video_start:
    'This video has no start time recorded, so plays cannot be placed on it.',

  // Box score and stats
  stats_title: 'Stats',
  stats_player: 'Player',
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
