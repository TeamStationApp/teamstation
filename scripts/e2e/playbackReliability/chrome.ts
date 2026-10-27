import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import type { Found } from './device'

const run = promisify(execFile)

/**
 * Chrome on an Android phone, read through its DevTools socket.
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

/**
 * The bottom of Android's status bar, from `dumpsys window`: the highest a
 * browser page can start when its toolbar is hidden. Zero when it is not said.
 */
export function statusBarBottom(dumpsys: string): number {
  const frame = /type=statusBars frame=\[\d+,\d+\]\[\d+,(\d+)\]/.exec(dumpsys)
  return frame == null ? 0 : Number(frame[1])
}

export interface Tab {
  id: string
  type: string
  url: string
  webSocketDebuggerUrl: string
}

/** One DevTools call on a tab's socket. */
async function call(
  socketUrl: string,
  method: string,
  params: Record<string, unknown>
): Promise<unknown> {
  const socket = new WebSocket(socketUrl)
  await new Promise((resolve, reject) => {
    socket.addEventListener('open', resolve, { once: true })
    socket.addEventListener('error', reject, { once: true })
  })
  try {
    socket.send(JSON.stringify({ id: 1, method, params }))
    const reply = await new Promise<{
      result?: unknown
      error?: { message: string }
    }>(resolve => {
      socket.addEventListener(
        'message',
        event => {
          resolve(JSON.parse(String(event.data)))
        },
        { once: true }
      )
    })
    if (reply.error != null)
      throw new Error(`${method}: ${reply.error.message}`)
    return reply.result
  } finally {
    socket.close()
  }
}

export class ChromePage {
  private constructor(
    private readonly port: number,
    private readonly tab: Tab
  ) {}

  /**
   * Forwards the phone's DevTools socket to `port`, closes every tab but one
   * so the suite always reads the page it is driving, and holds that one.
   */
  static async open(
    serial: string,
    port: number,
    adb = process.env.ADB_PATH ?? 'adb'
  ): Promise<ChromePage> {
    await run(adb, [
      '-s',
      serial,
      'forward',
      `tcp:${port}`,
      'localabstract:chrome_devtools_remote'
    ])
    const tabs = (await (
      await fetch(`http://127.0.0.1:${port}/json`)
    ).json()) as Tab[]
    const pages = tabs.filter(tab => tab.type === 'page')
    if (pages.length === 0) throw new Error('Chrome has no tab open')
    for (const extra of pages.slice(1)) {
      await fetch(`http://127.0.0.1:${port}/json/close/${extra.id}`)
    }
    return new ChromePage(port, pages[0])
  }

  /** Goes to an address in the held tab, as typing it in the address bar would. */
  async navigate(url: string): Promise<void> {
    await call(this.tab.webSocketDebuggerUrl, 'Page.navigate', { url })
  }

  /**
   * Covers the page in one colour, above everything, or takes the cover away
   * (null): what the camera is calibrated against.
   */
  async cover(color: 'black' | 'white' | null): Promise<void> {
    await call(this.tab.webSocketDebuggerUrl, 'Runtime.evaluate', {
      expression: coverScript(color)
    })
  }

  /** The page's size in CSS pixels and how many device pixels each is. */
  async viewport(): Promise<{
    dpr: number
    innerWidth: number
    innerHeight: number
  }> {
    const result = (await call(
      this.tab.webSocketDebuggerUrl,
      'Runtime.evaluate',
      {
        expression:
          'JSON.stringify({ dpr: devicePixelRatio, innerWidth, innerHeight })',
        returnByValue: true
      }
    )) as { result?: { value?: string } }
    return JSON.parse(result.result?.value ?? '{}') as {
      dpr: number
      innerWidth: number
      innerHeight: number
    }
  }

  /** The player's debug readout, line by line; empty when it is not drawn. */
  async readout(): Promise<string[]> {
    const result = (await call(
      this.tab.webSocketDebuggerUrl,
      'Runtime.evaluate',
      { expression: READOUT_SCRIPT, returnByValue: true }
    )) as { result?: { value?: string } }
    return JSON.parse(result.result?.value ?? '[]') as string[]
  }

  /** The page's elements, in the screen's pixels. */
  async nodes(contentBottom: number, pageTop = 0): Promise<Found[]> {
    const result = (await call(
      this.tab.webSocketDebuggerUrl,
      'Runtime.evaluate',
      {
        expression: NODES_SCRIPT,
        returnByValue: true
      }
    )) as { result?: { value?: string } }
    const value = result.result?.value
    if (value == null) throw new Error('the page did not answer')
    return toScreen(JSON.parse(value), contentBottom, pageTop)
  }

  /**
   * The pointer events the page has received since the last call, recorded
   * by a passive listener installed on first use — evidence for a drag that
   * landed somewhere else than it was dragged to. Reading only.
   */
  async pointers(): Promise<unknown> {
    const result = (await call(
      this.tab.webSocketDebuggerUrl,
      'Runtime.evaluate',
      {
        expression: POINTERS_SCRIPT,
        returnByValue: true
      }
    )) as { result?: { value?: string } }
    return JSON.parse(result.result?.value ?? 'null')
  }

  /**
   * Every video element's own state — position, readiness, network state,
   * error, and each buffered range — to save beside a step that failed.
   */
  async videos(): Promise<unknown> {
    const result = (await call(
      this.tab.webSocketDebuggerUrl,
      'Runtime.evaluate',
      {
        expression: VIDEOS_SCRIPT,
        returnByValue: true
      }
    )) as { result?: { value?: string } }
    return JSON.parse(result.result?.value ?? 'null')
  }

  /**
   * Chrome's own account of its media players — their state changes,
   * messages and errors — and the page's console, from now until `stop()`,
   * which returns them. Reading only; it is the evidence for a freeze the
   * page cannot explain.
   */
  async recordMedia(): Promise<{ stop: () => Promise<unknown[]> }> {
    const socket = new WebSocket(this.tab.webSocketDebuggerUrl)
    await new Promise((resolve, reject) => {
      socket.addEventListener('open', resolve, { once: true })
      socket.addEventListener('error', reject, { once: true })
    })
    const events: unknown[] = []
    socket.addEventListener('message', event => {
      const message = JSON.parse(String(event.data)) as { method?: string }
      if (message.method != null) events.push({ atMs: Date.now(), ...message })
    })
    let id = 1
    for (const method of ['Media.enable', 'Runtime.enable', 'Log.enable']) {
      socket.send(JSON.stringify({ id: id++, method }))
    }
    return {
      stop: async () => {
        socket.close()
        return events
      }
    }
  }

  get url(): string {
    return this.tab.url
  }

  get debuggingPort(): number {
    return this.port
  }
}
