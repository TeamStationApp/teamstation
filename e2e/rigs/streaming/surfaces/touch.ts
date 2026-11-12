import type { MaestroDevice } from '../../../core/maestro'
import { centre, findBounds, type HierarchyNode, readScreen } from './hierarchy'
import { decodePng, regionAdvancing } from './regions'
import {
  DEFAULT_SKIPS,
  LABELS,
  realSleep,
  type Sleep,
  type SoakSurfaceDriver,
  type SurfaceProbe
} from './surface'

/**
 * What the native apps and iPhone Safari share: a touch screen driven through maestro-d,
 * read from its screenshots and normalized hierarchy. The two differ only in how they
 * open the game, relaunch, and which app must be in front.
 */

export interface TouchOptions {
  name: string
  device: MaestroDevice
  /** The bundle or package that must be in front. */
  appId: string
  sleep?: Sleep
  /** Stores a probe's screenshot and returns its path in the run directory. */
  saveShot?: (name: string, png: Uint8Array) => string
  /** How far apart a probe's two screenshots are. */
  frameGapMs?: number
}

export abstract class TouchSurface implements SoakSurfaceDriver {
  readonly name: string
  protected readonly device: MaestroDevice
  protected readonly sleep: Sleep
  private lastBar: number | null = null
  private shots = 0

  constructor(protected readonly options: TouchOptions) {
    this.name = options.name
    this.device = options.device
    this.sleep = options.sleep ?? realSleep
  }

  /** Brings the game page up, from wherever the surface is. */
  protected abstract openGame(): Promise<void>
  abstract relaunch(): Promise<void>

  async join(): Promise<void> {
    await this.openGame()
    await this.openAngles()
  }

  protected async openAngles(): Promise<void> {
    await this.device.tapOn({ text: LABELS.openAngles, timeout: 30000 })
    await this.device.tapOn({
      text: LABELS.watch,
      optional: true,
      timeout: 5000
    })
    // Sound needs a tap on a phone's browser; elsewhere the prompt is never there.
    await this.device.tapOn({
      text: LABELS.tapForSound,
      optional: true,
      timeout: 2000
    })
  }

  private async hierarchy(): Promise<HierarchyNode> {
    return (await this.device.hierarchy()) as HierarchyNode
  }

  /** The controls hide while the picture plays: a tap on the view brings them back. */
  protected async control(label: string): Promise<{ x: number; y: number }> {
    let root = await this.hierarchy()
    let bounds = findBounds(root, label)
    if (bounds == null) {
      const screen = readScreen(root).screen
      if (screen != null) await this.device.tapOnPoint({ ...centre(screen) })
      await this.sleep(500)
      root = await this.hierarchy()
      bounds = findBounds(root, label)
    }
    if (bounds == null) throw new Error(`${this.name}: no "${label}" on screen`)
    return centre(bounds)
  }

  async cut(angle: string): Promise<void> {
    await this.device.tapOn({ text: `${angle}${LABELS.tileSuffix}` })
  }

  async scrub(fraction: number): Promise<void> {
    await this.control(LABELS.bar)
    const read = readScreen(await this.hierarchy())
    if (read.bar == null) throw new Error(`${this.name}: no bar on screen`)
    const { bounds } = read.bar
    const from = read.bar.fraction ?? this.lastBar ?? 0.5
    const to = Math.max(0, Math.min(1, fraction))
    const y = Math.round(bounds.y + bounds.height / 2)
    const at = (f: number): number =>
      Math.round(bounds.x + bounds.width * Math.min(0.995, Math.max(0.005, f)))
    await this.device.swipe({
      startX: at(from),
      startY: y,
      endX: at(to),
      endY: y,
      duration: 800
    })
    this.lastBar = to
  }

  async rapidScrub(fractions: number[], intervalMs = 1000): Promise<void> {
    for (const [index, fraction] of fractions.entries()) {
      if (index > 0) await this.sleep(intervalMs)
      await this.scrub(fraction)
    }
  }

  async skip(steps: number[] = DEFAULT_SKIPS): Promise<void> {
    for (const step of steps) {
      const point = await this.control(step < 0 ? LABELS.back : LABELS.forward)
      await this.device.tapOnPoint(point)
    }
  }

  /** Held on the +10 s square, as a viewer's finger is. */
  async slowMotion(holdMs: number): Promise<void> {
    const point = await this.control(LABELS.forward)
    await this.device.tapOnPoint({
      ...point,
      longPress: true,
      duration: holdMs
    })
  }

  async jumpToPresent(): Promise<void> {
    await this.device.tapOnPoint(await this.control(LABELS.jump))
  }

  async exitAndReenter(waitMs = 10000): Promise<void> {
    await this.device.tapOnPoint(await this.control(LABELS.close))
    await this.sleep(waitMs)
    await this.openAngles()
  }

  async foreground(): Promise<boolean | null> {
    const state = (await this.device.state()) as { foregroundApp?: string }
    return state.foregroundApp == null
      ? null
      : state.foregroundApp === this.options.appId
  }

  async probe(): Promise<SurfaceProbe> {
    let first: Uint8Array
    let second: Uint8Array
    let root: HierarchyNode
    try {
      first = await this.device.screenshot()
      await this.sleep(this.options.frameGapMs ?? 2000)
      second = await this.device.screenshot()
      root = await this.hierarchy()
    } catch (error) {
      return {
        tiles: null,
        bar: null,
        foreground: null,
        reason: `${this.name}: ${(error as Error).message}`
      }
    }
    const foreground = await this.foreground().catch(() => null)
    const read = readScreen(root)
    const screenshots: string[] = []
    if (this.options.saveShot != null) {
      const n = ++this.shots
      screenshots.push(
        this.options.saveShot(`${this.name}-${n}-a.png`, first),
        this.options.saveShot(`${this.name}-${n}-b.png`, second)
      )
    }
    if (read.bar?.fraction != null) this.lastBar = read.bar.fraction
    if (read.screen == null) {
      return {
        tiles: null,
        bar: null,
        foreground,
        reason: `${this.name}: empty hierarchy`,
        screenshots
      }
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
      foreground,
      screenshots
    }
  }
}
