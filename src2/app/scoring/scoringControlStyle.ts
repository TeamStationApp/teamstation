import type { ViewStyle } from 'react-native'

export type ControlKind =
  'more' | 'undo' | 'ball' | 'called' | 'swing' | 'foul' | 'contact' | 'music'
/** Any button's colors, the deck's controls and the dictation microphone. */
export type BackdropKind = keyof typeof CONTROL_COLORS
export const CONTROL_HEIGHT = 56
export const CONTROL_GAP = 8
export const CONTROL_DECK_HEIGHT = CONTROL_HEIGHT * 2 + CONTROL_GAP
/** The dictation log: four lines of this height, and its padding and border. */
export const DICTATION_LOG_LINES = 4
export const DICTATION_LOG_LINE_HEIGHT = 18
export const DICTATION_LOG_HEIGHT =
  DICTATION_LOG_LINES * DICTATION_LOG_LINE_HEIGHT + 12
export const CONTROL_COLORS = {
  more: {
    top: '#2b3a32',
    bottom: '#1c2721',
    border: '#3e5649',
    text: '#e2e8f0'
  },
  undo: {
    top: '#1a2620',
    bottom: '#1a2620',
    border: '#385243',
    text: '#ffffff'
  },
  ball: {
    top: '#1b8a5a',
    bottom: '#0f5c3b',
    border: '#34b58b',
    text: '#ffffff'
  },
  called: {
    top: '#d97706',
    bottom: '#92400e',
    border: '#e8b94f',
    text: '#ffffff'
  },
  swing: {
    top: '#c0392b',
    bottom: '#821e14',
    border: '#d56560',
    text: '#ffffff'
  },
  foul: {
    top: '#b59975',
    bottom: '#7f6445',
    border: '#cbbda8',
    text: '#171717'
  },
  contact: {
    top: '#b88656',
    bottom: '#6f4219',
    border: '#d6a575',
    text: '#ffffff'
  },
  music: {
    top: '#7c3aed',
    bottom: '#5b21b6',
    border: '#c4b5fd',
    text: '#ffffff'
  },
  /** Dictation off: grey, the microphone crossed out. */
  micOff: {
    top: '#4b5563',
    bottom: '#2d333b',
    border: '#6b7280',
    text: '#9ca3af'
  },
  /** Dictation on, ready to be held. */
  micOn: {
    top: '#2b3a32',
    bottom: '#1c2721',
    border: '#34b58b',
    text: '#ffffff'
  },
  /** Held: listening. */
  micLive: {
    top: '#c0392b',
    bottom: '#821e14',
    border: '#d56560',
    text: '#ffffff'
  }
} as const

export const controlFrame: ViewStyle = {
  height: CONTROL_HEIGHT,
  borderRadius: 12,
  borderWidth: 1,
  alignItems: 'center',
  justifyContent: 'center',
  shadowColor: '#000000',
  shadowOffset: { width: 0, height: 4 },
  shadowOpacity: 0.4,
  shadowRadius: 3,
  elevation: 4
}
