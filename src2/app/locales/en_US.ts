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
  video_primary: 'Video',
  video_multi_angle: 'Multi-angle',
  videos_count_one: '%s video',
  videos_count_many: '%s videos',
  games_count_one: '%s game',
  games_count_many: '%s games',
  game_box_score: 'Box score',
  game_no_video: 'No video for this game.',
  game_video_unavailable: 'This video is not available right now.',
  /** Marks a video in the picker whose file is no longer on the server. */
  game_video_gone_suffix: '(unavailable)',

  // Four angles at once
  angles_open: 'All angles',
  angles_title: 'Choose up to four angles',
  angles_detail:
    'They play together, on one clock. Hold a picture for a second, then drag it to move it.',
  angles_cap: 'Four at a time is the most the picture holds.',
  angles_watch: 'Watch',
  angles_column_angle: 'Angle',
  angles_column_show: 'Show',
  angles_column_sound: 'Sound',
  angles_sound_from_label: 'Hear %s',
  angles_cancel: 'Cancel',
  angles_rotate: 'Turn your phone sideways to watch all the angles.',
  angles_swipe_full_screen: 'Swipe up for full screen',
  angles_not_recording_yet: 'Not recording yet',
  angles_stopped: 'Stopped recording',
  angles_all_ended: 'Every angle has ended.',
  angles_unplaceable:
    'This recording has no start time, so it cannot be held in step with the others.',
  angles_waiting: 'Waiting for the pictures to catch up…',
  angles_tile_loading: 'Camera loading…',
  angles_tile_catching_up: 'Camera catching up…',
  angles_close: 'Close',
  angles_play: 'Play',
  angles_pause: 'Pause',
  angles_back_ten: 'Back ten seconds',
  angles_forward_ten: 'Forward ten seconds',
  player_slow_mo: 'Slow Mo 25%',
  player_slow_mo_back: 'Reverse Slow Mo 25%',
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

  // One player
  player_videos: 'Videos',
  player_stats: 'Stats',
  player_sections: 'Player sections',
  player_cannot_load: 'Cannot load this player.',
  player_videos_empty: 'No highlights of this player yet.',
  player_videos_none_recorded:
    'None of this player\u2019s games were recorded, so there is nothing to watch yet.',
  player_show_more: 'Show more',
  player_loading: 'Loading\u2026',
  player_stats_empty: 'No stats for this player yet.',
  player_batting: 'Batting',
  player_pitching: 'Pitching',
  player_no_batting: 'This player has never batted in a game we hold.',
  player_no_pitching: 'This player has never pitched in a game we hold.',
  player_filter: 'Filter',
  player_filter_empty: 'No games under this filter.',
  player_filter_clear: 'Show every game',
  player_filter_title: 'Which games?',
  player_filter_career: 'Career',
  player_filter_career_detail: 'Every game, every team, every season.',
  player_filter_by_season: 'By season',
  player_filter_by_team: 'By team',
  player_filter_by_year: 'By year',
  player_filter_apply: 'Show these',
  player_filter_cancel: 'Cancel',
  /** `12 games · Spring 2026` under the heading. */
  player_stats_scope: '%s \u00b7 %s',
  /** What a filter narrows to when the season or team is no longer known. */
  player_filter_unknown: 'a filter that no longer exists',
  player_games: '%s games',
  player_one_game: '1 game',

  // A player's settings, for a coach of the team the page was opened for
  player_settings: 'Settings',
  player_settings_jersey: 'Jersey number',
  player_settings_positions: 'Positions',
  player_settings_bats: 'Bats',
  player_settings_throws: 'Throws',
  player_settings_right: 'Right',
  player_settings_left: 'Left',
  player_settings_switch: 'Switch',
  player_settings_save: 'Save',
  player_settings_saved: 'Saved.',
  player_settings_cannot_load: 'Cannot load this player\u2019s settings.',
  player_settings_cannot_save: 'Cannot save these settings.',
  player_settings_not_on_team: 'This player is not on this team\u2019s roster.',

  // A player's walk-up song, for a songkeeper of the team the page was opened for
  player_walkup: 'Walk-up',
  player_walkup_none: 'No walk-up song yet',
  player_walkup_web_note:
    'Set walk-up songs in the GameStation app on iPhone or Android.',
  player_walkup_apple_music: 'Apple Music',
  player_walkup_local_file: 'A file on the phone',
  player_walkup_clip: 'Plays %s',
  player_walkup_set: 'Set',
  player_walkup_change: 'Change',
  player_walkup_preview: 'Preview',
  player_walkup_stop: 'Stop',
  player_walkup_not_here: 'Not on this phone',
  player_walkup_remove: 'Remove',
  player_walkup_remove_confirm: 'Tap again to remove',
  player_walkup_cannot_load: 'Cannot load this player\u2019s walk-up song.',
  player_walkup_cannot_remove: 'Cannot remove this walk-up song.',

  // The song picker, on a phone: search, then the clip
  walkup_title: 'Walk-up song for %s',
  walkup_search: 'Search',
  walkup_search_apple: 'Apple Music and your library',
  walkup_search_device: 'Music on this phone',
  walkup_licence:
    'Playing music at a field may need the league’s performance licence.',
  walkup_choose_file: 'Choose a file…',
  walkup_searching: 'Searching…',
  walkup_no_match: 'No songs match',
  walkup_retry: 'Retry',
  walkup_badge_catalog: 'Apple Music',
  walkup_badge_library: 'Library',
  walkup_badge_device: 'On this phone',
  walkup_checking: 'Checking music access…',
  walkup_denied: 'GameStation can’t see your music',
  walkup_denied_ios:
    'Allow GameStation to use Apple Music and your media library in Settings, then come back here.',
  walkup_denied_android:
    'Allow GameStation to read the music on this phone in Settings, then come back here.',
  walkup_restricted: 'Music is restricted on this phone.',
  walkup_unavailable: 'Music isn’t available on this phone.',
  walkup_open_settings: 'Open Settings',
  walkup_pick_another: 'Pick another song',
  walkup_play: 'Play',
  walkup_start: 'Start',
  walkup_end: 'End',
  walkup_length: '%s s',
  walkup_earlier: '1 s earlier',
  walkup_later: '1 s later',
  walkup_play_from_here: 'Play from here',
  walkup_save: 'Save',
  walkup_cannot_save: 'Cannot save this walk-up song.',

  // The Account screen, on an iPhone
  dj_game: 'DJ Game',
  dj_matchup: '%s @ %s',
  dj_note_default: 'Lineup not set for this game — showing the team’s default',
  dj_note_roster: 'No lineup yet — showing the roster',
  dj_at_bat: 'at bat',
  dj_no_song: 'No walk-up song',
  dj_song: '%s · %s',
  dj_not_here: '%s isn’t on this phone',
  dj_play: 'Play %s’s walk-up song',
  dj_stop: 'Stop %s’s walk-up song',
  dj_edit: 'Set %s’s walk-up song',
  dj_empty: 'No batters to list',
  dj_cannot_load: 'Cannot load this game’s lineups.',
  dj_retry: 'Retry',
  // The scoring screen's music note, for the batter coming up
  walkup_note_play: 'Play %s’s walk-up song',
  walkup_note_stop: 'Stop %s’s walk-up song',
  walkup_note_not_here: 'Walk-up song for %s, not on this phone',
  account_walkup: 'Walk-up songs',
  account_walkup_fade: 'Fade Apple Music using the phone’s volume',
  account_walkup_fade_detail:
    'Some Bluetooth speakers beep when the volume changes. Turn this off for hard starts and stops.',

  // Box score and stats
  stats_title: 'Stats',
  game_pitching: 'Pitching',
  box_no_roster:
    'No individual lines for this side: its players are not known here.',
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
  stats_runs: 'R',
  stats_earned_runs: 'ER',
  stats_era: 'ERA',
  stats_whip: 'WHIP',
  stats_innings: 'IP',
  stats_games: 'G',
  stats_stolen_bases: 'SB',
  stats_home_runs: 'HR',
  stats_ops: 'OPS',
  stats_show_plays: 'Show the plays behind this',

  // Standings
  standings_title: 'Standings',
  standings_wins: 'W',
  standings_losses: 'L',
  standings_ties: 'T',
  standings_runs_for: 'RF',
  standings_runs_against: 'RA',

  // Invites
  invite_title: 'Invite people',
  invite_detail:
    'Anybody with the link can watch %s. They will be asked for their name and e-mail address.',
  invite_none: 'No invite links yet.',
  invite_create: 'Create an invite link',
  invite_code_label: 'Code (optional)',
  invite_code_placeholder: 'fall26',
  invite_label_label: 'What it is for (optional)',
  invite_label_placeholder: 'Parents',
  invite_submit: 'Create',
  invite_cancel: 'Cancel',
  invite_copy: 'Copy link',
  invite_copied: 'Copied',
  invite_revoke: 'Stop this link',
  invite_uses_none: 'Never used',
  invite_uses_one: 'Used once',
  invite_uses_many: 'Used %s times',
  invite_revoked: 'Stopped',
  invite_expired: 'Expired',
  invite_exhausted: 'All used up',

  // The page behind the gear
  manage_title: 'Manage %s',
  manage_people: 'Who can watch',
  manage_people_detail:
    'A tick shows where somebody\u2019s access comes from. More than one is normal \u2014 a coach whose child is on the roster is in the team and the season.',
  manage_person: 'Person',
  manage_via_team: 'Team',
  manage_via_season: 'Season',
  manage_via_league: 'League',
  manage_admin: 'Admin',
  manage_admins: 'Administrators',
  manage_admins_detail:
    'An administrator can invite people, remove them, and make other administrators of this and everything inside it.',
  manage_admins_none: 'Nobody but you.',
  manage_admin_email: 'E-mail address of somebody who already has an account',
  manage_admin_on: 'Make an administrator',
  manage_admin_off: 'Remove',
  manage_role: 'Role',
  manage_role_line: '%s %s · %s',
  manage_role_none: 'No role here',
  manage_role_admin: 'admin',
  manage_role_owner: 'owner',
  manage_role_manager: 'manager',
  manage_role_member: 'member',
  manage_role_spectator: 'spectator',
  manage_role_from: '%s \u00b7 from %s',
  manage_created: 'Joined',
  manage_last_login: 'Last login',
  manage_never: 'Never',
  manage_seen: 'Here %s',
  manage_filter: 'Search',
  manage_filter_placeholder: 'A name or an address',
  manage_no_email: 'No address on file',
  manage_remove: 'Remove',
  manage_pending: 'Invited, not joined yet',
  manage_add: 'Add somebody',
  manage_add_detail:
    'Type an address. Somebody who already has an account is added to %s straight away; anybody else is sent an invitation.',
  manage_email: 'E-mail address',
  manage_add_submit: 'Add',
  manage_added: '%s has been added.',
  manage_invited: 'An invitation is on its way to %s.',
  manage_already: '%s already had access.',
  manage_refused: 'You do not administer this.',
  manage_open: 'Manage',

  // Changing what somebody may do at one level
  role_change: 'Change role',
  role_title: 'Roles for %s',
  role_scope: 'At %s, and everything inside it.',
  role_team_admin: 'Team admin',
  role_season_admin: 'Season admin',
  role_league_admin: 'League admin',
  role_admin_detail:
    'Can invite people to %s, remove them, and change what everybody here is.',
  role_coach: 'Coach',
  role_coach_detail:
    'Edits the players\u2019 jerseys, positions, bats and throws in %s, and sees their full names.',
  role_scorekeeper: 'Scorekeeper',
  role_scorekeeper_detail: 'Scores the games of %s.',
  role_songkeeper: 'Songkeeper',
  role_songkeeper_detail: 'Sets walk-up songs and DJs the games of %s.',
  role_videographer: 'Videographer',
  role_videographer_detail: 'Films and streams the games of %s.',
  role_from: 'From %s',
  role_admin_all: 'Admins can do all of this',
  role_save: 'Save',
  role_cancel: 'Cancel',
  manage_no_address_header: 'No address on file',

  // Coming in through an invite
  join_header: 'Invitation',
  join_loading: 'Checking that invite…',
  join_unknown: 'That invite link is not good',
  join_unknown_detail:
    'It may have been stopped, or the address may have been copied out of an e-mail with a piece missing.',
  join_dead: 'That invite link is no longer good',
  join_title: 'You have been invited',
  join_scope_team: 'You are invited to watch %s',
  join_scope_season: 'You are invited to watch the whole %s season',
  join_scope_league: 'You are invited to watch everything in %s',
  join_name: 'Your name',
  join_name_placeholder: 'Alex Rivera',
  join_email: 'E-mail address',
  join_email_placeholder: 'parent@example.com',
  join_send_code: 'Send me a sign-in code',
  join_code: 'Sign-in code',
  join_code_sent:
    'A six-digit code is on its way. It lasts ten minutes, and the link in the same message works too.',
  join_finish: 'Join',
  join_accept: 'Accept the invitation',
  join_already: 'You can already watch %s.',
  join_welcome: 'You are in. %s is on your home screen.',
  join_open: 'Have a look',

  // Scoring control presentation (engine action identifiers stay stable)
  scoring_control_more: 'MORE',
  scoring_control_song: 'SONG',
  scoring_control_stop: 'STOP',
  scoring_control_ball: 'BALL',
  scoring_control_called_strike: 'CALLED\nSTRIKE',
  scoring_control_swing_miss: 'SWING\n& MISS',
  scoring_control_foul: 'FOUL\nBALL',
  scoring_control_bunt: 'BUNT',
  scoring_control_swing: 'SWING',
  scoring_control_undo: 'UNDO',
  scoring_in_play: 'IN PLAY',
  scoring_out_zone: 'OUT ZONE',
  scoring_no_plays: 'No plays yet',
  scoring_history_hint: 'Your last action appears here',
  scoring_undo_hint: 'Undo last action',
  scoring_place_runner: 'Place a Runner',
  scoring_tiebreaker: '(Tiebreaker)',
  scoring_out_type: 'OUT TYPE',
  scoring_submenu: 'SUB-MENU',
  scoring_at_home: 'At Home',
  scoring_at_first: 'At First',
  scoring_at_second: 'At Second',
  scoring_at_third: 'At Third',
  scoring_bottom_action: 'Bottom %s',
  scoring_finish_at_bat: 'Finish at-bat',
  scoring_finish_defensive_play: 'Finish defensive play',

  // Shared
  common_done: 'Done',
  common_back: 'Back',
  common_retry: 'Try again',
  common_loading: 'Loading…',
  common_not_found: 'That game is not here',
  common_not_found_detail:
    'It may have been removed, or the link may be for a game you cannot see.',
  common_offline: 'You appear to be offline.'
}

export type StringKey = keyof typeof enUs
