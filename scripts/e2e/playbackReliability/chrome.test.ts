import assert from 'node:assert/strict'
import { createServer, type Server } from 'node:http'
import type { AddressInfo } from 'node:net'

import { JSDOM } from 'jsdom'
import { after, before, describe, it } from 'mocha'
import { WebSocketServer } from 'ws'

import {
  ChromePage,
  coverScript,
  framesOver,
  NODES_SCRIPT,
  READOUT_SCRIPT,
  statusBarBottom,
  toScreen
} from './chrome'

describe('playback probe: Chrome over DevTools', function () {
  it('lists elements with their own text or a name, with their boxes, and skips empty ones', function () {
    const dom = new JSDOM(
      '<body><div role="button" aria-label="Watch full screen"></div>' +
        '<div><span>Primary</span><span></span></div><div>hidden</div></body>',
      { runScripts: 'outside-only' }
    )
    interface Box {
      x: number
      y: number
      width: number
      height: number
    }
    const boxes: Record<string, Box> = {
      'Watch full screen': { x: 13, y: 104, width: 385, height: 217 },
      Primary: { x: 20, y: 330, width: 80, height: 40 }
    }
    const none: Box = { x: 0, y: 0, width: 0, height: 0 }
    // jsdom lays nothing out; each element gets the box the test gives it.
    dom.window.Element.prototype.getBoundingClientRect = function (
      this: Element
    ): DOMRect {
      const key =
        this.getAttribute('aria-label') ?? this.textContent?.trim() ?? ''
      const box: Box = boxes[key] ?? none
      return box as unknown as DOMRect
    }
    const evaluate = (
      dom.window as unknown as { eval: (code: string) => unknown }
    ).eval
    const page = JSON.parse(String(evaluate(NODES_SCRIPT))) as {
      nodes: Array<{ role: string; text: string }>
    }
    assert.deepEqual(
      page.nodes.map(node => [node.role, node.text]),
      [
        ['button', 'Watch full screen'],
        ['span', 'Primary']
      ]
    )
  })

  it('covers the page in one colour for the camera, and takes the cover away', function () {
    const dom = new JSDOM('<body><p>page</p></body>', {
      runScripts: 'outside-only'
    })
    const evaluate = (
      dom.window as unknown as { eval: (code: string) => unknown }
    ).eval
    const cover = (): HTMLElement | null =>
      dom.window.document.getElementById('__pbrCover')
    evaluate(coverScript('black'))
    assert.equal(cover()?.style.background, 'black')
    evaluate(coverScript('white'))
    assert.equal(cover()?.style.background, 'white')
    assert.equal(dom.window.document.querySelectorAll('#__pbrCover').length, 1)
    evaluate(coverScript(null))
    assert.equal(cover(), null)
  })

  it("reads the player's readout lines and nothing else", function () {
    const dom = new JSDOM(
      '<body><div>Primary</div><div data-testid="playerReadout">' +
        '<div>Primary  buf 3.0s  ready 4</div><div>clock 1.0s  playing</div></div></body>',
      { runScripts: 'outside-only' }
    )
    const evaluate = (
      dom.window as unknown as { eval: (code: string) => unknown }
    ).eval
    assert.deepEqual(JSON.parse(String(evaluate(READOUT_SCRIPT))), [
      'Primary  buf 3.0s  ready 4',
      'clock 1.0s  playing'
    ])
  })

  it("counts each tile's frames, shown and dropped, between two reads", function () {
    assert.deepEqual(
      framesOver(
        [
          { label: 'Home angle', quality: { dropped: 10, total: 1000 } },
          { label: 'Primary angle', quality: { dropped: 0, total: 900 } }
        ],
        [
          { label: 'Home angle', quality: { dropped: 130, total: 1600 } },
          { label: 'Primary angle', quality: { dropped: 3, total: 1500 } },
          { label: '3rd angle', quality: { dropped: 0, total: 20 } },
          { label: null, quality: null }
        ]
      ),
      [
        { tile: 'Home', dropped: 120, total: 600 },
        { tile: 'Primary', dropped: 3, total: 600 }
      ]
    )
  })

  it('places a full-screen page from the top of the display', function () {
    const found = toScreen(
      {
        dpr: 2.625,
        innerHeight: 914,
        fullscreen: true,
        nodes: [
          { role: 'img', text: 'Primary angle', x: 0, y: 100, w: 411, h: 231 }
        ]
      },
      2337
    )
    assert.equal(found[0].rect.y, 262.5)
  })

  it('starts a page under the status bar when Chrome hides its toolbar and draws under the gesture bar', function () {
    // Pixel 10: toolbar hidden, the page 2251 px tall from 173 to the bottom.
    const found = toScreen(
      {
        dpr: 2.625,
        innerHeight: 2251 / 2.625,
        nodes: [
          { role: 'img', text: 'Primary angle', x: 0, y: 100, w: 1, h: 1 }
        ]
      },
      2360,
      173
    )
    assert.equal(found[0].rect.y, 173 + 262.5)
    assert.equal(
      statusBarBottom(
        '  InsetsSource id=33e00000 type=statusBars frame=[0,0][1080,173] visible=true'
      ),
      173
    )
    assert.equal(statusBarBottom('nothing here'), 0)
  })

  it('places CSS boxes on the glass from the content bottom', function () {
    const found = toScreen(
      {
        dpr: 2.625,
        innerHeight: 784,
        nodes: [
          {
            role: 'button',
            text: 'Watch full screen',
            x: 13,
            y: 104,
            w: 385,
            h: 217
          }
        ]
      },
      2337
    )
    assert.deepEqual(found, [
      {
        type: 'button',
        text: 'Watch full screen',
        rect: {
          x: 34.125,
          y: 279 + 104 * 2.625,
          w: 385 * 2.625,
          h: 217 * 2.625
        }
      }
    ])
  })

  describe('against a DevTools endpoint', function () {
    let server: Server
    let sockets: WebSocketServer
    let port = 0
    const closed: string[] = []
    const calls: string[] = []

    before(async function () {
      server = createServer((request, response) => {
        if (request.url === '/json') {
          response.end(
            JSON.stringify([
              {
                id: 'a',
                type: 'page',
                url: 'https://seat.example.test/',
                webSocketDebuggerUrl: `ws://127.0.0.1:${port}/a`
              },
              {
                id: 'w',
                type: 'service_worker',
                url: 'x',
                webSocketDebuggerUrl: ''
              },
              {
                id: 'b',
                type: 'page',
                url: 'https://seat.example.test/games',
                webSocketDebuggerUrl: `ws://127.0.0.1:${port}/b`
              }
            ])
          )
        } else {
          closed.push(String(request.url))
          response.end('Target is closing')
        }
      })
      sockets = new WebSocketServer({ server })
      sockets.on('connection', socket => {
        socket.on('message', (data: Buffer) => {
          const message = JSON.parse(data.toString()) as {
            id: number
            method: string
            params?: { expression?: string }
          }
          calls.push(message.method)
          const expression = String(message.params?.expression ?? '')
          const value = expression.includes('playerReadout')
            ? JSON.stringify(['clock 1.0s  playing'])
            : expression.includes("querySelectorAll('video')")
              ? JSON.stringify([{ currentTime: 556.8 }])
              : String(message.params?.expression ?? '').includes(
                    '__pbrPointers'
                  )
                ? JSON.stringify([['pointerup', 1, 2, 3]])
                : JSON.stringify({
                    dpr: 2,
                    innerHeight: 1000,
                    nodes: [
                      {
                        role: 'img',
                        text: 'Home angle',
                        x: 0,
                        y: 10,
                        w: 100,
                        h: 50
                      }
                    ]
                  })
          if (message.method === 'Media.enable') {
            socket.send(
              JSON.stringify({
                method: 'Media.playerEventsAdded',
                params: { events: [] }
              })
            )
          }
          socket.send(
            JSON.stringify(
              message.method === 'Page.bogus'
                ? { id: message.id, error: { message: 'no such method' } }
                : message.method === 'Runtime.evaluate'
                  ? { id: message.id, result: { result: { value } } }
                  : { id: message.id, result: {} }
            )
          )
        })
      })
      await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve))
      port = (server.address() as AddressInfo).port
    })

    after(async function () {
      sockets.close()
      await new Promise(resolve => server.close(resolve))
    })

    it('keeps one tab, navigates it, and reads its elements', async function () {
      // `true` stands in for adb, which the forward is not needed for here.
      const page = await ChromePage.open('00000000', port, 'true')
      assert.equal(page.debuggingPort, port)
      assert.equal(page.url, 'https://seat.example.test/')
      assert.deepEqual(closed, ['/json/close/b'])
      await page.navigate('https://seat.example.test/?debug=1')
      const nodes = await page.nodes(2100)
      assert.deepEqual(nodes, [
        {
          type: 'img',
          text: 'Home angle',
          rect: { x: 0, y: 120, w: 200, h: 100 }
        }
      ])
      assert.deepEqual(calls, ['Page.navigate', 'Runtime.evaluate'])
      assert.deepEqual(await page.videos(), [{ currentTime: 556.8 }])
      assert.deepEqual(await page.pointers(), [['pointerup', 1, 2, 3]])
      assert.deepEqual(await page.readout(), ['clock 1.0s  playing'])
      const recording = await page.recordMedia()
      await new Promise(resolve => setTimeout(resolve, 100))
      const events = (await recording.stop()) as Array<{ method?: string }>
      assert.deepEqual(calls.slice(5), [
        'Media.enable',
        'Runtime.enable',
        'Log.enable'
      ])
      assert.deepEqual(
        events.map(event => event.method),
        ['Media.playerEventsAdded']
      )
    })
  })
})
