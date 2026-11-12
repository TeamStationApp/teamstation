import type { MaestroDevice } from '../../../core/maestro'
import {
  centre,
  findBounds,
  type HierarchyNode,
  playerBlock,
  readScreen,
  type ScreenRead
} from './hierarchy'
import type { Rect } from './regions'
import { decodePng, regionAdvancing } from './regions'
import {
  DEFAULT_SKIPS,
  LABELS,
  realSleep,
  type Sleep,
  type SoakSurfaceDriver,
  type SurfaceProbe,
  tapIfShown
} from './surface'

/**
 * What the native apps and iPhone Safari share: a touch screen driven through maestro-d,
 * read from its screenshots and normalized hierarchy. The two differ only in how they
 * open the game, relaunch, and which app must be in front.
 */

/** How far from the screen's sides a swipe stays, as a share of its width. */
export const EDGE_MARGIN = 0.05

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
  /** The longest press the device's driver can hold in one request. */
  maxHoldMs?: number
}

export abstract class TouchSurface implements SoakSurfaceDriver {
  readonly name: string
  protected readonly device: MaestroDevice
  protected readonly sleep: Sleep
  private lastBar: number | null = null
  private shots = 0
  private notes: string[] = []
  private block: Rect | null = null

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
    // All angles is the camera pills' last: on a phone's page it can sit
    // scrolled off the row's right, so the row is swiped left to bring it in.
    if (!(await tapIfShown(this.device, { text: LABELS.openAngles }, 15000))) {
      const row = findBounds(await this.hierarchy(), 'Camera angles')
      if (row != null) {
        const y = Math.round(row.y + row.height / 2)
        await this.device.swipe({
          startX: Math.round(row.x + row.width * 0.9),
          startY: y,
          endX: Math.round(row.x + row.width * 0.1),
          endY: y,
          duration: 400
        })
      }
      await this.device.tapOn({ text: LABELS.openAngles, timeout: 15000 })
    }
    await tapIfShown(this.device, { text: LABELS.watch }, 5000)
    // Sound needs a tap on a phone's browser; elsewhere the prompt is never there.
    await tapIfShown(this.device, { text: LABELS.tapForSound }, 2000)
  }

  private async hierarchy(): Promise<HierarchyNode> {
    return (await this.device.hierarchy()) as HierarchyNode
  }

  /**
   * The controls hide while the picture plays. A press on the grid's
   * top-centre squares brings them back and does nothing else; the centre
   * squares would pause the picture, and a paused player reads as frozen.
   */
  protected async control(label: string): Promise<{ x: number; y: number }> {
    let root = await this.hierarchy()
    let bounds = findBounds(root, label)
    if (bounds == null) {
      // The block as the guard last measured it, when the tiles are hidden too.
      const block = playerBlock(readScreen(root)) ?? this.block
      if (block != null) {
        await this.device.tapOnPoint(this.gridPoint(block, 1, 0))
      }
      await this.sleep(500)
      root = await this.hierarchy()
      bounds = findBounds(root, label)
    }
    if (bounds == null) throw new Error(`${this.name}: no "${label}" on screen`)
    return centre(bounds)
  }

  takeNotes(): string[] {
    const notes = this.notes
    this.notes = []
    return notes
  }

  /**
   * The full-screen player's screen and block of videos, rejoining first when
   * the player is not up. A press-grid tap or swipe meant for the player lands
   * on whatever else is there instead: on the game page, a camera's ⋯ menu.
   */
  private async player(): Promise<{ read: ScreenRead; block: Rect }> {
    let read = readScreen(await this.hierarchy())
    let block = playerBlock(read)
    if (block == null) {
      this.notes.push('rejoined: the full-screen player was not up')
      await this.join()
      read = readScreen(await this.hierarchy())
      block = playerBlock(read)
    }
    if (block == null) {
      throw new Error(`${this.name}: the full-screen player is not up`)
    }
    this.block = block
    return { read, block }
  }

  /**
   * A point in the player's press grid: four by four squares over the block of
   * videos. Column 0's middle rows step back ten seconds, column 3's step on (a
   * hold there is slow motion), and the bottom row is the scrub line
   * (`src/app/player/pressGrid.ts`).
   */
  private gridPoint(
    block: Rect,
    column: number,
    row: number
  ): { x: number; y: number } {
    return {
      x: Math.round(block.x + (block.width * (column + 0.5)) / 4),
      y: Math.round(block.y + (block.height * (row + 0.5)) / 4)
    }
  }

  async cut(angle: string): Promise<void> {
    await this.device.tapOn({ text: `${angle}${LABELS.tileSuffix}` })
  }

  async scrub(fraction: number): Promise<void> {
    // The scrub line shows on a touch in its row; the bar's own bounds are
    // then known, and otherwise the grid's bottom row is the line.
    const { block } = await this.player()
    const row = this.gridPoint(block, 0, 3)
    await this.device.tapOnPoint(row)
    await this.sleep(300)
    const read = readScreen(await this.hierarchy())
    const screen = read.screen ?? block
    const bounds = read.bar?.bounds ?? {
      x: block.x,
      y: row.y - 12,
      width: block.width,
      height: 24
    }
    const from = read.bar?.fraction ?? this.lastBar ?? 0.5
    const to = Math.max(0, Math.min(1, fraction))
    const y = Math.round(bounds.y + bounds.height / 2)
    // Never from or to a screen edge: a swipe there is the system's back
    // gesture on Android, which leaves the player.
    const margin = screen.width * EDGE_MARGIN
    const at = (f: number): number =>
      Math.round(
        Math.min(
          screen.x + screen.width - margin,
          Math.max(
            screen.x + margin,
            bounds.x + bounds.width * Math.min(0.98, Math.max(0.02, f))
          )
        )
      )
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

  /** Ten-second steps: taps on the grid's back and forward squares, which act unseen. */
  async skip(steps: number[] = DEFAULT_SKIPS): Promise<void> {
    const { block } = await this.player()
    for (const step of steps) {
      await this.device.tapOnPoint(this.gridPoint(block, step < 0 ? 0 : 3, 1))
      await this.sleep(400)
    }
  }

  /** Held on the +10 s square, as a viewer's finger is. */
  async slowMotion(holdMs: number): Promise<void> {
    const { block } = await this.player()
    const point = this.gridPoint(block, 3, 1)
    const hold = Math.min(holdMs, this.options.maxHoldMs ?? holdMs)
    if (hold < holdMs) this.notes.push(`held ${hold} ms of ${holdMs}`)
    await this.device.tapOnPoint({
      ...point,
      longPress: true,
      duration: hold
    })
  }

  async jumpToPresent(): Promise<void> {
    await this.player()
    await this.device.tapOnPoint(await this.control(LABELS.jump))
  }

  async exitAndReenter(waitMs = 10000): Promise<void> {
    await this.player()
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
