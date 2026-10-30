import { expect } from 'chai'
import { JSDOM, VirtualConsole } from 'jsdom'
import { describe, it } from 'mocha'

import {
  PIN_MAP_FAILED,
  pinMapDocument,
  type PinMapSettings,
  pinMovedOf,
  pinPointText
} from './pinMapDocument'

const settings: PinMapSettings = {
  latitude: 40.02,
  longitude: -75.22,
  googleMapsApiKey: 'placeholder-key',
  editable: true
}

interface StubMarker {
  options: { gmpDraggable: boolean; position: { lat: number; lng: number } }
  position: unknown
  dragend?: () => void
}

/**
 * The document running in a page of its own, with a stand-in for Google's
 * loader that records the map and marker it is asked for.
 */
function load(
  given: PinMapSettings,
  timeoutMs?: number,
  beforeParse?: (window: Window & Record<string, any>) => void
): {
  dom: JSDOM
  window: Window & Record<string, any>
  failed: () => boolean
  scripts: () => string[]
  markers: StubMarker[]
  maps: Array<{ options: Record<string, unknown>; tilesloaded?: () => void }>
  posted: unknown[]
  errors: string[]
  google: (fails?: boolean) => void
} {
  const errors: string[] = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', error => {
    errors.push(String(error.message))
  })
  const dom = new JSDOM(pinMapDocument(given, { timeoutMs }), {
    runScripts: 'dangerously',
    beforeParse: window => {
      beforeParse?.(window as unknown as Window & Record<string, any>)
    },
    virtualConsole
  })
  const window = dom.window as unknown as Window & Record<string, any>
  const markers: StubMarker[] = []
  const maps: Array<{
    options: Record<string, unknown>
    tilesloaded?: () => void
  }> = []
  const posted: unknown[] = []
  window.ReactNativeWebView = {
    postMessage: (message: string) => posted.push(JSON.parse(message))
  }
  return {
    dom,
    window,
    failed: () =>
      !window.document.getElementById('failed')!.hidden &&
      window.document.getElementById('map')!.hidden,
    scripts: () =>
      [...window.document.querySelectorAll('script[src]')].map(
        script => (script as HTMLScriptElement).src
      ),
    markers,
    maps,
    posted,
    errors,
    google: (fails = false) => {
      class Map {
        entry: (typeof maps)[number]
        constructor(_node: unknown, options: Record<string, unknown>) {
          this.entry = { options }
          maps.push(this.entry)
        }

        addListener(name: string, listener: () => void): void {
          if (name === 'tilesloaded') this.entry.tilesloaded = listener
        }
      }
      class AdvancedMarkerElement {
        marker: StubMarker
        constructor(options: StubMarker['options']) {
          this.marker = { options, position: options.position }
          markers.push(this.marker)
        }

        get position(): unknown {
          return this.marker.position
        }

        addListener(name: string, listener: () => void): void {
          if (name === 'dragend') this.marker.dragend = listener
        }
      }
      window.google = {
        maps: {
          importLibrary: async (name: string) => {
            if (fails) throw new Error('Synthetic loader failure')
            return name === 'maps' ? { Map } : { AdvancedMarkerElement }
          }
        }
      }
    }
  }
}

const wait = async (ms: number): Promise<void> => {
  await new Promise(resolve => setTimeout(resolve, ms))
}

describe('the pin map document', () => {
  it('loads only Google’s Maps script, with no Leaflet or OpenStreetMap', () => {
    const html = pinMapDocument(settings)
    expect(html.toLowerCase()).not.includes('leaflet')
    expect(html.toLowerCase()).not.includes('openstreetmap')
    expect(html).not.includes('tileUrl')
    const page = load(settings)
    const [script] = page.scripts()
    expect(page.scripts()).length(1)
    const url = new URL(script)
    expect(url.origin + url.pathname).equals(
      'https://maps.googleapis.com/maps/api/js'
    )
    expect(Object.fromEntries(url.searchParams)).deep.equals({
      key: 'placeholder-key',
      loading: 'async',
      callback: 'initPinMap',
      v: 'quarterly'
    })
    expect(page.failed()).equals(false)
    page.window.close()
  })

  it('draws a hybrid map with a draggable marker, and posts where it was let go', async () => {
    const page = load(settings)
    page.google()
    await page.window.initPinMap()
    expect(page.maps[0].options).include({ mapTypeId: 'hybrid', zoom: 18 })
    expect(page.maps[0].options.center).deep.equals({
      lat: 40.02,
      lng: -75.22
    })
    expect(page.markers[0].options.gmpDraggable).equals(true)
    // Google's marker answers a LatLng, or a literal.
    page.markers[0].position = { lat: () => 40.0211, lng: () => -75.2211 }
    page.markers[0].dragend!()
    page.markers[0].position = { lat: 40.0212, lng: -75.2212 }
    page.markers[0].dragend!()
    expect(page.posted.map(pinMovedOf)).deep.equals([
      { type: 'teamstation:pinMoved', latitude: 40.0211, longitude: -75.2211 },
      { type: 'teamstation:pinMoved', latitude: 40.0212, longitude: -75.2212 }
    ])
    // Tiles in, the deadline no longer applies.
    page.maps[0].tilesloaded!()
    page.window.close()
    const readOnly = load({ ...settings, editable: false })
    readOnly.google()
    await readOnly.window.initPinMap()
    expect(readOnly.markers[0].options.gmpDraggable).equals(false)
    readOnly.window.close()
  })

  it('posts to the page that framed it when there is no WebView', async () => {
    const page = load(settings)
    delete page.window.ReactNativeWebView
    page.google()
    await page.window.initPinMap()
    // A document that is its own top window has nobody to tell.
    page.markers[0].position = { lat: 1, lng: 2 }
    page.markers[0].dragend!()
    expect(page.posted).deep.equals([])
    page.window.close()
  })

  it('shows "couldn’t load" with the point and Retry when there is no key', () => {
    for (const key of [undefined, '']) {
      const page = load({ ...settings, googleMapsApiKey: key })
      expect(page.failed()).equals(true)
      expect(page.scripts()).deep.equals([])
      const text = page.window.document.getElementById('failed')!.textContent
      expect(text).includes(PIN_MAP_FAILED)
      expect(text).includes('40.02000, -75.22000')
      expect(page.window.document.getElementById('retry')!.textContent).equals(
        'Retry'
      )
      page.window.close()
    }
  })

  it('shows the panel on an auth failure, a script error, a loader failure or the deadline', async () => {
    const auth = load(settings)
    auth.google()
    await auth.window.initPinMap()
    auth.window.gm_authFailure()
    expect(auth.failed()).equals(true)
    // Once failed, it stays so.
    auth.window.gm_authFailure()
    expect(auth.failed()).equals(true)
    auth.window.close()

    const script = load(settings)
    const element = script.window.document.querySelector('script[src]')!
    ;(element as HTMLScriptElement).onerror!(new script.window.Event('error'))
    expect(script.failed()).equals(true)
    // A late callback draws nothing over the panel.
    script.google()
    await script.window.initPinMap()
    expect(script.maps).deep.equals([])
    script.window.close()

    const loader = load(settings)
    loader.google(true)
    await loader.window.initPinMap()
    expect(loader.failed()).equals(true)
    loader.window.close()

    const late = load(settings, 20)
    expect(late.failed()).equals(false)
    await wait(60)
    expect(late.failed()).equals(true)
    late.window.close()
  })

  it('starts its timer only once the map is on screen', async () => {
    const observers: Array<(entries: unknown[]) => void> = []
    const page = load(settings, 20, window => {
      Object.defineProperty(window, 'parent', { value: {} })
      window.IntersectionObserver = class {
        constructor(callback: (entries: unknown[]) => void) {
          observers.push(callback)
        }

        observe(): void {}
        disconnect(): void {}
      }
    })
    await wait(60)
    expect(page.failed()).equals(false)
    observers[0]([{ isIntersecting: false }])
    await wait(60)
    expect(page.failed()).equals(false)
    // Left again before the timer ends, it does not count.
    observers[0]([{ isIntersecting: true }])
    observers[0]([{ isIntersecting: false }])
    await wait(60)
    expect(page.failed()).equals(false)
    observers[0]([{ isIntersecting: true }])
    await wait(60)
    expect(page.failed()).equals(true)
    page.window.close()
  })

  it('stops its timer while the tab is hidden, and goes on when it returns', async () => {
    const observers: Array<(entries: unknown[]) => void> = []
    const page = load(settings, 20, window => {
      Object.defineProperty(window, 'parent', { value: {} })
      window.IntersectionObserver = class {
        constructor(callback: (entries: unknown[]) => void) {
          observers.push(callback)
        }

        observe(): void {}
      }
    })
    let hidden = false
    Object.defineProperty(page.window.document, 'visibilityState', {
      get: () => (hidden ? 'hidden' : 'visible')
    })
    const switched = (to: boolean): void => {
      hidden = to
      page.window.document.dispatchEvent(
        new page.window.Event('visibilitychange')
      )
    }
    observers[0]([{ isIntersecting: true }])
    switched(true)
    await wait(60)
    expect(page.failed()).equals(false)
    switched(false)
    await wait(60)
    expect(page.failed()).equals(true)
    page.window.close()
  })

  it('keeps one timer through a batch that leaves and returns', async () => {
    const observers: Array<(entries: unknown[]) => void> = []
    const page = load(settings, 40, window => {
      Object.defineProperty(window, 'parent', { value: {} })
      window.IntersectionObserver = class {
        constructor(callback: (entries: unknown[]) => void) {
          observers.push(callback)
        }

        observe(): void {}
      }
    })
    observers[0]([{ isIntersecting: true }])
    observers[0]([{ isIntersecting: false }, { isIntersecting: true }])
    page.google()
    await page.window.initPinMap()
    page.maps[0].tilesloaded!()
    await wait(80)
    expect(page.failed()).equals(false)
    page.window.close()
  })

  it('starts its timer at once with no frame around it, as in a WebView', async () => {
    const page = load(settings, 20, window => {
      window.IntersectionObserver = class {
        observe(): void {}
      }
    })
    await wait(60)
    expect(page.failed()).equals(true)
    page.window.close()
  })

  it('never starts its timer for a map that drew before it came on screen', async () => {
    const observers: Array<(entries: unknown[]) => void> = []
    const page = load(settings, 20, window => {
      Object.defineProperty(window, 'parent', { value: {} })
      window.IntersectionObserver = class {
        constructor(callback: (entries: unknown[]) => void) {
          observers.push(callback)
        }

        observe(): void {}
        disconnect(): void {}
      }
    })
    page.google()
    await page.window.initPinMap()
    page.maps[0].tilesloaded!()
    observers[0]([{ isIntersecting: true }])
    await wait(60)
    expect(page.failed()).equals(false)
    page.window.close()
  })

  it('asks the page around it for a new frame on Retry', () => {
    const page = load({ ...settings, googleMapsApiKey: undefined })
    const asked: unknown[] = []
    Object.defineProperty(page.window, 'parent', {
      value: {
        postMessage: (data: unknown, target: string) => {
          asked.push([data, target])
        }
      }
    })
    page.window.document.getElementById('retry')!.click()
    expect(asked).deep.equals([[{ type: 'teamstation:mapRetry' }, '*']])
    expect(page.errors).deep.equals([])
    page.window.close()
  })

  it('keeps untrusted settings out of the markup, and refuses a place off the map', () => {
    const html = pinMapDocument({
      ...settings,
      googleMapsApiKey: '</script><b>'
    })
    expect(html).not.includes('</script><b>')
    expect(() => pinMapDocument({ ...settings, latitude: 91 })).throws(
      'could not be located'
    )
    expect(() => pinMapDocument({ ...settings, longitude: NaN })).throws(
      'could not be located'
    )
    expect(pinPointText({ latitude: 1.5, longitude: -2 })).equals(
      '1.50000, -2.00000'
    )
  })
})
