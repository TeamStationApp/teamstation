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
Object.defineProperty(globalThis, 'requestAnimationFrame', {
  configurable: true,
  writable: true,
  value: callback =>
    dom.window.requestAnimationFrame(() => callback(performance.now()))
})
globalThis.IS_REACT_ACT_ENVIRONMENT = true
// A browser that can decode the video (HEVC, through Media Source), so the
// player draws a picture rather than saying it cannot (`playable.ts`). It
// takes nothing hls.js asks about, so hls.js still stays out of a test page.
globalThis.MediaSource = {
  isTypeSupported: type => /hvc1|hev1/.test(type)
}
globalThis.ResizeObserver = class {
  observe() {}
  unobserve() {}
  disconnect() {}
}
window.ResizeObserver = globalThis.ResizeObserver
window.matchMedia = query => ({
  matches: false,
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
  afterEach() {
    document.body.replaceChildren()
    globalThis.localStorage.clear()
    window.history.replaceState(null, '', '/')
  },
  afterAll() {
    dom.window.close()
  }
}
