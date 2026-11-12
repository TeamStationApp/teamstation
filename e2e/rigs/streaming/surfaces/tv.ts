import { readFileSync } from 'node:fs'

import { type HierarchyNode, readScreen } from './hierarchy'
import { decodePng, type Rect, regionAdvancing } from './regions'
import {
  DEFAULT_SKIPS,
  LABELS,
  realSleep,
  type Sleep,
  type SoakSurfaceDriver,
  type SurfaceProbe
} from './surface'

/**
 * The Apple TV app. Its remote is an XCUIRemote helper command, whose path
 * and environment come from the local settings; it takes steps such as `select`,
 * `left`, `wait:2`, `app:<bundle>` and `dump`. What the TV shows is read from the
 * helper's accessibility dump and from two NDI captures a moment apart. The remote only
 * clicks, so a slow-motion hold is the transport's rewind and fast-forward.
 */

export type TvRemote = (steps: string[]) => Promise<string>
export type TvCapture = () => Promise<Uint8Array>

export interface TvElement {
  type: string
  bounds: Rect | null
  identifier: string | null
  label: string | null
  value: string | null
  focused: boolean
}

const LINE =
  /^[\s→]*([A-Za-z][\w ]*?)(?: \([^)]*\))?, 0x[0-9a-fA-F]+(?:, pid: \d+)?(?:, \{\{(-?[\d.]+), (-?[\d.]+)\}, \{([\d.]+), ([\d.]+)\}\})?(.*)$/

function quoted(rest: string, key: string): string | null {
  const match = new RegExp(`${key}: '((?:[^'\\\\]|\\\\.)*)'`).exec(rest)
  return match == null ? null : match[1].replace(/\\'/g, "'")
}

/** Parses XCUIElement's debug description, one element per line. */
export function parseTvDump(dump: string): TvElement[] {
  const out: TvElement[] = []
  // The helper's log has Windows line ends from xcodebuild's test output.
  for (const line of dump.split(/\r?\n/)) {
    const match = LINE.exec(line)
    if (match == null) continue
    const rest = match[6] ?? ''
    const value = /, value: ([^,]+)/.exec(rest)
    out.push({
      type: match[1].trim(),
      bounds:
        match[2] == null
          ? null
          : {
              x: Number(match[2]),
              y: Number(match[3]),
              width: Number(match[4]),
              height: Number(match[5])
            },
      identifier: quoted(rest, 'identifier'),
      label: quoted(rest, 'label'),
      value: value == null ? null : value[1].trim().replace(/^'|'$/g, ''),
      focused: /\bFocused\b|hasFocus: ?(?:true|1)/.test(rest)
    })
  }
  return out
}

/** The dump as a hierarchy the shared reader understands. */
export function tvHierarchy(elements: TvElement[]): HierarchyNode {
  return {
    children: elements
      .filter(element => element.bounds != null)
      .map(element => ({
        type: element.type,
        id: element.identifier ?? undefined,
        text:
          element.label == null
            ? (element.value ?? undefined)
            : element.value == null
              ? element.label
              : `${element.label}, ${element.value}`,
        bounds: element.bounds!
      }))
  }
}

export interface TvOptions {
  remote: TvRemote
  capture: TvCapture
  /** TeamStation TV's bundle id. */
  bundleId: string
  /** The application's name as the dump's Application line gives it. */
  appName: string
  /** From the app's home to the game's multi-camera player, as remote steps. */
  joinSteps: string[]
  sleep?: Sleep
  frameGapMs?: number
  /** Clicks of the transport across the whole bar. */
  stepsPerBar?: number
  maxMoves?: number
}

function centreOf(rect: Rect): [number, number] {
  return [rect.x + rect.width / 2, rect.y + rect.height / 2]
}

export class TvSurface implements SoakSurfaceDriver {
  readonly name = 'tv'
  private readonly sleep: Sleep

  constructor(private readonly options: TvOptions) {
    this.sleep = options.sleep ?? realSleep
  }

  /**
   * What the TV shows. The helper's snapshot is empty unless the app was named
   * first in the same call, so every dump names it: in front already, it stays.
   */
  private async dump(steps: string[] = []): Promise<TvElement[]> {
    return parseTvDump(
      await this.options.remote([
        `app:${this.options.bundleId}`,
        ...steps,
        'dump'
      ])
    )
  }

  /** Moves the focus to the element with this label, by the remote's arrows, and selects it. */
  async focusAndSelect(label: string): Promise<void> {
    let elements = await this.dump()
    for (let move = 0; move <= (this.options.maxMoves ?? 12); move++) {
      // The control itself first, the angle's tile only when there is no such control.
      const target =
        elements.find(e => e.bounds != null && e.label === label) ??
        elements.find(
          e => e.bounds != null && e.label === `${label}${LABELS.tileSuffix}`
        )
      if (target == null) throw new Error(`tv: no "${label}" on screen`)
      const focused = elements.find(e => e.focused && e.bounds != null)
      if (
        focused === target ||
        (focused?.label != null && focused.label === target.label)
      ) {
        await this.options.remote(['select'])
        return
      }
      let direction = 'down'
      if (focused != null) {
        const [tx, ty] = centreOf(target.bounds!)
        const [fx, fy] = centreOf(focused.bounds!)
        direction =
          Math.abs(tx - fx) >= Math.abs(ty - fy)
            ? tx > fx
              ? 'right'
              : 'left'
            : ty > fy
              ? 'down'
              : 'up'
      }
      elements = await this.dump([direction, 'wait:0.5'])
    }
    throw new Error(`tv: could not reach "${label}"`)
  }

  async join(): Promise<void> {
    await this.options.remote([
      `app:${this.options.bundleId}`,
      'wait:3',
      ...this.options.joinSteps
    ])
  }

  /** The camera panel's selection: the angle's button, then back to the picture. */
  async cut(angle: string): Promise<void> {
    await this.focusAndSelect(angle)
  }

  async scrub(fraction: number): Promise<void> {
    const read = readScreen(tvHierarchy(await this.dump()))
    const from = read.bar?.fraction ?? 0.5
    const clicks = Math.min(
      40,
      Math.round(Math.abs(fraction - from) * (this.options.stepsPerBar ?? 20))
    )
    const key = fraction >= from ? 'right' : 'left'
    if (clicks > 0)
      await this.options.remote(Array.from({ length: clicks }, () => key))
  }

  async rapidScrub(fractions: number[], intervalMs = 1000): Promise<void> {
    for (const [index, fraction] of fractions.entries()) {
      if (index > 0) await this.sleep(intervalMs)
      await this.scrub(fraction)
    }
  }

  async skip(steps: number[] = DEFAULT_SKIPS): Promise<void> {
    await this.options.remote(steps.map(step => (step < 0 ? 'left' : 'right')))
  }

  /** Rewind on the transport, the hold, then fast-forward back. */
  async slowMotion(holdMs: number): Promise<void> {
    await this.options.remote(['left', `wait:${holdMs / 1000}`, 'right'])
  }

  async jumpToPresent(): Promise<void> {
    await this.focusAndSelect(LABELS.jump)
  }

  async exitAndReenter(waitMs = 10000): Promise<void> {
    await this.options.remote(['menu'])
    await this.sleep(waitMs)
    await this.focusAndSelect(LABELS.openAngles)
  }

  /** Home, then the app again from its icon, then back into the game's player. */
  async relaunch(): Promise<void> {
    await this.options.remote(['home', 'wait:2'])
    await this.join()
  }

  async probe(): Promise<SurfaceProbe> {
    try {
      const elements = await this.dump()
      const first = await this.options.capture()
      await this.sleep(this.options.frameGapMs ?? 2000)
      const second = await this.options.capture()
      const app = elements.find(element => element.type === 'Application')
      const foreground = app == null ? null : app.label === this.options.appName
      const read = readScreen(tvHierarchy(elements))
      if (read.screen == null) {
        return { tiles: null, bar: null, foreground, reason: 'tv: empty dump' }
      }
      const a = decodePng(first)
      const b = decodePng(second)
      const scale = a.width / (read.screen.x + read.screen.width)
      return {
        tiles: read.tiles.map(tile => ({
          angle: tile.angle,
          advancing: regionAdvancing(a, b, tile.bounds, scale),
          notice: tile.notice
        })),
        bar: read.bar?.fraction ?? null,
        foreground
      }
    } catch (error) {
      return {
        tiles: null,
        bar: null,
        foreground: null,
        reason: `tv: ${(error as Error).message}`
      }
    }
  }
}

export type ExecFile = (
  command: string,
  args: string[],
  options: { env?: Record<string, string | undefined> }
) => Promise<{ stdout: string }>

/**
 * The remote helper as a command, with the TV's id and signing team in its
 * environment. The helper prints `{"project", "log"}` and writes what `dump`
 * shows to that log, never to stdout, so the log is what this answers; a
 * helper that names no log answers its stdout.
 */
export function remoteHelper(
  helper: { command: string[]; env: Record<string, string> },
  exec: ExecFile,
  readLog: (path: string) => string = path => readFileSync(path, 'utf8')
): TvRemote {
  return async steps => {
    const [command, ...args] = helper.command
    const { stdout } = await exec(command, [...args, ...steps], {
      env: { ...process.env, ...helper.env }
    })
    const first = stdout.split('\n')[0] ?? ''
    try {
      const named = JSON.parse(first) as { log?: unknown }
      if (typeof named.log === 'string') return readLog(named.log)
    } catch {
      // Not the helper's JSON line: the command printed its answer itself.
    }
    return stdout
  }
}

/** An NDI capture as a command that writes one PNG frame to `out`. */
export function ndiCapture(
  capture: { command: string[]; out: string },
  exec: ExecFile,
  readFile: (path: string) => Uint8Array
): TvCapture {
  return async () => {
    const [command, ...args] = capture.command
    await exec(
      command,
      args.map(arg => arg.replace('{out}', capture.out)),
      {}
    )
    return readFile(capture.out)
  }
}
