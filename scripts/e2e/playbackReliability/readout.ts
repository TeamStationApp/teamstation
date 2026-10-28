/**
 * The player's own account of each tile, from its `?debug=1` readout
 * (`useMultiCam`'s `showReadout`), as the suite reads it off the screen's
 * accessibility text:
 *
 *   1st       buf 3.2s  ready 4  at 2729.3  to 2731.0  paused  ok  waits short 4.1s
 *   clock 812.4s  held  ahead ≤ 30s  heard 1st  gate all-short 4.1s
 *
 * Fields after the fixed ones are read by name, so a line that grows keeps
 * parsing.
 */
export interface TileReadout {
  name: string
  bufSec: number
  ready: number
  atSec: number
  toSec: number | null
  playing: boolean
  stalledSec: number | null
  parked: string | null
  leftOut: boolean
}

export interface ClockReadout {
  clockSec: number
  held: boolean
  gate: string | null
}

export interface Readout {
  atMs: number
  tiles: TileReadout[]
  clock: ClockReadout | null
}

const TILE =
  /^(.*?)\s+buf (-?[0-9.]+)s\s+ready (\d)\s+at (-?[0-9.]+)\s+to (-?[0-9.]+|—)\s+(playing|paused)\s+(ok|stalled (-?[0-9.]+)s)(.*)$/
const CLOCK = /^clock (-?[0-9.]+)s\s+(playing|held)(.*)$/

/** One snapshot of the readout's lines; lines that are not readout lines are ignored. */
export function parseReadout(lines: string[], atMs: number): Readout {
  const tiles: TileReadout[] = []
  let clock: ClockReadout | null = null
  for (const raw of lines) {
    const line = raw.trim()
    const tile = TILE.exec(line)
    if (tile != null) {
      const rest = tile[9]
      tiles.push({
        name: tile[1].trim(),
        bufSec: Number(tile[2]),
        ready: Number(tile[3]),
        atSec: Number(tile[4]),
        toSec: tile[5] === '—' ? null : Number(tile[5]),
        playing: tile[6] === 'playing',
        stalledSec: tile[8] == null ? null : Number(tile[8]),
        parked: /parked (\S+)/.exec(rest)?.[1] ?? null,
        leftOut: rest.includes('left out')
      })
      continue
    }
    const held = CLOCK.exec(line)
    if (held != null) {
      clock = {
        clockSec: Number(held[1]),
        held: held[2] === 'held',
        gate: /gate (.+)$/.exec(held[3])?.[1].trim() ?? null
      }
    }
  }
  return { atMs, tiles, clock }
}

export interface ReadoutRules {
  /** A tile whose position stands still longer than this, while meant to play, froze. */
  freezeMs: number
  /** Slower than this fraction of real time over the window is a stutter. */
  minRate: number
}

/**
 * The readout is redrawn once a second, on the grid's watchdog tick, and that
 * tick is late whenever the page is busy — so two reads more than a second
 * apart can show the same position over a picture that never stopped. It
 * judges only what it can see: a stall of several seconds, and the rate over
 * the whole window. Short freezes are the screenshots', the counter's and the
 * webcam's to find.
 */
export const READOUT_RULES: ReadoutRules = { freezeMs: 2500, minRate: 0.9 }

export interface ReadoutVerdict {
  /** Per tile: how far its position moved per real second, as a fraction of 1. */
  rates: Record<string, number | null>
  freezes: Array<{ tile: string; fromMs: number; toMs: number }>
  heldMs: number
  pass: boolean
  reasons: string[]
}

/** How old the readout can be when read. */
export const STALE_MS = 1000

/**
 * Judges a play window from readout snapshots. A tile froze when its `at`
 * stood still for longer than `freezeMs`; the grid stuttered when two reads
 * in a row found it held, or when a tile moved at less than `minRate` of real
 * time. The viewer never
 * pauses inside a play window, so a paused tile is no excuse.
 */
export function judgeReadout(
  window: Readout[],
  rules: ReadoutRules = READOUT_RULES
): ReadoutVerdict {
  // The readout is up to a second old when read: reads in the window's first
  // second that still find the grid held are the landing it had not caught up
  // with yet — a scrub's old place, which would read as playing backwards —
  // and not playback. A hold that lasts past that second is still judged.
  const staleUntil = (window[0]?.atMs ?? 0) + STALE_MS
  let lead = 0
  while (
    lead < window.length - 2 &&
    window[lead].clock?.held === true &&
    window[lead].atMs < staleUntil
  )
    lead += 1
  const snapshots = window.slice(lead)
  const reasons: string[] = []
  const names = [...new Set(snapshots.flatMap(s => s.tiles.map(t => t.name)))]
  const rates: Record<string, number | null> = {}
  const freezes: ReadoutVerdict['freezes'] = []
  for (const name of names) {
    const series = snapshots
      .map(s => ({ atMs: s.atMs, tile: s.tiles.find(t => t.name === name) }))
      .filter((s): s is { atMs: number; tile: TileReadout } => s.tile != null)
    const first = series[0]
    const last = series[series.length - 1]
    rates[name] =
      series.length >= 2 && last.atMs > first.atMs
        ? (last.tile.atSec - first.tile.atSec) /
          ((last.atMs - first.atMs) / 1000)
        : null
    let stillFrom: number | null = null
    for (let i = 1; i < series.length; i++) {
      const same = series[i].tile.atSec === series[i - 1].tile.atSec
      if (same) stillFrom ??= series[i - 1].atMs
      if ((!same || i === series.length - 1) && stillFrom != null) {
        const toMs = same ? series[i].atMs : series[i - 1].atMs
        if (toMs - stillFrom > rules.freezeMs)
          freezes.push({ tile: name, fromMs: stillFrom, toMs })
        stillFrom = null
      }
    }
    // The readout's position is up to a second old when read, at either end
    // of the window: a second's worth of the rate is that, not playback.
    const rate = rates[name]
    const span = series.length >= 2 ? last.atMs - first.atMs : 0
    const allowed = span > 0 ? rules.minRate - 1000 / span : rules.minRate
    if (rate != null && rate < allowed) {
      reasons.push(`${name} moved at ${rate.toFixed(2)}× real time`)
    }
  }
  for (const freeze of freezes) {
    reasons.push(
      `${freeze.tile} stood still for ${freeze.toMs - freeze.fromMs} ms`
    )
  }
  // Held across two reads in a row, so that one late redraw is not a hold.
  let heldMs = 0
  for (let i = 1; i < snapshots.length; i++) {
    if (
      snapshots[i - 1].clock?.held === true &&
      snapshots[i].clock?.held === true
    )
      heldMs += snapshots[i].atMs - snapshots[i - 1].atMs
  }
  if (heldMs > 0) reasons.push(`the grid held for ${heldMs} ms`)
  if (names.length === 0) reasons.push('no readout lines')
  return { rates, freezes, heldMs, pass: reasons.length === 0, reasons }
}
