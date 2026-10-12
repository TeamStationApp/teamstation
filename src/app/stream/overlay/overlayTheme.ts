import { Platform } from 'react-native'

/**
 * The streaming screen's chrome, drawn to TS Cameraman's measurements so a
 * phone recording for TeamStation looks like the camera screen an operator
 * already knows. Every number here is in points and comes from Cameraman's
 * SwiftUI (`CameraView`, `ZoomScaleView`, `ThermalBadge`, `BatteryBadge`,
 * `BroadcastControls`), not from the app's theme: the overlay sits on a camera
 * picture, which looks the same in either of the app's colour schemes.
 */

/** SF Pro Rounded on iOS; Android has no rounded system face. */
export const ROUNDED_FONT = Platform.OS === 'ios' ? 'ui-rounded' : undefined
/** SF Mono on iOS, the system monospace elsewhere. */
export const MONOSPACE_FONT =
  Platform.OS === 'ios' ? 'ui-monospace' : 'monospace'

/** Black at 45 %, behind every round button, the name and the inactive zoom pills. */
export const CHROME_BLACK = 'rgba(0, 0, 0, 0.45)'
export const WHITE = '#FFFFFF'

/** The corner rows' inset from the safe area, and the gap between their items. */
export const EDGE_INSET = 24
export const ROW_SPACING = 10
/** The top-right row's gap before the zoom rail's edge. */
export const RAIL_TRAILING = 16

/** A round button: a `title2` glyph with 14 pt of padding on the 45 % disc. */
export const BUTTON_GLYPH = 22
export const BUTTON_PADDING = 14
export const BUTTON_SIZE = BUTTON_GLYPH + 2 * BUTTON_PADDING

/** The angle name: `headline` (17 pt semibold), padding 12×8, radius 10. */
export const NAME_BADGE = {
  fontSize: 17,
  fontWeight: '600',
  paddingHorizontal: 12,
  paddingVertical: 8,
  radius: 10
} as const

/**
 * The height every pill in the top-right row shares: the thermal pill's 13 pt
 * line with 8 pt above and below it.
 */
export const PILL_HEIGHT = 32
export const PILL_RADIUS = 8

/** The idle pill: "Press record to start stream", 10 pt heavy rounded, tracking 0.5. */
export const IDLE_BLUE = '#2E7AF2'
export const IDLE_PILL = {
  fontSize: 10,
  letterSpacing: 0.5,
  paddingHorizontal: 10
} as const

/** Cameraman's broadcasting pill, pulsing between these two reds. */
export const PULSE_DARK = '#C7292E'
export const PULSE_BRIGHT = '#FF525C'
/** One way of the pulse; it repeats and reverses, eased in and out. */
export const PULSE_SECONDS = 0.7
export const LIVE_PILL = {
  fontSize: 13,
  letterSpacing: 1,
  paddingHorizontal: 14,
  square: 11,
  squareRadius: 2,
  gap: 8
} as const

/** The pill once somebody has ended this camera on the server. */
export const ENDED_RED = '#8C3B40'

/** Cool, Fair, Warm and Hot: the level colours the thermal pill is filled with. */
export const THERMAL_COLORS = {
  cool: '#2E7AF2',
  fair: '#FAD62E',
  warm: '#FA851F',
  hot: '#F23D47'
} as const
export const THERMAL = {
  fontSize: 13,
  letterSpacing: 1,
  paddingHorizontal: 16,
  radius: 8,
  /** The fill's opacity at rest, and the pulse's (or Hot's band's) peak. */
  fillOpacity: 0.18,
  bandOpacity: 0.38,
  /** Hot's band is ¾ of the pill's height, faded over a fifth of the pill at each end. */
  bandFraction: 0.75,
  fadeFraction: 0.2,
  /** Seconds for one pulse (Cool, Fair, Warm), or one pass of Hot's band. */
  cycleSeconds: { cool: 3, fair: 3, warm: 2, hot: 1 }
} as const

/** Green, or Low Power Mode yellow under `lowPercent`. */
export const BATTERY = {
  green: '#33C759',
  low: '#D9A814',
  lowPercent: 20,
  fontSize: 13,
  letterSpacing: 1,
  paddingHorizontal: 14,
  radius: 8,
  bolt: 10,
  boltGap: 4,
  nubWidth: 4,
  /** The nub's height, as a fraction of the pill's. */
  nubHeight: 0.42,
  nubGap: 1
} as const

/** The zoom rail: 32 pt pills, five ticks a segment, the readout to their left. */
export const ZOOM = {
  pill: 32,
  /** `caption2`. */
  fontSize: 11,
  ticksPerSegment: 5,
  tickThickness: 1.5,
  tickWidth: 10,
  activeTickWidth: 14,
  tickOpacity: 0.38,
  /** The lit pill: white, or yellow, at 90 %, with a black label. */
  activeFill: 'rgba(255, 255, 255, 0.9)',
  activeDigitalFill: 'rgba(255, 214, 10, 0.9)',
  readoutMinWidth: 28,
  readoutGap: 6,
  /** Past the longest lens, digital zoom is drawn in the system yellow. */
  digital: '#FFD60A',
  /** A vertical drag only starts zooming once it has moved this far. */
  dragMinimum: 12
} as const

/** Record: a 64 pt disc 24 pt above the bottom of the glass. */
export const RECORD = {
  size: 64,
  bottom: 24,
  idle: '#8C3B40',
  idleDot: '#E6E3E2',
  idleDotSize: 24,
  live: '#F23D47',
  liveSquare: 20,
  liveSquareRadius: 3
} as const

/** Slide to Stop: a 272×58 track whose 52 pt knob commits at 80 %. */
export const SLIDE = {
  trackWidth: 272,
  trackHeight: 58,
  knob: 52,
  /** The knob's inset inside the track at either end. */
  knobInset: 3,
  commitFraction: 0.8,
  trackColor: 'rgba(242, 61, 71, 0.72)',
  /** An app icon's corner, as a fraction of its side. */
  trackRadius: Math.round(58 * 0.28),
  knobRadius: Math.round(52 * 0.28),
  fontSize: 17,
  labelTrailing: 8
} as const

/** The radar's speeds: `title2` semibold on black at 55 %, inset 24 below and 66 from the trailing edge. */
export const RADAR = {
  fontSize: 22,
  background: 'rgba(0, 0, 0, 0.55)',
  radius: 12,
  paddingHorizontal: 12,
  paddingVertical: 8,
  bottom: 24,
  trailing: EDGE_INSET + ZOOM.pill + ROW_SPACING
} as const

/**
 * About half an inch at the top and bottom of the glass, where a swipe belongs
 * to the system: a pinch that starts there leaves the zoom alone.
 */
export const SYSTEM_EDGE_BAND = 80
