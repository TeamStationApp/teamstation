import {
  NAV_HIGHLIGHT_MIN_WIDTH,
  NAV_HIGHLIGHT_OVERLAP,
  NAV_HIGHLIGHT_ROOMY_OVERLAP,
  NAV_HIGHLIGHT_ROOMY_STEP,
  NAV_LABEL_INSET,
  NAV_PILL_PAD
} from './navGeometry'

export type NavTabId = 'home' | 'videos' | 'schedule' | 'search' | 'chat'

export function navTabId(id: NavTabId): string {
  return `tab-${id}`
}

export const NAV_TABS = [
  { id: 'home', label: 'Home', icon: 'home' },
  { id: 'videos', label: 'Videos', icon: 'smart_display' },
  { id: 'schedule', label: 'Schedule', icon: 'event' },
  { id: 'search', label: 'Search', icon: 'search' },
  { id: 'chat', label: 'Chat', icon: 'chat' }
] as const satisfies ReadonlyArray<{
  id: NavTabId
  label: string
  icon: string
}>

export interface TabBounds {
  width: number
  height: number
  count: number
  rtl?: boolean
}

export function slotAt(
  x: number,
  width: number,
  count: number,
  rtl = false
): number {
  'worklet'
  if (width <= 0 || count < 1 || !Number.isFinite(x)) return -1
  const physicalSlot = Math.min(
    count - 1,
    Math.max(0, Math.floor((x / width) * count))
  )
  return rtl ? count - 1 - physicalSlot : physicalSlot
}

/** Distance from the logical start edge to the start of tab `index`'s highlight. */
export function pillOffset(
  index: number,
  shellWidth: number,
  highlightWidth: number,
  count: number,
  padding: number,
  rtl = false
): number {
  'worklet'
  // The pill is anchored at the logical start, on the right in RTL.
  const inner = Math.max(0, shellWidth - 2 * padding)
  const step = count > 1 ? (inner - highlightWidth) / (count - 1) : 0
  const distance = padding + index * step
  return rtl ? -distance : distance
}

/**
 * The width of UIKit's selected highlight in a platter `shellWidth` wide:
 * neighbouring highlights overlap, so the first starts and the last ends
 * `padding` from the platter's edges. See navGeometry.ts.
 */
export function highlightWidth(
  shellWidth: number,
  count: number,
  padding: number
): number {
  'worklet'
  const inner = Math.max(0, shellWidth - 2 * padding)
  if (count < 2) return inner
  const roomy =
    (inner - NAV_HIGHLIGHT_MIN_WIDTH) / (count - 1) >= NAV_HIGHLIGHT_ROOMY_STEP
  const overlap = roomy ? NAV_HIGHLIGHT_ROOMY_OVERLAP : NAV_HIGHLIGHT_OVERLAP
  const width = (inner + (count - 1) * overlap) / count
  return Math.min(
    inner,
    roomy ? Math.max(NAV_HIGHLIGHT_MIN_WIDTH, width) : width
  )
}

/**
 * How far tab `index`'s icon and label move from the centre of its equal
 * slot to the centre of its highlight, as UIKit places them.
 */
export function tabContentOffset(
  index: number,
  shellWidth: number,
  highlight: number,
  count: number,
  padding: number,
  rtl = false
): number {
  'worklet'
  const start = pillOffset(index, shellWidth, highlight, count, padding)
  const offset = start + highlight / 2 - ((index + 0.5) * shellWidth) / count
  return rtl ? -offset : offset
}

/** Coordinates are local to the pressable row; its full slot height sets the margin. */
export function dragOutcome(
  x: number,
  y: number,
  bounds: TabBounds
): number | null {
  'worklet'
  const { height, width, count } = bounds
  if (
    height <= 0 ||
    !Number.isFinite(y) ||
    x < -height ||
    x > width + height ||
    y < -height ||
    y > height * 2
  )
    return null
  const slot = slotAt(x, width, count, bounds.rtl)
  return slot < 0 ? null : slot
}

/** The selected tab follows its slot on each frame of a shell resize. */
export function pillFrame(
  index: number,
  shellWidth: number,
  highlight: number,
  count: number,
  padding: number,
  rtl: boolean
): { width: number; x: number } {
  'worklet'
  const slot = Math.max(0, Math.min(index, count - 1))
  const inner = Math.max(0, shellWidth - 2 * padding)
  const width = Math.max(0, Math.min(highlight, inner))
  return {
    width,
    x: pillOffset(slot, shellWidth, width, count, padding, rtl)
  }
}

/**
 * iOS's largest standard text size is 23/17 (1.35×) and its first
 * accessibility size 28/17 (1.65×). Android's accessibility steps start at 1.5×.
 */
const ACCESSIBILITY_FONT_SCALE = 1.4

/**
 * The width a label may take inside a capsule highlight `width` wide and
 * `height` tall, its bottom NAV_LABEL_INSET above the highlight's: the chord
 * between the rounded ends at that height. Its upper corners, nearer the
 * middle, have more room.
 */
export function labelRoom(width: number, height: number): number {
  const radius = height / 2
  const rise = Math.max(0, radius - NAV_LABEL_INSET)
  const inset = radius - Math.sqrt(Math.max(0, radius * radius - rise * rise))
  return Math.max(0, width - 2 * inset)
}

/** The longest label, Schedule, occupies under 48pt in the app's 10pt semibold font. */
export function capsuleLabels(
  shellWidth: number,
  pillHeight: number,
  fontScale: number
): { points: number; lineHeight: number; separate: boolean } {
  const longestLabelWidth = 48
  const count = NAV_TABS.length
  const slotWidth = shellWidth / count
  // Fit visual type to one slot while keeping the full accessible name.
  const scale = Math.min(
    fontScale,
    Math.max(0, slotWidth - NAV_PILL_PAD) / longestLabelWidth,
    2
  )
  const points = 10 * scale
  const lineHeight = Math.ceil(points * 1.25)
  const highlight = highlightWidth(shellWidth, count, NAV_PILL_PAD)
  const step =
    (Math.max(0, shellWidth - 2 * NAV_PILL_PAD) - highlight) / (count - 1)
  const label = longestLabelWidth * scale
  // As on UIKit's bar, the label sits inside the selected highlight and clear
  // of its rounded ends, with room to spare beside its neighbours' labels. It
  // moves to its own row only at accessibility sizes or when it would not fit.
  const separate =
    fontScale >= ACCESSIBILITY_FONT_SCALE ||
    label > step - NAV_PILL_PAD ||
    label > labelRoom(highlight, pillHeight)
  return { points, lineHeight, separate }
}
