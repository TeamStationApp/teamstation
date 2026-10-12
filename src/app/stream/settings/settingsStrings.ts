/**
 * The settings sheet's words. They live beside the sheet rather than in
 * `locales/en_US.ts` so this sheet lands without touching the strings file
 * other work on the streaming branch is changing; they move there with the
 * next pass over the locale.
 */
export const settingsStrings = {
  title: 'Camera',
  done: 'Done',
  audio: 'Audio',
  microphone: 'Microphone',
  lenses: 'Lenses',
  lensesNone: 'This camera has one lens.',
  name: 'Name',
  nameLabel: 'Camera angle',
  radar: 'Radar',
  radarIntro: 'Track pitch speed and exit velocity with Tag Sports Radar.',
  radarOn: 'On',
  connected: 'Connected',
  unpair: 'Unpair',
  pairDevice: 'Pair Device',
  pairTitle: 'Pair Device',
  pairNone: 'No radars in range',
  pairFailed: 'Could not pair %s',
  close: 'Close',
  bluetoothOff: 'Bluetooth is off',
  permission: 'Allow Bluetooth for TeamStation in Settings to use a radar.',
  mph: 'mph'
} as const
