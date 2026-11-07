/** What a ball in play can come to, as both pickers offer it. */
export const PRIMARY_OUTCOMES = [
  'Batter Out',
  'Single',
  'Double',
  'Triple',
  'Home Run',
  "Fielder's Choice",
  'Error'
] as const
/** How the batter was put out, behind Batter Out. */
export const OUT_TYPES = [
  'Ground Out',
  'Out at First',
  'Ball Caught',
  'Batter Interference'
] as const
