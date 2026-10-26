import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { Dimensions, type ScaledSize, useWindowDimensions } from 'react-native'

import { TABLET_MAX } from '../components/useBreakpoint'
import { deviceStorage } from '../platform/deviceStorage'

/** How wide Tess's chat column is beside the app until it is dragged. */
export const TESS_COLUMN_WIDTH = 400
/** The narrowest the column is dragged to. */
export const TESS_MIN_WIDTH = 320
/** The widest, on a window wide enough to keep the pane its own room. */
export const TESS_MAX_WIDTH = 720
/** What the pane keeps however wide the column is dragged. */
export const TESS_PANE_MIN_WIDTH = 520
/** How far an arrow key moves the divider. */
export const TESS_WIDTH_STEP = 16
/** Where this device keeps the width it was dragged to. */
export const TESS_WIDTH_KEY = 'tess.columnWidth'

/**
 * Whether a window this wide shows Tess beside the app rather than over it:
 * wider than a portrait tablet, so the pane keeps at least a tablet's width.
 */
export function tessIsWide(windowWidth: number): boolean {
  return windowWidth > TABLET_MAX
}

/**
 * The widest the column may be on a window this wide: 720, or less where
 * the pane would otherwise have under 520.
 */
export function tessMaxWidth(windowWidth: number): number {
  return Math.max(
    TESS_MIN_WIDTH,
    Math.min(TESS_MAX_WIDTH, windowWidth - TESS_PANE_MIN_WIDTH)
  )
}

/** A width between the narrowest and `max`, in whole points. */
export function clampTessWidth(width: number, max: number): number {
  return Math.round(Math.min(max, Math.max(TESS_MIN_WIDTH, width)))
}

/**
 * Whether the window is wide enough for Tess's column, as state that changes
 * only when the window crosses that width: the Shell reads this, and a window
 * dragged wider or narrower redraws nothing in between.
 */
export function useTessWide(): boolean {
  const [wide, setWide] = useState(() =>
    tessIsWide(Dimensions.get('window').width)
  )
  // Set only on a change: setting the same value can still redraw once.
  const shown = useRef(wide)
  useEffect(() => {
    const subscription = Dimensions.addEventListener(
      'change',
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- DisplayMetrics, which it suggests, is not in react-native's public types
      ({ window }: { window: ScaledSize }) => {
        const next = tessIsWide(window.width)
        if (next === shown.current) return
        shown.current = next
        setWide(next)
      }
    )
    return () => {
      subscription.remove()
    }
  }, [])
  return wide
}

/** What the divider on the column's right edge is given. */
export interface TessDividerProps {
  /** The column's width now. */
  width: number
  /** The widest it may be on this window. */
  max: number
  /** A new width; `done` at the end of a drag or a key press. */
  onResize: (width: number, done: boolean) => void
}

/**
 * The width Tess's column was dragged to, for the column and the pane beside
 * it: kept here rather than in the Shell, so only what reads it redraws
 * while the divider moves.
 *
 * Kept on this device too: read back as the first reader mounts, when the
 * app starts, and saved when a drag or a key press ends. A storage that
 * refuses, or holds nothing readable, leaves the default.
 */
let dragged = TESS_COLUMN_WIDTH
const readers = new Set<() => void>()
// Each read and each change counts here: a read answers only if nothing
// came after it, so a drag before the saved width arrives keeps the drag.
let changes = 0

function subscribe(reader: () => void): () => void {
  if (readers.size === 0) restoreWidth()
  readers.add(reader)
  return () => {
    readers.delete(reader)
  }
}

function changed(width: number): void {
  dragged = width
  for (const reader of readers) reader()
}

function restoreWidth(): void {
  const read = ++changes
  readSavedWidth()
    .then(saved => {
      if (read === changes) changed(saved ?? TESS_COLUMN_WIDTH)
    })
    .catch(() => undefined)
}

/** A new width for the column; `done` saves it, at the end of a drag. */
function setTessWidth(width: number, done: boolean): void {
  changes++
  changed(width)
  if (done) saveWidth(width)
}

/**
 * The column's width on this window, within its limits, and how to change
 * it: `done` is the end of a drag or a key press, which is saved.
 */
export function useTessWidth(): {
  width: number
  max: number
  setWidth: (width: number, done: boolean) => void
} {
  const width = useSyncExternalStore(subscribe, () => dragged)
  const max = tessMaxWidth(useWindowDimensions().width)
  return { width: clampTessWidth(width, max), max, setWidth: setTessWidth }
}

async function readSavedWidth(): Promise<number | undefined> {
  const saved = Number(await deviceStorage.getItem(TESS_WIDTH_KEY))
  return Number.isFinite(saved) && saved > 0 ? saved : undefined
}

/** Saves the width; one the storage refuses lasts until the app restarts. */
function saveWidth(width: number): void {
  deviceStorage
    .setItem(TESS_WIDTH_KEY, String(Math.round(width)))
    .catch(() => undefined)
}
