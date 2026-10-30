import { readFileSync } from 'node:fs'
import vm from 'node:vm'

import { expect } from 'chai'
import { describe, it } from 'mocha'

const html = readFileSync('src/app/web/mapFrame.html', 'utf8')
const source = html.slice(
  html.indexOf('<script>') + '<script>'.length,
  html.lastIndexOf('</script>')
)

/** Where the page is served from, which the sandbox leaves in `location`. */
const APP = 'https://example.test'

/** The page's script with `origin` for an origin, against stand-ins. */
function page(origin: string): {
  parent: object
  window: object
  contentWindowOf: (inner: unknown, src?: string) => unknown
  posted: unknown[]
  written: string[]
  listening: () => boolean
  message: (from: unknown, data: unknown, origin?: string) => void
} {
  const posted: unknown[] = []
  const written: string[] = []
  let listener: ((event: unknown) => void) | undefined
  const parent = {
    postMessage: (data: unknown) => {
      posted.push(data)
    }
  }
  class HTMLIFrameElement {
    constructor(
      readonly inner: unknown,
      readonly src = ''
    ) {}

    get contentWindow(): unknown {
      return this.inner
    }
  }
  const window = {}
  const context = {
    location: { origin: APP },
    parent,
    window,
    HTMLIFrameElement,
    addEventListener: (_: string, listen: (event: unknown) => void) => {
      listener = listen
    },
    document: {
      open: () => {
        written.push('open')
      },
      write: (html: string) => {
        written.push(html)
      },
      close: () => {
        written.push('close')
      }
    }
  }
  vm.runInNewContext(source, { ...context, self: { origin } })
  return {
    parent,
    window,
    contentWindowOf: (inner, src) =>
      new HTMLIFrameElement(inner, src).contentWindow,
    posted,
    written,
    listening: () => listener != null,
    message: (from, data, origin = APP) => {
      listener?.({ source: from, data, origin })
    }
  }
}

describe('the map frame page', () => {
  it('does nothing in the app’s origin, opened or framed with no sandbox', () => {
    const app = page('https://example.test')
    expect(app.posted).deep.equals([])
    expect(app.listening()).equals(false)
    app.message(app.parent, { type: 'teamstation:mapDocument', html: 'x' })
    expect(app.written).deep.equals([])
  })

  it('says it is ready in an opaque origin, and writes the document it is sent', () => {
    const frame = page('null')
    expect(frame.posted).deep.equals([{ type: 'teamstation:mapFrameReady' }])
    frame.message(frame.parent, {
      type: 'teamstation:mapDocument',
      html: '<p>A map</p>'
    })
    expect(frame.written).deep.equals(['open', '<p>A map</p>', 'close'])
  })

  it('answers with its own window for a child frame the sandbox refuses', () => {
    const frame = page('null')
    const refused = new Proxy(
      {},
      {
        get: () => {
          throw new Error('SecurityError')
        }
      }
    )
    const reachable = { addEventListener: () => undefined }
    expect(frame.contentWindowOf(refused)).equals(frame.window)
    expect(frame.contentWindowOf(refused, 'https://example.test/')).equals(
      refused
    )
    expect(frame.contentWindowOf(reachable)).equals(reachable)
    expect(frame.contentWindowOf(null)).equals(null)
  })

  it('leaves child frames alone in the app’s origin', () => {
    const refused = { addEventListener: undefined }
    expect(page('https://example.test').contentWindowOf(refused)).equals(
      refused
    )
  })

  it('takes a document only from its parent on the app’s origin, and only a well-formed one', () => {
    const frame = page('null')
    const good = { type: 'teamstation:mapDocument', html: '<p>A map</p>' }
    frame.message({}, good)
    frame.message(frame.parent, good, 'https://elsewhere.example.test')
    frame.message(frame.parent, null)
    frame.message(frame.parent, { ...good, type: 'other' })
    frame.message(frame.parent, { ...good, html: 7 })
    expect(frame.written).deep.equals([])
  })
})
