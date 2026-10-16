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
  about_title: 'About TeamStation',
  about_version: 'Version',
  about_number: 'Build number',
  about_branch: 'Branch',
  about_commit: 'Commit',
  about_time: 'Built',
  about_server: 'App server URL',
  about_builds: 'Download builds',
  about_close: 'Close',
  about_close_button: 'Close build information',
  about_open_failed: 'Could not open the download site. Please try again.',
  about_test_error: 'Send a test error',
  about_test_render_error: 'Test a render error',
  about_test_native_crash: 'Test a native crash',
  error_fallback_title: 'Something went wrong',
  error_fallback_body:
    'TeamStation hit a problem it could not recover from. It has been reported.',
  error_fallback_reload: 'Reload',
  oauth_title: 'Authorize access',
  oauth_request: '%s wants to use your TeamStation identity.',
  oauth_identity: 'Signed in as %s',
  oauth_profile: 'Share your name',
  oauth_email: 'Share your email address and verification status',
  oauth_signin: 'Confirm your TeamStation identity',
  oauth_approve: 'Allow',
  oauth_deny: 'Deny',
  oauth_app: 'Approve in the TeamStation app',
  oauth_open_app: 'Open TeamStation',
  oauth_waiting: 'Waiting for your decision in the app…',
  oauth_done:
    'Your decision was saved. Return to the browser that requested access.',
  oauth_return: 'Return to browser',
  oauth_failed:
    'This request expired or could not be completed. Return to the requesting site and sign in again.',
  oauth_login: 'Sign in to continue',
  oauth_switch: 'Use a different account',
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
  home_title: 'TeamStation',
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

  // A team's roster, by section
  roster_admins: 'Admins',
  roster_staff: 'Staff',
  roster_players: 'Players',
  roster_family: 'Family members',
  roster_spectators: 'Spectators',
  roster_followers: 'Followers',
  roster_guardian_of: 'Parent/guardian of %s',
  // The pill on somebody given their place from above: `Season coach`, and
  // for a member of the season or league, `Season spectator`.
  roster_inherited_pill: '%1$s %2$s',
  roster_level_season: 'Season',
  roster_level_league: 'League',
  roster_role_member: 'spectator',
  roster_role_admin: 'admin',
  roster_role_coach: 'coach',
  roster_role_assistant: 'assistant',
  roster_role_scorekeeper: 'scorekeeper',
  roster_role_songkeeper: 'songkeeper',
  roster_role_videographer: 'videographer',

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
  /** The game page's one scoring pill, and the screen it opens. */
  game_score_game: 'Score Game',
  /** The Score action on the game hero. */
  game_hero_score: 'Score',
  /** The Record action on the game hero. It opens DJ Game. */
  game_hero_record: 'Record',
  /** The Coach action on the game hero. */
  game_hero_coach: 'Coach',
  /** The game page's pill for a head coach, and the screen it opens. */
  game_coach_game: 'Coach Game',
  /** Asked of a head coach of both teams before Coach Game opens. */
  game_coach_which: 'Coach which team?',
  /** Asked before a coach leaves Coach Game with changes not saved. */
  coach_discard_title: 'Discard unsaved roster changes?',
  coach_discard: 'Discard',
  coach_keep_editing: 'Keep editing',
  coach_not_coach: 'Only a head coach of this team can coach it here.',
  coach_load_failed: 'Unable to load the game. Please try again.',
  coach_save_failed: 'Unable to save the lineup. Please try again.',
  /** The title of the simplified scoreboard, the 1.0 override dashboard. */
  game_override_scoreboard: 'Override Scoreboard',
  /** The Videos tab of a game nothing was recorded of, in place of a player. */
  game_no_video: 'No videos.',
  game_video_unavailable: 'This video is not available right now.',
  /** Marks a video in the picker whose file is no longer on the server. */
  game_video_gone_suffix: '(unavailable)',
  /**
   * Where somebody signed in who is not a member meets what is kept for
   * members on a team page: the batting and pitching, and the team's videos.
   * The server's own `membersOnly` words.
   */
  members_only: 'You need to be a member of one of the teams to see this.',
  /**
   * A game's Videos tab for a non-member, in place of a player, and again
   * on tapping one of its highlights.
   */
  game_videos_members_only:
    "You need to be a member of one of the teams to watch this game's videos.",
  /** Under a non-member's line score, in place of each side's lines. */
  box_score_members_only:
    'You need to be a member of one of these teams to see individual player stats.',
  /** Under a coach's empty line score, before the game has a line score. */
  box_score_not_started: 'The game has not started',

  // Four angles at once
  angles_open: 'All angles',
  angles_unavailable:
    'Multi-camera viewing is unavailable in this browser. Please switch to Brave or Chrome on desktop or Android, or the native TeamStation mobile app.',
  angles_unavailable_ok: 'OK',
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
  angles_swipe_full_screen: 'Swipe up for full screen',
  angles_not_recording_yet: 'Not recording yet',
  angles_stopped: 'Stopped recording',
  angles_all_ended: 'Every angle has ended.',
  angles_unplaceable:
    'This recording has no start time, so it cannot be held in step with the others.',
  angles_waiting: 'Waiting for the pictures to catch up…',
  angles_tap_for_sound: 'Tap for sound',
  angles_tile_loading: 'Camera loading…',
  angles_tile_catching_up: 'Camera catching up…',
  angles_close: 'Close',
  angles_play: 'Play',
  angles_pause: 'Pause',
  angles_back_ten: 'Back ten seconds',
  angles_forward_ten: 'Forward ten seconds',
  player_slow_mo: 'Slow Mo 25%',
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
  /** The pill above a player's videos that opens the filter. */
  player_videos_filter: 'Filter videos',
  player_videos_filter_empty: 'No highlights under this filter.',

  // Every team a player has played for
  player_teams: 'Teams',
  player_teams_empty: 'Not on any team yet.',

  // A player's settings: on the team the page was opened for, their jersey
  // and positions; away from any team, how they bat and throw
  player_settings: 'Settings',
  player_settings_first_name: 'First name',
  player_settings_last_name: 'Last name',
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

  // Guardians: a guardian, or a team's coaching staff while the player has
  // none, invite one by address from Settings; anybody else who can see the
  // player asks to be one under their name
  player_guardian_invite: 'Invite a guardian',
  player_guardian_invite_detail:
    'A guardian sees every team %s plays on and manages their number, positions and walk-up song. They accept from their notifications.',
  player_guardian_email: 'E-mail address',
  player_guardian_send: 'Send invitation',
  player_guardian_cannot_send: 'The invitation could not be sent. Retry.',
  player_guardian_request: 'Request to be a guardian',
  player_guardian_request_title: 'Ask to be %s\u2019s guardian?',
  player_guardian_request_send: 'Send request',
  player_guardian_request_detail:
    '%s or a guardian of theirs decides, or a coach of one of their teams if they have no guardian. Once approved you see their teams and manage their details.',
  player_guardian_request_sent: 'Guardian request sent',
  player_guardian_cannot_request: 'The request could not be sent. Retry.',

  // A player's walk-up song, for a songkeeper of the team the page was opened for
  player_walkup: 'Walk-up',
  player_walkup_none: 'No walk-up song yet',
  player_walkup_web_note:
    'Set walk-up songs in the TeamStation app on iPhone or Android.',
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
  walkup_denied: 'TeamStation can’t see your music',
  walkup_denied_ios:
    'Allow TeamStation to use Apple Music and your media library in Settings, then come back here.',
  walkup_denied_android:
    'Allow TeamStation to read the music on this phone in Settings, then come back here.',
  walkup_restricted: 'Music is restricted on this phone.',
  walkup_unavailable: 'Music isn’t available on this phone.',
  walkup_open_settings: 'Open Settings',
  walkup_pick_another: 'Pick another song',
  walkup_play: 'Play',
  walkup_start: 'Start',
  walkup_end: 'End',
  walkup_jog: 'Fine adjust: drag to move the clip slowly',
  walkup_setup_intro:
    'For the best and most reliable experience with TeamStation DJ, enable the following settings in your Apple Music app.',
  walkup_setup_add_playlist: 'Add Playlist Songs',
  walkup_setup_sync: 'Sync Library',
  walkup_setup_cellular: 'Download over Cellular',
  walkup_setup_auto: 'Automatic Downloads',
  walkup_setup_path: 'Settings › Apps › Music',
  walkup_setup_note:
    'Songs that were already in your library don’t download by themselves. Open the TeamStation walkup songs playlist in Music and tap Download.',
  walkup_setup_next: 'Next',
  walkup_setup_back: 'Back',
  walkup_setup_done: 'Done',
  walkup_setup_settings: 'Go to Settings',
  walkup_setup_close: 'Close',
  walkup_not_downloaded:
    'Some walk-up songs still need to be downloaded. Make sure your Apple Music settings are configured properly.',
  walkup_not_downloaded_settings: 'Go to Settings',
  walkup_not_downloaded_ignore: 'Ignore',
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
  account_walkup_apple_music: 'Apple Music settings',
  account_walkup_fade: 'Fade Apple Music using the phone’s volume',
  account_walkup_fade_detail:
    'Some Bluetooth speakers beep when the volume changes. Turn this off for hard starts and stops.',

  // Box score and stats
  stats_title: 'Stats',
  game_pitching: 'Pitching',
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

  // A group's people, in its Settings
  manage_remove: 'Remove',
  manage_add: 'Add somebody',
  manage_add_detail:
    'Add someone to %s by email. Somebody with an account is added at once, and told; anybody else is sent an invitation, which applies when they sign up with that address. Invitations last seven days.',
  manage_email: 'E-mail address',
  manage_add_submit: 'Add',
  manage_choose_roles: 'Choose roles',
  manage_add_as: 'Adds them as: %s.',
  manage_new_person: 'the person you add',
  manage_added: '%s has been added.',
  manage_invited: 'An invitation is on its way to %s.',
  manage_already: '%s already had access.',
  manage_open_sent: 'Open sent invitation',
  manage_pending_header: 'Invitations waiting',
  manage_invited_on: 'Invited %s, not joined yet',
  manage_open_invitation: 'Open',
  manage_no_address_header: 'No address on file',
  manage_no_address_detail:
    'Nobody can sign in to these accounts, so they hold no role. Remove one to take it out of here.',
  manage_open: 'Manage',

  // Changing what somebody may do at one level
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
  role_assistant: 'Assistant',
  role_assistant_detail:
    'Same as a coach: edits the players\u2019 jerseys, positions, bats and throws in %s, and sees their full names.',
  role_scorekeeper: 'Scorekeeper',
  role_scorekeeper_detail:
    'Scores the games of %s, sets walk-up songs and DJs them.',
  role_songkeeper: 'Songkeeper',
  role_songkeeper_detail: 'Sets walk-up songs and DJs the games of %s.',
  role_videographer: 'Videographer',
  role_videographer_detail: 'Films and streams the games of %s.',
  role_from: 'From %s',
  role_admin_all: 'Admins can do all of this',
  role_scorekeeper_all: 'Scorekeepers can do this',
  role_save: 'Save',
  role_cancel: 'Cancel',

  // A person's profile, opened from a team's, season's or league's people
  profile_context_team: 'Team \u00b7 %s',
  profile_context_season: 'Season \u00b7 %s',
  profile_context_league: 'League \u00b7 %s',
  profile_guardian_of: 'Parent/Guardian of',
  profile_team_roles: 'Team roles',
  profile_season_roles: 'Season roles',
  profile_league_roles: 'League roles',
  profile_level_note: 'Change these on %s\u2019s page.',
  profile_no_sign_in:
    '%s can\u2019t sign in, so can be a member here but hold no role.',
  profile_admin: 'Admin',
  profile_member: 'Member',
  profile_follower: 'Follower',
  profile_held: 'Yes',
  profile_not_held: '\u2014',
  profile_with: 'With %s',
  profile_player: 'Player',
  profile_following: 'Following',
  profile_not_following: 'Not following',
  profile_refused: 'You can\u2019t open this person here.',
  player_team_roles: 'Team roles',
  player_remove_from_team: 'Remove from %s',
  player_remove_title: 'Remove %1$s from %2$s?',
  player_remove_confirm: 'Remove %s',
  player_remove_detail:
    '%1$s leaves %2$s: off the roster, and every role they hold on it.',
  player_removed: 'Removed %1$s from %2$s',
  player_remove_unchanged: '%1$s is not on %2$s. Nothing was changed.',
  people_none: 'Nobody here yet.',

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
  scoring_roster_tab: 'Roster',
  scoring_edit_roster_instruction: 'Tap a player to edit settings.',
  scoring_roster_empty: 'No players on this team.',
  scoring_roster_conflict:
    'Another user has edited the roster. Your pending changes may overwrite theirs. Hit Cancel to revert to their changes.',
  scoring_game_only_player: 'Game-only player',
  scoring_roster_edit_unavailable:
    'Player settings are unavailable for this team.',
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

  // A game's scoreboard page, once it has closed
  scoreboard_not_live: "This scoreboard isn't live",
  scoreboard_not_live_detail:
    'Scoreboards open when a game is scheduled and close after it ends.',
  scoreboard_sign_up: 'Sign up for TeamStation',

  // The Score Game screen
  score_game_full_header:
    'Score game with full stats (ie. pitches, hits, walks, errors)',
  score_game_full: 'Full game scoring',
  score_game_full_unavailable: "Full scoring isn't available for this game",
  score_game_full_not_scorer:
    'Only people who run a team in this game can score it',
  score_game_scoreboard_header:
    'Operate simplified scoreboard with only bases, balls, strikes, outs, and inning',
  score_game_scoreboard: 'Scoreboard',
  score_game_scoreboard_closed: "This game's scoreboard has closed",
  score_game_scoreboard_not_runner:
    'Only people who run a team in this game can operate the scoreboard',
  score_game_scoreboard_unavailable: 'The scoreboard is unavailable right now',
  score_game_link_header: 'Web Widget Scoreboard Link',
  score_game_copy_link: 'Copy scoreboard link',
  score_game_copied: 'Copied',

  // The scoreboard override dashboard
  override_loading: 'Connecting to the scoreboard…',
  override_away_team: 'Away team name',
  override_home_team: 'Home team name',
  override_away_score: 'Away score',
  override_home_score: 'Home score',
  override_inning: 'Inning',
  override_top: 'Top of the inning',
  override_bottom: 'Bottom of the inning',
  override_first: 'First base',
  override_second: 'Second base',
  override_third: 'Third base',
  override_add_ball: 'Add a ball',
  override_add_strike: 'Add a strike',
  override_add_out: 'Add an out',
  override_clear_balls: 'Clear balls',
  override_clear_strikes: 'Clear strikes',
  override_clear_outs: 'Clear outs',
  override_revert_team: 'Revert team names',
  override_revert_score: 'Revert score',
  override_revert_inning: 'Revert inning',
  override_revert_bases: 'Revert bases',
  override_revert_count: 'Revert count',
  override_pick: 'Pick %s',
  override_close_picker: 'Close the picker',
  override_reset: 'Reset Game State',

  // Dictation
  dictation_button: 'Dictation',
  dictation_status: 'Dictation status',
  dictation_log: 'Dictation log',
  dictation_said: 'Dictated text',
  dictation_play: 'Dictated play',
  dictation_message: 'Dictation message',
  dictation_question: 'Dictation question',
  dictation_connecting: 'Connecting…',
  dictation_listening: 'Listening…',
  dictation_working: 'Working it out…',
  dictation_push: 'Push to talk',
  dictation_ellipsis: '…',
  dictation_dismiss_question: 'Dismiss question',
  dictation_neither: 'Neither — dismiss',
  dictation_record: 'Record',
  dictation_record_nobody: 'Record — nobody out',
  dictation_dismiss_score: 'Dismiss — score nothing',
  dictation_dropped:
    'The connection dropped and that was not scored. Say it again.',
  dictation_left_out: 'Left out: %s',
  dictation_mic_unavailable: 'The microphone is not available: %s',
  dictation_chat: 'Dictation chat',
  dictation_changes_discarded: 'Changes discarded',
  dictation_roster_play: 'That is a play — score it on the scoring screen',
  dictation_roster_other_team: 'Only the %s roster changes here',
  dictation_substitution_separately:
    'Say a substitution separately from a play',

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
