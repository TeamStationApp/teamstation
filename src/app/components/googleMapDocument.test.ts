import { runInNewContext } from 'node:vm'

import { expect } from 'chai'
import { describe, it } from 'mocha'

import { googleMapDocument } from './googleMapDocument'

interface DocumentRuntime {
  window: {
    gm_authFailure?: () => void
    initEventMap?: () => Promise<void>
    eventMapCenter?: unknown
  }
  context: {
    google: { maps: { importLibrary: (name: string) => Promise<unknown> } }
  }
  writes: string[]
  script: { onerror?: () => void }
  deadline: () => void
  idle: () => void
  ready: () => void
  cleared: () => number
  armed: () => number
  maps: () => number
}

describe('Google Maps browser document', () => {
  function runtime(
    observed?: (see: (entries: unknown[]) => void) => void
  ): DocumentRuntime {
    const html = googleMapDocument({
      latitude: 34,
      longitude: 12,
      tileUrl: 'https://example.test/{z}/{x}/{y}',
      googleMapsApiKey: 'placeholder-key'
    })
    const writes: string[] = []
    let deadline: () => void = () => undefined
    let idle: () => void = () => undefined
    let ready: () => void = () => undefined
    let cleared = 0
    let armed = 0
    let maps = 0
    const script: { onerror?: () => void } = {}
    const window: {
      gm_authFailure?: () => void
      initEventMap?: () => Promise<void>
      eventMapCenter?: unknown
      IntersectionObserver?: unknown
    } = {}
    if (observed != null)
      window.IntersectionObserver = class {
        constructor(see: (entries: unknown[]) => void) {
          observed!(see)
        }

        observe(): void {}
      }
    const context = {
      window,
      URLSearchParams,
      document: {
        open: () => undefined,
        close: () => undefined,
        write: (html: string) => writes.push(html),
        getElementById: () => ({}),
        addEventListener: () => undefined,
        createElement: () => script,
        head: { appendChild: () => undefined }
      },
      setTimeout: (fn: () => void) => {
        armed++
        deadline = fn
        return 1
      },
      clearTimeout: () => {
        cleared++
      },
      google: {
        maps: {
          importLibrary: async (name: string): Promise<unknown> =>
            name === 'maps'
              ? {
                  Map: class {
                    constructor() {
                      maps++
                    }

                    addListener(name: string, fn: () => void): void {
                      if (name === 'idle') idle = fn
                      else ready = fn
                    }

                    getCenter(): { lat: () => number; lng: () => number } {
                      return { lat: () => 34, lng: () => 12 }
                    }
                  }
                }
              : {
                  AdvancedMarkerElement: class {
                    readonly marker = true
                  }
                }
        }
      }
    }
    runInNewContext(/<script>([\s\S]*)<\/script>/.exec(html)![1], context)
    return {
      window,
      context,
      writes,
      script,
      deadline: () => {
        deadline()
      },
      idle: () => {
        idle()
      },
      ready: () => {
        ready()
      },
      cleared: () => cleared,
      armed: () => armed,
      maps: () => maps
    }
  }
  it('runs its deadline only while the map is on screen', () => {
    let see: (entries: unknown[]) => void = () => undefined
    const r = runtime(given => {
      see = given
    })
    expect(r.armed()).equals(0)
    see([{ isIntersecting: true }])
    expect(r.armed()).equals(1)
    see([{ isIntersecting: false }])
    expect(r.cleared()).equals(1)
    see([{ isIntersecting: true }])
    expect(r.armed()).equals(2)
  })

  it('never starts its deadline for a map that drew before it came on screen', async () => {
    let see: (entries: unknown[]) => void = () => undefined
    const r = runtime(given => {
      see = given
    })
    await r.window.initEventMap!()
    r.ready()
    see([{ isIntersecting: true }])
    expect(r.armed()).equals(0)
  })

  it('loads Google and clears its deadline only once the map becomes ready', async () => {
    const r = runtime()
    await r.window.initEventMap!()
    expect(r.maps()).equals(1)
    expect(r.writes).length(0)
    r.idle()
    expect(r.cleared()).equals(0)
    r.ready()
    expect(r.cleared()).equals(1)
    expect(r.window.eventMapCenter).deep.equals({ latitude: 34, longitude: 12 })
  })
  it('does not create a late map when authentication fails during SDK imports', async () => {
    const r = runtime()
    const original = r.context.google.maps.importLibrary
    const maps = await original('maps')
    let release: (value: typeof maps) => void = () => undefined
    r.context.google.maps.importLibrary = async name =>
      name === 'maps'
        ? await new Promise<typeof maps>(resolve => {
            release = resolve
          })
        : await original(name)
    const loading = r.window.initEventMap!()
    r.window.gm_authFailure!()
    release(maps)
    await loading
    expect(r.writes).length(1)
    expect(r.maps()).equals(0)
  })
  for (const mode of [
    'authentication',
    'network',
    'timeout',
    'initialization'
  ] as const)
    it(`falls back once on ${mode} and ignores late SDK callbacks`, async () => {
      const r = runtime()
      if (mode === 'authentication') r.window.gm_authFailure!()
      if (mode === 'network') r.script.onerror!()
      if (mode === 'timeout') r.deadline()
      if (mode === 'initialization') {
        r.context.google.maps.importLibrary = async () => {
          throw new Error('Synthetic SDK failure')
        }
        await r.window.initEventMap!()
      }
      expect(r.writes).length(1)
      expect(r.writes[0]).includes('L.map').and.includes('OpenStreetMap')
      r.window.gm_authFailure!()
      r.script.onerror!()
      r.deadline()
      await r.window.initEventMap!()
      expect(r.writes).length(1)
      expect(r.maps()).equals(0)
    })
  it('encodes settings as data and uses the draggable SDK with authentication recovery', () => {
    const html = googleMapDocument({
      latitude: 34,
      longitude: 12,
      tileUrl: '',
      googleMapsApiKey: '</script>example'
    })
    expect(html)
      .includes('importLibrary')
      .and.includes('AdvancedMarkerElement')
      .and.includes("gestureHandling:'greedy'")
      .and.includes('gm_authFailure')
    expect(html).not.includes('</script>example')
    expect(html).includes('\\u003c/script>example')
  })
  it('rejects missing credentials or invalid coordinates before loading the SDK', () => {
    expect(() =>
      googleMapDocument({ latitude: 34, longitude: 12, tileUrl: '' })
    ).throws('not configured')
    expect(() =>
      googleMapDocument({
        latitude: 100,
        longitude: 12,
        tileUrl: '',
        googleMapsApiKey: 'example'
      })
    ).throws('could not be located')
  })
})
