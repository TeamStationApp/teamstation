import type { MaestroDevice } from '../../../core/maestro'
import type { ProbeTile } from '../soakRecords'
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
      notice: text || (state && state !== 'playing' ? state : null)
    }
  })
  const bar = document.querySelector('[aria-label="${LABELS.bar}"]')
  const r = bar ? bar.getBoundingClientRect() : null
  return JSON.stringify({
    tiles,
    bar: bar ? { now: Number(bar.getAttribute('aria-valuenow')), max: Number(bar.getAttribute('aria-valuemax')),
      rect: { x: r.left, y: r.top, width: r.width, height: r.height } } : null,
    visible: document.visibilityState === 'visible',
    signIn: !!document.querySelector('input[type="password"]')
  })
})()`

export function parsePageRead(raw: unknown): PageRead {
  const read = (typeof raw === 'string' ? JSON.parse(raw) : raw) as PageRead
  return {
    tiles: read.tiles ?? [],
    bar: read.bar ?? null,
    visible: read.visible,
    signIn: read.signIn
  }
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

  constructor(private readonly options: ChromeOptions) {
    this.sleep = options.sleep ?? realSleep
  }

  private get device(): MaestroDevice {
    return this.options.device
  }

  private async read(): Promise<PageRead> {
    return parsePageRead(await this.options.page.evaluate(READ_SCRIPT))
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

  async skip(steps: number[] = DEFAULT_SKIPS): Promise<void> {
    for (const step of steps) {
      await this.device.tapOn({ text: step < 0 ? LABELS.back : LABELS.forward })
    }
  }

  /** The slow key held: ArrowUp down, the hold, ArrowUp up, as the keyboard sends it. */
  async slowMotion(holdMs: number): Promise<void> {
    const key = (type: string): string =>
      `window.dispatchEvent(new KeyboardEvent('${type}', { key: 'ArrowUp', bubbles: true }))`
    await this.device.evalBrowserScript({ script: key('keydown') })
    await this.sleep(holdMs)
    await this.device.evalBrowserScript({ script: key('keyup') })
  }

  async jumpToPresent(): Promise<void> {
    await this.device.tapOn({ text: LABELS.jump })
  }

  async exitAndReenter(waitMs = 10000): Promise<void> {
    await this.device.tapOn({ text: LABELS.close })
    await this.sleep(waitMs)
    await this.openAngles()
  }

  /** A reload of the page, signed in as before, then back into the multi-angle view. */
  async relaunch(): Promise<void> {
    await this.device.evalBrowserScript({ script: 'location.reload()' })
    await this.openAngles()
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
