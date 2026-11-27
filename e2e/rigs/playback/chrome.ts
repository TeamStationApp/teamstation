import type { Found } from './device'

/**
 * Chrome on an Android phone, read through maestro-d's `evalWebViewScript`,
 * which runs a script in Chrome's page over its DevTools socket on the
 * phone's side.
 *
 * Android's accessibility tree is the wrong source for a web page in Chrome:
 * once the game page's player sticks to the top it drops out of the tree, and
 * the rest goes stale — chips reported where they were, the WebView at half
 * its height. The page itself knows where everything is. This reads it, and
 * nothing else: it never touches the player; taps and drags stay real input.
 */
export interface PageNode {
  role: string
  text: string
  x: number
  y: number
  w: number
  h: number
}

/** Every element with text of its own or an accessible name, and its box in CSS pixels. */
export const NODES_SCRIPT = `JSON.stringify((() => {
  const out = []
  for (const element of document.querySelectorAll('body *')) {
    let own = ''
    for (const child of element.childNodes) if (child.nodeType === 3) own += child.textContent
    const text = (element.getAttribute('aria-label') ?? own).trim()
    if (text === '') continue
    const box = element.getBoundingClientRect()
    if (box.width === 0 || box.height === 0) continue
    out.push({ role: element.getAttribute('role') ?? element.tagName.toLowerCase(), text, x: box.x, y: box.y, w: box.width, h: box.height })
  }
  return { dpr: devicePixelRatio, innerHeight, fullscreen: document.fullscreenElement != null, nodes: out }
})())`

/** Installs the pointer log once, then hands over and empties what it holds. */
export const POINTERS_SCRIPT = `JSON.stringify((() => {
  const log = (window.__pbrPointers ??= [])
  if (window.__pbrPointersOn !== true) {
    window.__pbrPointersOn = true
    for (const type of ['pointerdown', 'pointermove', 'pointerup', 'pointercancel', 'lostpointercapture']) {
      document.addEventListener(type, event => {
        log.push([event.type, Math.round(event.clientX), Math.round(event.clientY), Math.round(event.timeStamp)])
        if (log.length > 2000) log.splice(0, log.length - 2000)
      }, { capture: true, passive: true })
    }
  }
  return log.splice(0, log.length)
})())`

/** Each video element's state, with every buffered range. */
export const VIDEOS_SCRIPT = `JSON.stringify([...document.querySelectorAll('video')].map(video => ({
  currentTime: video.currentTime,
  paused: video.paused,
  readyState: video.readyState,
  networkState: video.networkState,
  seeking: video.seeking,
  error: video.error == null ? null : { code: video.error.code, message: video.error.message },
  buffered: Array.from({ length: video.buffered.length }, (_, index) => [video.buffered.start(index), video.buffered.end(index)]),
  seekable: Array.from({ length: video.seekable.length }, (_, index) => [video.seekable.start(index), video.seekable.end(index)]),
  duration: Number.isFinite(video.duration) ? video.duration : String(video.duration),
  label: video.closest('[aria-label]')?.getAttribute('aria-label') ?? null,
  quality: typeof video.getVideoPlaybackQuality === 'function'
    ? { dropped: video.getVideoPlaybackQuality().droppedVideoFrames, total: video.getVideoPlaybackQuality().totalVideoFrames }
    : null
})))`

/** One video element as `VIDEOS_SCRIPT` reports it, as far as frames go. */
export interface VideoFrames {
  label: string | null
  quality: { dropped: number; total: number } | null
}

/**
 * Each tile's frames between two reads of the page's videos: how many it
 * showed and how many it dropped. A tile is named by its picture's label
 * ("Home angle" is Home); a video that was not there at the first read, or
 * reports no counts, is left out.
 */
export function framesOver(
  before: VideoFrames[],
  after: VideoFrames[]
): Array<{ tile: string; dropped: number; total: number }> {
  return after.flatMap((video, index) => {
    const tile = (video.label ?? `video ${index + 1}`).replace(/ angle$/, '')
    const was = before.find(one => one.label === video.label)?.quality
    if (video.quality == null || was == null) return []
    return [
      {
        tile,
        dropped: video.quality.dropped - was.dropped,
        total: video.quality.total - was.total
      }
    ]
  })
}

/**
 * The page's boxes on the glass, in device pixels. The page's top on the
 * screen moves as Chrome hides and shows its toolbar; its bottom stays where
 * the toolbar showing left it, so the top is that bottom less the page's own
 * height. With the toolbar fully hidden Chrome also draws the page down under
 * the gesture bar, and that sum lands above the page; the page then starts
 * under the status bar (`pageTop`). In full screen the page is the whole
 * display and starts at its top.
 */
export function toScreen(
  page: {
    dpr: number
    innerHeight: number
    fullscreen?: boolean
    nodes: PageNode[]
  },
  contentBottom: number,
  pageTop = 0
): Found[] {
  const top =
    page.fullscreen === true
      ? 0
      : Math.max(pageTop, contentBottom - page.innerHeight * page.dpr)
  return page.nodes.map(node => ({
    type: node.role,
    text: node.text,
    rect: {
      x: node.x * page.dpr,
      y: top + node.y * page.dpr,
      w: node.w * page.dpr,
      h: node.h * page.dpr
    }
  }))
}

/** A full-page cover of one colour, or its removal. */
export function coverScript(color: 'black' | 'white' | null): string {
  return `(() => {
  let cover = document.getElementById('__pbrCover')
  if (${JSON.stringify(color)} === null) { cover?.remove(); return }
  if (cover == null) {
    cover = document.createElement('div')
    cover.id = '__pbrCover'
    cover.style.cssText = 'position:fixed;inset:0;z-index:2147483647'
    document.documentElement.appendChild(cover)
  }
  cover.style.background = ${JSON.stringify(color)}
})()`
}

/**
 * The debug readout's lines and nothing else: one query, no layout, so it can
 * be asked several times a second without slowing the page it is measuring.
 */
export const READOUT_SCRIPT = `JSON.stringify(Array.from(document.querySelectorAll('[data-testid="playerReadout"] > *'), line => line.textContent ?? ''))`

/** The slice of a maestro-d device that reads Chrome's page on Android. */
export interface WebViewReader {
  evalWebViewScript: (options: { script: string }) => Promise<unknown>
}

/** What a maestro-d script step answered: the value it returned, as text. */
function answered(result: unknown): string | undefined {
  const data = (result as { data?: unknown } | null)?.data
  return typeof data === 'string' ? data : undefined
}

export class ChromePage {
  constructor(private readonly device: WebViewReader) {}

  private async value(expression: string): Promise<string | undefined> {
    return answered(
      await this.device.evalWebViewScript({ script: `return ${expression}` })
    )
  }

  /**
   * Covers the page in one colour, above everything, or takes the cover away
   * (null).
   */
  async cover(color: 'black' | 'white' | null): Promise<void> {
    await this.device.evalWebViewScript({ script: coverScript(color) })
  }

  /** Confirm the typing destination without reading its value. */
  async passwordFocused(): Promise<boolean> {
    return (
      (await this.value(
        'String(document.activeElement instanceof HTMLInputElement && document.activeElement.type === "password")'
      )) === 'true'
    )
  }

  /** The page's size in CSS pixels and how many device pixels each is. */
  async viewport(): Promise<{
    dpr: number
    innerWidth: number
    innerHeight: number
  }> {
    return JSON.parse(
      (await this.value(
        'JSON.stringify({ dpr: devicePixelRatio, innerWidth, innerHeight })'
      )) ?? '{}'
    ) as { dpr: number; innerWidth: number; innerHeight: number }
  }

  /** The player's debug readout, line by line; empty when it is not drawn. */
  async readout(): Promise<string[]> {
    return JSON.parse((await this.value(READOUT_SCRIPT)) ?? '[]') as string[]
  }

  /** The page's elements, in the screen's pixels. */
  async nodes(contentBottom: number, pageTop = 0): Promise<Found[]> {
    const value = await this.value(NODES_SCRIPT)
    if (value == null) throw new Error('the page did not answer')
    return toScreen(JSON.parse(value), contentBottom, pageTop)
  }

  /**
   * The pointer events the page has received since the last call, recorded
   * by a passive listener installed on first use — evidence for a drag that
   * landed somewhere else than it was dragged to. Reading only.
   */
  async pointers(): Promise<unknown> {
    return JSON.parse((await this.value(POINTERS_SCRIPT)) ?? 'null')
  }

  /**
   * Every video element's own state — position, readiness, network state,
   * error, and each buffered range — to save beside a step that failed.
   */
  async videos(): Promise<unknown> {
    return JSON.parse((await this.value(VIDEOS_SCRIPT)) ?? 'null')
  }
}
