import { Platform } from 'react-native'

/**
 * The settings sheet's colours and type, drawn to TS Cameraman's Settings
 * (`SettingsView`): iOS's dark grouped colours, the green card titles and
 * Done, the blue action and the red Unpair. Like the overlay it opens from,
 * it does not follow the app's theme: it sits over the camera.
 */
export const SETTINGS = {
  /** `systemGroupedBackground`, dark. */
  background: '#000000',
  /** `secondarySystemGroupedBackground`, dark: each card. */
  card: '#1C1C1E',
  separator: 'rgba(84, 84, 88, 0.6)',
  text: '#FFFFFF',
  secondaryText: 'rgba(235, 235, 245, 0.6)',
  /** Cameraman's card titles and Done: `Color(0.50, 0.85, 0.61)`. */
  green: '#80D99C',
  /** `systemGreen`, dark: a radar's "Connected". */
  connected: '#30D158',
  /** `systemBlue`, dark: Pair Device. */
  blue: '#0A84FF',
  /** `systemRed`, dark: Unpair, and a refusal. */
  red: '#FF453A',
  inputBackground: '#2C2C2E',
  /** The toolbar under the title. */
  toolbarHeight: 44,
  cardRadius: 16,
  /** A card's rows sit 16 in from its edges. */
  rowInset: 16,
  rowVertical: 10,
  /** Between cards, and between the two columns. */
  gap: 16,
  /** The sheet's margin either side of the cards. */
  margin: 12,
  /** `footnote`, the card titles and the secondary lines. */
  footnote: 13,
  /** `body`. */
  body: 17
} as const

/** SF Mono on iOS, the system monospace elsewhere: a radar's serial. */
export const SETTINGS_MONOSPACE =
  Platform.OS === 'ios' ? 'ui-monospace' : 'monospace'
