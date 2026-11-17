import { expect } from 'chai'
import { afterEach, beforeEach, describe, it } from 'mocha'

import { printPlanDocument, sharePlanDocument } from './planDocument'

const BYTES = new Uint8Array([37, 80, 68, 70])
const NAME = 'Hosts-game-plan-2027-04-11.pdf'

/** Replaces a property for a test, answering how to put it back. */
function replaced(target: object, key: string, value: unknown): () => void {
  const was = Object.getOwnPropertyDescriptor(target, key)
  Object.defineProperty(target, key, {
    configurable: true,
    writable: true,
    value
  })
  return () => {
    if (was == null) Reflect.deleteProperty(target, key)
    else Object.defineProperty(target, key, was)
  }
}

describe('the web’s game plan PDF', function () {
  let made: Blob[]
  let revoked: string[]
  let clicked: HTMLAnchorElement[]
  let restore: Array<() => void>
  beforeEach(function () {
    made = []
    revoked = []
    clicked = []
    restore = [
      replaced(URL, 'createObjectURL', (blob: Blob): string => {
        made.push(blob)
        return `blob:plan-${made.length}`
      }),
      replaced(URL, 'revokeObjectURL', (url: string): void => {
        revoked.push(url)
      }),
      replaced(
        window.HTMLAnchorElement.prototype,
        'click',
        function (this: HTMLAnchorElement) {
          clicked.push(this)
        }
      )
    ]
  })
  afterEach(function () {
    for (const back of restore) back()
    for (const frame of document.querySelectorAll('iframe')) frame.remove()
  })

  /** A browser's navigator that shares files or not, recording each share. */
  const browser = (
    canShare: boolean | undefined,
    share: (data: ShareData) => Promise<void> = async () => undefined
  ): { nav: Navigator; shared: ShareData[] } => {
    const shared: ShareData[] = []
    const nav = {
      ...(canShare == null
        ? {}
        : {
            canShare: (data: ShareData) =>
              canShare && (data.files?.length ?? 0) === 1
          }),
      share: async (data: ShareData) => {
        shared.push(data)
        await share(data)
      }
    } as unknown as Navigator
    return { nav, shared }
  }

  it('shares one PDF by its name where the browser shares files', async function () {
    const { nav, shared } = browser(true)
    await sharePlanDocument(BYTES, NAME, undefined, nav)
    expect(shared).has.length(1)
    const [file] = shared[0].files!
    expect(file.name).equals(NAME)
    expect(file.type).equals('application/pdf')
    expect(shared[0].title).equals('Hosts-game-plan-2027-04-11')
    expect(clicked).deep.equals([])
  })

  it('downloads the PDF where the browser cannot share it, and lets its address go a minute later', async function () {
    const clock = { timers: [] as Array<() => void> }
    const realTimeout = globalThis.setTimeout
    globalThis.setTimeout = ((run: () => void) => {
      clock.timers.push(run)
      return 0
    }) as unknown as typeof setTimeout
    try {
      for (const canShare of [undefined, false]) {
        const { nav, shared } = browser(canShare)
        await sharePlanDocument(BYTES, NAME, undefined, nav)
        expect(shared).deep.equals([])
      }
    } finally {
      globalThis.setTimeout = realTimeout
    }
    expect(clicked.map(link => link.download)).deep.equals([NAME, NAME])
    expect(clicked[0].href).equals('blob:plan-1')
    expect(made[0].type).equals('application/pdf')
    // Clicked and gone.
    expect(clicked[0].isConnected).equals(false)
    for (const run of clock.timers) run()
    expect(revoked).deep.equals(['blob:plan-1', 'blob:plan-2'])
  })

  it('does nothing more when the share is cancelled, and downloads when it fails', async function () {
    const cancel = new Error('cancelled')
    cancel.name = 'AbortError'
    await sharePlanDocument(
      BYTES,
      NAME,
      undefined,
      browser(true, async () => {
        throw cancel
      }).nav
    )
    expect(clicked).deep.equals([])
    await sharePlanDocument(
      BYTES,
      NAME,
      undefined,
      browser(true, async () => {
        throw new Error('NotAllowedError')
      }).nav
    )
    expect(clicked.map(link => link.download)).deep.equals([NAME])
  })

  /** The frame the last print appended, with a window that records. */
  const frameWith = (
    view: Partial<Window> | null
  ): { frame: HTMLIFrameElement; load: () => void } => {
    const frames = [...document.querySelectorAll('iframe')]
    const frame = frames[frames.length - 1]
    Object.defineProperty(frame, 'contentWindow', {
      configurable: true,
      value: view
    })
    return {
      frame,
      load: () => {
        frame.dispatchEvent(new window.Event('load'))
      }
    }
  }

  it('prints the PDF from a hidden frame once it loads, settling then, and keeps the frame until the next print', async function () {
    let settled = false
    const done = printPlanDocument(BYTES, NAME).then(() => {
      settled = true
    })
    expect(document.querySelectorAll('iframe')).has.length(1)
    let printed = 0
    let focused = 0
    const { frame, load } = frameWith({
      focus: () => {
        focused++
      },
      print: () => {
        printed++
      }
    })
    expect(frame.getAttribute('src')).equals('blob:plan-1')
    expect(frame.title).equals(NAME)
    expect(frame.style.width).equals('0px')
    expect(frame.getAttribute('aria-hidden')).equals('true')
    await Promise.resolve()
    expect(settled).equals(false)
    load()
    // Once only: the viewer reloading does not print again.
    load()
    await done
    expect({ printed, focused }).deep.equals({ printed: 1, focused: 1 })
    expect(revoked).not.includes('blob:plan-1')
    const next = printPlanDocument(BYTES, NAME)
    frameWith({ focus: () => undefined, print: () => undefined }).load()
    await next
    expect(document.querySelectorAll('iframe')).has.length(1)
    expect(document.querySelector('iframe')).not.equals(frame)
    expect(revoked).includes('blob:plan-1')
    expect(clicked).deep.equals([])
  })

  it('downloads the PDF instead when the browser will not let the page print its frame', async function () {
    const refused = printPlanDocument(BYTES, NAME)
    frameWith({
      focus: () => undefined,
      print: () => {
        throw new window.DOMException('Blocked a frame', 'SecurityError')
      }
    }).load()
    await refused
    expect(clicked.map(link => link.download)).deep.equals([NAME])
    const windowless = printPlanDocument(BYTES, NAME)
    frameWith(null).load()
    await windowless
    expect(clicked.map(link => link.download)).deep.equals([NAME, NAME])
  })

  it('shares the PDF instead where a browser cannot print it from a frame, downloading where it shares no files', async function () {
    // No PDF viewer of its own (Chrome on Android, or set to download PDFs).
    const noViewer = Object.assign(
      Object.create(browser(undefined).nav) as Navigator,
      {
        pdfViewerEnabled: false,
        userAgent: 'Mozilla/5.0 (Linux; Android 15) Chrome/157',
        maxTouchPoints: 5
      }
    )
    await printPlanDocument(BYTES, NAME, undefined, noViewer)
    expect(clicked.map(link => link.download)).deep.equals([NAME])
    expect(document.querySelectorAll('iframe')).has.length(0)
    // Safari on an iPhone, and on an iPad, which says it is a Mac.
    for (const userAgent of [
      'Mozilla/5.0 (iPhone; CPU iPhone OS 27_2 like Mac OS X) Safari/605.1',
      'Mozilla/5.0 (Macintosh; Intel Mac OS X 15_0) Safari/605.1'
    ]) {
      const { nav, shared } = browser(true)
      const safari = Object.assign(Object.create(nav) as Navigator, {
        userAgent,
        maxTouchPoints: 5,
        pdfViewerEnabled: true
      })
      await printPlanDocument(BYTES, NAME, undefined, safari)
      expect(
        shared.map(data => data.files![0].name),
        userAgent
      ).deep.equals([NAME])
    }
    expect(document.querySelectorAll('iframe')).has.length(0)
  })
})
