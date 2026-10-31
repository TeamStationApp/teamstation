const { JSDOM } = require('jsdom')
const dom = new JSDOM(
  '<!doctype html><html><head></head><body></body></html>',
  { url: 'http://localhost/', pretendToBeVisual: true }
)
for (const key of [
  'window',
  'document',
  'navigator',
  'localStorage',
  'HTMLElement',
  'ShadowRoot',
  'HTMLCanvasElement',
  'Element',
  'Node',
  'MutationObserver',
  'getComputedStyle',
  'requestAnimationFrame',
  'cancelAnimationFrame'
]) {
  Object.defineProperty(globalThis, key, {
    configurable: true,
    value:
      typeof dom.window[key] === 'function' &&
      /^(getComputedStyle|request|cancel)/.test(key)
        ? dom.window[key].bind(dom.window)
        : dom.window[key]
  })
}
// Reanimated starts animations with Node's performance clock. JSDOM rAF has
// its own time origin, so supply the same clock to each frame callback.
function installAnimationFrames() {
  Object.defineProperty(globalThis, 'requestAnimationFrame', {
    configurable: true,
    writable: true,
    value: callback =>
      dom.window.requestAnimationFrame(() => callback(performance.now()))
  })
  Object.defineProperty(globalThis, 'cancelAnimationFrame', {
    configurable: true,
    writable: true,
    value: dom.window.cancelAnimationFrame.bind(dom.window)
  })
}
installAnimationFrames()
globalThis.IS_REACT_ACT_ENVIRONMENT = true
// A browser that can decode the video (HEVC, through Media Source), so the
// player draws a picture rather than saying it cannot (`playable.ts`). It
// takes nothing hls.js asks about, so hls.js still stays out of a test page.
globalThis.MediaSource = {
  isTypeSupported: type => /hvc1|hev1/.test(type)
}
// JSDOM has no layout. React Native Web's observer stays silent, as before:
// tests deliver its layouts through `__reactLayoutHandler`. A virtualized
// list (Legend List) observes border boxes instead, and a browser reports
// those both when observation starts and whenever layout changes. Report a
// scroll viewport as filling the window at first, then every layout a test
// delivers to an element, to the border-box observers of that element.
const borderBoxObservers = new Map()
function reportBorderBox(target, size) {
  for (const observer of borderBoxObservers.get(target) ?? [])
    observer.callback(
      [
        {
          target,
          contentRect: { left: 0, top: 0, ...size },
          borderBoxSize: [{ blockSize: size.height, inlineSize: size.width }]
        }
      ],
      observer
    )
}
globalThis.ResizeObserver = class {
  constructor(callback) {
    this.callback = callback
  }

  observe(target, options) {
    if (options?.box !== 'border-box') return
    const observers = borderBoxObservers.get(target) ?? new Set()
    observers.add(this)
    borderBoxObservers.set(target, observers)
    if (typeof target.getScrollableNode !== 'function') return
    queueMicrotask(() => {
      if (!borderBoxObservers.get(target)?.has(this)) return
      const rect = target.getBoundingClientRect()
      const root = document.documentElement
      reportBorderBox(
        target,
        rect.width > 0 && rect.height > 0
          ? { width: rect.width, height: rect.height }
          : {
              width: root.clientWidth || window.innerWidth,
              height: root.clientHeight || window.innerHeight
            }
      )
    })
  }

  unobserve(target) {
    borderBoxObservers.get(target)?.delete(this)
  }

  disconnect() {
    for (const observers of borderBoxObservers.values()) observers.delete(this)
  }
}
window.ResizeObserver = globalThis.ResizeObserver
Object.defineProperty(
  globalThis.HTMLElement.prototype,
  '__reactLayoutHandler',
  {
    configurable: true,
    get() {
      return this.__testLayoutHandler
    },
    set(handler) {
      this.__testLayoutHandler =
        typeof handler !== 'function'
          ? handler
          : event => {
              const result = handler(event)
              const layout = event?.nativeEvent?.layout
              if (layout != null && borderBoxObservers.has(this))
                reportBorderBox(this, {
                  width: layout.width,
                  height: layout.height
                })
              return result
            }
    }
  }
)
// The virtualized list compensates scrolling with `scrollBy`.
globalThis.HTMLElement.prototype.scrollBy ??= function (options) {
  this.scrollTop += options?.top ?? 0
  this.scrollLeft += options?.left ?? 0
}
// The test page prefers reduced motion, so a screen suite sees one screen at
// a time rather than two mid-slide; a suite about motion stubs
// `AccessibilityInfo` for itself.
window.matchMedia = query => ({
  matches: query === '(prefers-reduced-motion: reduce)',
  media: query,
  addListener() {},
  removeListener() {},
  addEventListener() {},
  removeEventListener() {}
})
globalThis.HTMLElement.prototype.setPointerCapture = function () {}
globalThis.HTMLElement.prototype.releasePointerCapture = function () {}
globalThis.HTMLElement.prototype.hasPointerCapture = function () {
  return false
}
exports.mochaHooks = {
  beforeAll() {
    // Worklets installs a zero-delay timeout rAF while importing in test mode,
    // but leaves JSDOM's cancelAnimationFrame in place. Restore a matching pair
    // after imports: otherwise unmounted frame loops survive cancellation and
    // spin forever when a later test advances fake setTimeout timers.
    installAnimationFrames()
  },
  afterEach() {
    document.body.replaceChildren()
    globalThis.localStorage.clear()
    window.history.replaceState(null, '', '/')
  },
  afterAll() {
    dom.window.close()
  }
}
