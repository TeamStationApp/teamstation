import type { MaestroDevice } from '../../../core/maestro'
import type { ProbeTile } from '../soakRecords'
import { playerBlock } from './hierarchy'
import type { Rect } from './regions'
import {
  DEFAULT_SKIPS,
  LABELS,
  realSleep,
  type Sleep,
  type SoakSurfaceDriver,
  type SurfaceProbe,
  tapIfShown,
  TILE_NOTICE
} from './surface'

/**
 * Desktop Chrome. Every action goes through maestro-d's web surface; every reading
 * comes from a CDP page on the same tab, which only reads: each tile's video
 * `currentTime`, `paused`, `readyState`, `seeking` and decoded frames, the bar's
 * `aria-valuenow`, and the notice text.
 */

/** The part of a CDP page the reader needs. */
export interface ReadingPage {
  evaluate: (script: string) => Promise<unknown>
}

export interface VideoRead {
  angle: string
  currentTime: number | null
  paused: boolean | null
  readyState: number | null
  seeking: boolean | null
  frames: number | null
  notice: string | null
  /** The tile's box on the page, in CSS pixels. */
  rect?: Rect
}

export interface PageRead {
  tiles: VideoRead[]
  bar: {
    now: number
    max: number
    rect: { x: number; y: number; width: number; height: number }
  } | null
  visible: boolean
  signIn: boolean
  viewport?: { width: number; height: number }
}

/** Runs in the page. Tiles are named "<angle> angle"; a tile's video is inside it or under it. */
export const READ_SCRIPT = `(() => {
  const centreIn = (r, t) => {
    const x = r.left + r.width / 2, y = r.top + r.height / 2
    return x >= t.left && x <= t.right && y >= t.top && y <= t.bottom
  }
  const videos = [...document.querySelectorAll('video')]
  const tiles = [...document.querySelectorAll('[aria-label$=" angle"]')].map(el => {
    const t = el.getBoundingClientRect()
    const v = el.querySelector('video') || videos.find(v => centreIn(v.getBoundingClientRect(), t)) || null
    const q = v && v.getVideoPlaybackQuality ? v.getVideoPlaybackQuality() : null
    const state = el.dataset ? el.dataset.tileState : undefined
    const text = (el.innerText || '').trim()
    return {
      angle: el.getAttribute('aria-label').replace(/ angle$/, ''),
      currentTime: v ? v.currentTime : null,
      paused: v ? v.paused : null,
      readyState: v ? v.readyState : null,
      seeking: v ? v.seeking : null,
      frames: q ? q.totalVideoFrames : null,
      notice: text || (state && state !== 'playing' ? state : null),
      rect: { x: t.left, y: t.top, width: t.width, height: t.height }
    }
  })
  const bar = document.querySelector('[aria-label="${LABELS.bar}"]')
  const r = bar ? bar.getBoundingClientRect() : null
  return JSON.stringify({
    tiles,
    bar: bar ? { now: Number(bar.getAttribute('aria-valuenow')), max: Number(bar.getAttribute('aria-valuemax')),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height } } : null,
    visible: document.visibilityState === 'visible',
    signIn: !!document.querySelector('input[type="password"]'),
    viewport: { width: window.innerWidth, height: window.innerHeight }
  })
})()`

export function parsePageRead(raw: unknown): PageRead {
  const read = (typeof raw === 'string' ? JSON.parse(raw) : raw) as PageRead
  return {
    tiles: read.tiles ?? [],
    bar: read.bar ?? null,
    visible: read.visible,
    signIn: read.signIn,
    ...(read.viewport == null ? {} : { viewport: read.viewport })
  }
}

/** The full-screen player's block of videos on the page, or null when it is not up. */
export function pageBlock(read: PageRead): Rect | null {
  if (read.viewport == null) return null
  return playerBlock({
    screen: { x: 0, y: 0, ...read.viewport },
    tiles: read.tiles.flatMap(tile =>
      tile.rect == null
        ? []
        : [{ angle: tile.angle, bounds: tile.rect, notice: null }]
    ),
    bar: null,
    texts: []
  })
}

/** Advancing: played on by more than a quarter of the gap, with frames decoded, not paused. */
export function compareReads(
  first: PageRead,
  second: PageRead,
  gapMs: number
): ProbeTile[] {
  return second.tiles.map(after => {
    const before = first.tiles.find(tile => tile.angle === after.angle)
    let advancing: boolean | null = null
    if (
      before != null &&
      after.currentTime != null &&
      before.currentTime != null
    ) {
      const played = after.currentTime - before.currentTime
      const decoded =
        after.frames == null ||
        before.frames == null ||
        after.frames > before.frames
      advancing =
        after.paused !== true &&
        after.seeking !== true &&
        (after.readyState ?? 0) >= 2 &&
        played > gapMs / 4000 &&
        decoded
    }
    const notice =
      after.notice != null && TILE_NOTICE.test(after.notice)
        ? after.notice
        : null
    return { angle: after.angle, advancing, notice }
  })
}

export interface ChromeOptions {
  device: MaestroDevice
  page: ReadingPage
  gameUrl: string
  sleep?: Sleep
  frameGapMs?: number
}

export class ChromeSurface implements SoakSurfaceDriver {
  readonly name = 'chrome'
  private readonly sleep: Sleep
  private notes: string[] = []

  constructor(private readonly options: ChromeOptions) {
    this.sleep = options.sleep ?? realSleep
  }

  private get device(): MaestroDevice {
    return this.options.device
  }

  private async read(): Promise<PageRead> {
    return parsePageRead(await this.options.page.evaluate(READ_SCRIPT))
  }

  takeNotes(): string[] {
    const notes = this.notes
    this.notes = []
    return notes
  }

  /** The player's block of videos, rejoining first when the player is not up. */
  private async player(): Promise<Rect> {
    let block = pageBlock(await this.read())
    if (block == null) {
      this.notes.push('rejoined: the full-screen player was not up')
      await this.join()
      block = pageBlock(await this.read())
    }
    if (block == null) {
      throw new Error('chrome: the full-screen player is not up')
    }
    return block
  }

  /** A point in the press grid over the block of videos (`src/app/player/pressGrid.ts`). */
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

  /**
   * Taps a control the player hides while the picture plays: it takes no
   * pointer until the controls are up, which a press on the grid's top-centre
   * squares brings about without doing anything else, and the next press
   * hides again.
   */
  private async control(label: string): Promise<void> {
    const block = await this.player()
    // The controls may be up already, and a press on the grid then hides
    // them: the control is tried first, and the grid pressed only when it
    // takes no pointer.
    for (let attempt = 0; ; attempt++) {
      try {
        await this.device.tapOn({ text: label })
        return
      } catch (error) {
        if (
          attempt === 2 ||
          !(error as Error).message.includes('not actionable')
        )
          throw error
      }
      await this.device.tapOnPoint(this.gridPoint(block, 1, 0))
      await this.sleep(300)
    }
  }

  private async openAngles(): Promise<void> {
    await this.device.tapOn({ text: LABELS.openAngles, timeout: 30000 })
    await tapIfShown(this.device, { text: LABELS.watch }, 5000)
  }

  async join(): Promise<void> {
    await this.device.openLink({ link: this.options.gameUrl })
    await this.openAngles()
  }

  async cut(angle: string): Promise<void> {
    await this.device.tapOn({ text: `${angle}${LABELS.tileSuffix}` })
  }

  async scrub(fraction: number): Promise<void> {
    await this.player()
    const { bar } = await this.read()
    if (bar == null) throw new Error('chrome: no bar on the page')
    const { rect } = bar
    const y = Math.round(rect.y + rect.height / 2)
    const at = (f: number): number =>
      Math.round(rect.x + rect.width * Math.min(0.995, Math.max(0.005, f)))
    const from = bar.max > 0 ? bar.now / bar.max : 0.5
    await this.device.swipe({
      startX: at(from),
      startY: y,
      endX: at(fraction),
      endY: y,
      duration: 800
    })
  }

  async rapidScrub(fractions: number[], intervalMs = 1000): Promise<void> {
    for (const [index, fraction] of fractions.entries()) {
      if (index > 0) await this.sleep(intervalMs)
      await this.scrub(fraction)
    }
  }

  /** Ten-second steps: clicks on the grid's back and forward squares, as on a phone. */
  async skip(steps: number[] = DEFAULT_SKIPS): Promise<void> {
    const block = await this.player()
    for (const step of steps) {
      await this.device.tapOnPoint(this.gridPoint(block, step < 0 ? 0 : 3, 1))
      await this.sleep(400)
    }
  }

  /** The slow key held: ArrowUp down, the hold, ArrowUp up, as the keyboard sends it. */
  async slowMotion(holdMs: number): Promise<void> {
    await this.player()
    const key = (type: string): string =>
      `window.dispatchEvent(new KeyboardEvent('${type}', { key: 'ArrowUp', bubbles: true }))`
    await this.device.evalBrowserScript({ script: key('keydown') })
    await this.sleep(holdMs)
    await this.device.evalBrowserScript({ script: key('keyup') })
  }

  async jumpToPresent(): Promise<void> {
    await this.control(LABELS.jump)
  }

  async exitAndReenter(waitMs = 10000): Promise<void> {
    await this.control(LABELS.close)
    await this.sleep(waitMs)
    await this.openAngles()
  }

  /**
   * The page loaded afresh, signed in as before, then back into the
   * multi-angle view. A load of the game's address rather than a reload, which
   * has left the old page's taps hanging until they timed out.
   */
  async relaunch(): Promise<void> {
    await this.join()
  }

  async probe(): Promise<SurfaceProbe> {
    const gap = this.options.frameGapMs ?? 2000
    try {
      const first = await this.read()
      await this.sleep(gap)
      const second = await this.read()
      const bar =
        second.bar == null || second.bar.max <= 0
          ? null
          : second.bar.now / second.bar.max
      return {
        tiles: compareReads(first, second, gap),
        bar,
        foreground: second.visible,
        sessionLost: second.signIn
      }
    } catch (error) {
      return {
        tiles: null,
        bar: null,
        foreground: null,
        reason: `chrome: ${(error as Error).message}`
      }
    }
  }
}
