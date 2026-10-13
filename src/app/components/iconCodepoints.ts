/**
 * One character per icon, the private-use point Google assigned it.
 * `makeFonts.py` writes this file and the phone font together: the
 * phone draws the character, and the web keeps drawing the ligature
 * name because Google's CDN font is what the browser loads.
 */
import type { IconName } from './Icon'

export const iconCodepoints: Record<IconName, number> = {
  chevron_right: 0xe409,
  chevron_left: 0xe408,
  home: 0xe88a,
  smart_display: 0xf06a,
  event: 0xe24f,
  account_circle: 0xe853,
  groups: 0xf233,
  leaderboard: 0xf20c,
  sports_baseball: 0xea51,
  stadium: 0xeb90,
  play_circle: 0xe038,
  play_arrow: 0xe037,
  format_list_bulleted: 0xe241,
  bookmark: 0xe866,
  share: 0xe80d,
  mail: 0xe0be,
  star: 0xe838,
  table_chart: 0xe265,
  videocam: 0xe04b,
  refresh: 0xe5d5,
  settings: 0xe8b8,
  close: 0xe14c,
  content_copy: 0xe14d,
  forward_10: 0xe056,
  replay_10: 0xe059,
  music_note: 0xe3a1,
  description: 0xe873,
  stop: 0xe047,
  mic: 0xe029,
  mic_off: 0xe02b,
  volume_off: 0xe04f,
  volume_up: 0xe050,
  pause: 0xe034,
  notifications: 0xe7f4,
  search: 0xe8b6,
  filter_alt: 0xef4f,
  edit: 0xe150,
  place: 0xe0c8
}
