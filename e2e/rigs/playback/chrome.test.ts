import assert from 'node:assert/strict'

import { JSDOM } from 'jsdom'
import { describe, it } from 'mocha'

import {
  ChromePage,
  coverScript,
  framesOver,
  NODES_SCRIPT,
  READOUT_SCRIPT,
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

  it("reads the page's elements, videos, pointers and readout through maestro-d", async function () {
    const scripts: string[] = []
    const answer = (script: string): unknown => {
      if (script.includes('__pbrCover')) return {}
      if (script.includes('playerReadout'))
        return { data: JSON.stringify(['clock 1.0s  playing']) }
      if (script.includes("querySelectorAll('video')"))
        return { data: JSON.stringify([{ currentTime: 556.8 }]) }
      if (script.includes('__pbrPointers'))
        return { data: JSON.stringify([['pointerup', 1, 2, 3]]) }
      if (script.includes('activeElement')) return { data: 'true' }
      if (script.includes('innerWidth'))
        return {
          data: JSON.stringify({ dpr: 2, innerWidth: 400, innerHeight: 800 })
        }
      return {
        data: JSON.stringify({
          dpr: 2,
          innerHeight: 1000,
          nodes: [
            { role: 'img', text: 'Home angle', x: 0, y: 10, w: 100, h: 50 }
          ]
        })
      }
    }
    const page = new ChromePage({
      evalWebViewScript: async ({ script }) => {
        scripts.push(script)
        return answer(script)
      }
    })
    assert.deepEqual(await page.nodes(2100), [
      {
        type: 'img',
        text: 'Home angle',
        rect: { x: 0, y: 120, w: 200, h: 100 }
      }
    ])
    assert.ok(scripts[0].startsWith('return JSON.stringify'))
    assert.deepEqual(await page.videos(), [{ currentTime: 556.8 }])
    assert.deepEqual(await page.pointers(), [['pointerup', 1, 2, 3]])
    assert.deepEqual(await page.readout(), ['clock 1.0s  playing'])
    assert.equal(await page.passwordFocused(), true)
    assert.deepEqual(await page.viewport(), {
      dpr: 2,
      innerWidth: 400,
      innerHeight: 800
    })
    await page.cover('white')
    assert.ok(scripts.at(-1)!.includes('"white"'))
  })

  it('answers empty for a script that returned nothing, and fails a page that did not answer', async function () {
    const page = new ChromePage({ evalWebViewScript: async () => ({}) })
    assert.deepEqual(await page.readout(), [])
    assert.equal(await page.pointers(), null)
    assert.equal(await page.videos(), null)
    assert.equal(await page.passwordFocused(), false)
    assert.deepEqual(await page.viewport(), {})
    await assert.rejects(page.nodes(0), /did not answer/)
  })
})
