/** Compact batting and pitching headers shared by replay and TV. */
export const replayBattingLabels = ['AB', 'R', 'H', 'RBI', 'BB', 'SO']
export const replayPitchingLabels = [
  'IP',
  'H',
  'R',
  'ER',
  'BB',
  'SO',
  'HBP',
  '#P',
  'S'
]
export const replayBoxLabels = [
  ...replayBattingLabels,
  ...replayPitchingLabels,
  'E'
]
