/**
 * The values of 1.0's dark GameStation theme (`src/client/themes/gsDark.ts` at 25f9496e)
 * that 1.0's scoreboard reads, exactly, for the board alone. It draws in these
 * whatever the app's own theme is.
 */
const palette = {
  white: '#FFFFFF',
  black: '#000000',

  // GS Logo Colors - from gs_logo.png
  gsBeige: '#E8E4D8',

  // Blues and Greens
  navyBlue: '#003087',
  skyBlue: '#3266ad',

  // Reds and Oranges
  coralRed: '#ef4444',
  gold: '#DAA520',

  // Browns
  saddleBrown: '#8B4513',

  // Grays (light to dark)
  steel: '#606060',
  slateGray: '#555',
  darkSlate: '#4d4d4d',
  darkCharcoal: '#383838',
  darkerGray: '#2d2d2d',

  // Fonts
  helveticaNeue: 'Helvetica Neue, Arial, sans-serif'
}

/**
 * 1.0's `src/client/themes/scaling.ts` at 25f9496e (`scaleV`), with the window's height
 * fixed where 1.0 read it from the window once at load.
 *
 * 1.0 grew every size with the window's height, so its board was 522 px wide
 * in a 720-high browser and 607 px in a 1080-high one. The board must be one
 * size wherever it is drawn (`SCOREBOARD_BOARD_SIZE`), so it is drawn at the
 * size 1.0 drew in a 1920 × 1080 window: the web view GS Director loads every
 * overlay page in, and an OBS browser source on a 1080p canvas.
 */
export const SCOREBOARD_WINDOW_HEIGHT = 1080
const guidelineBaseHeight = 568
const ratioVertical =
  (SCOREBOARD_WINDOW_HEIGHT - guidelineBaseHeight) / guidelineBaseHeight
const scale = (size: number, factor: number = 0.3): number => {
  return size + size * factor * ratioVertical
}

export const scoreboardTheme = {
  rem: (size: number): number => {
    return Math.round(scale(16) * size)
  },

  primaryTextColor: palette.gsBeige,
  secondaryTextFont: palette.helveticaNeue,

  // Status colors
  activeColor: palette.coralRed, // PRESERVED - used for bases and inning arrows

  // Scoreboard specific
  scoreboardBackground: palette.darkerGray,
  scoreboardBorderColor: palette.darkSlate,
  scoreboardSeparatorColor: palette.slateGray,
  scoreboardBaseFill: palette.darkCharcoal,
  scoreboardOutlineGray: palette.steel,
  scoreboardTeamAwayGradient: [palette.navyBlue, palette.skyBlue],
  scoreboardTeamHomeGradient: [palette.saddleBrown, palette.gold],
  scoreboardScoreBackground: palette.white,
  scoreboardScoreText: palette.black,

  // Shadows
  shadowColor: palette.black
}

export type ScoreboardTheme = typeof scoreboardTheme
