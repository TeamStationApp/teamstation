import assert from 'node:assert/strict'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { describe, it } from 'mocha'

import {
  centre,
  chipFor,
  clockSeconds,
  dragAlong,
  findExact,
  flatten,
  type HierarchyNode,
  knobFraction,
  passwordField,
  pngWidth,
  sampleScreens,
  scrollToFit,
  toPixels
} from './device'

/** The first 24 bytes of a PNG of this width. */
function png(width: number): Uint8Array {
  const bytes = new Uint8Array(24)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0)
  bytes.set(
    [
      (width >>> 24) & 255,
      (width >>> 16) & 255,
      (width >>> 8) & 255,
      width & 255
    ],
    16
  )
  return bytes
}

const TREE = {
  type: 'Application',
  text: 'Safari',
  bounds: { x: 0, y: 0, width: 393, height: 852 },
  children: [
    {
      type: 'StaticText',
      text: 'Sign in to TeamStation',
      bounds: { x: 47, y: 214, width: 299, height: 38 }
    },
    {
      type: 'Button',
      text: 'Sign in',
      bounds: { x: 33, y: 483, width: 327, height: 48 }
    },
    {
      type: 'StaticText',
      text: 'Sign in',
      bounds: { x: 60, y: 70, width: 59, height: 25 }
    },
    {
      type: 'Other',
      text: 'Hidden',
      bounds: { x: 0, y: 0, width: 0, height: 0 }
    },
    {
      type: 'Other',
      children: [
        {
          type: 'Image',
          text: 'Home angle',
          bounds: { x: 0, y: 300, width: 393, height: 221 }
        }
      ]
    },
    { type: 'Other', text: 'no bounds' }
  ]
}

describe('playback probe: device', function () {
  it('flattens the tree to nodes with text and a place', function () {
    const nodes = flatten(TREE)
    assert.deepEqual(
      nodes.map(node => node.text),
      [
        'Safari',
        'Sign in to TeamStation',
        'Sign in',
        'Sign in',
        'Hidden',
        'Home angle'
      ]
    )
  })

  it('finds by exact text and type, never by substring, and skips what has no size', function () {
    const nodes = flatten(TREE)
    assert.deepEqual(
      findExact(nodes, 'Sign in', 'Button').map(node => node.rect),
      [{ x: 33, y: 483, w: 327, h: 48 }]
    )
    assert.equal(findExact(nodes, 'Sign in').length, 2)
    assert.equal(findExact(nodes, 'Hidden').length, 0)
    assert.deepEqual(
      findExact(nodes, / angle$/).map(node => node.text),
      ['Home angle']
    )
  })

  it('aims at a centre, and scales points to pixels', function () {
    assert.deepEqual(centre({ x: 33, y: 483, w: 327, h: 48 }), {
      x: 197,
      y: 507
    })
    // The last chip of a row running off a 393-wide screen: its visible part.
    assert.deepEqual(
      centre({ x: 334, y: 382, w: 101, h: 48 }, { width: 393, height: 852 }),
      { x: 364, y: 406 }
    )
    assert.deepEqual(toPixels({ x: 10, y: 20, w: 30, h: 40 }, 3), {
      x: 30,
      y: 60,
      w: 90,
      h: 120
    })
    assert.equal(pngWidth(png(1179)), 1179)
    assert.throws(() => pngWidth(new Uint8Array(10)), /not a PNG/)
  })

  it('drags along a track between fractions, kept on the track, in percentages of the screen', function () {
    const screen = { width: 1080, height: 2400 }
    assert.deepEqual(
      dragAlong({ x: 179, y: 2170, w: 723, h: 189 }, 0.0034, 0.25, screen),
      {
        start: '16.80%,94.35%',
        end: '33.31%,94.35%',
        duration: 600
      }
    )
    assert.deepEqual(
      dragAlong(
        { x: 0, y: 0, w: 100, h: 10 },
        -1,
        2,
        { width: 200, height: 100 },
        900
      ),
      {
        start: '0.00%,5.00%',
        end: '50.00%,5.00%',
        duration: 900
      }
    )
  })

  it('finds the password field only under its label, secure on iOS or focused on Android', function () {
    const label = { x: 33, y: 390, w: 74, h: 17 }
    const ios = {
      children: [
        {
          type: 'TextField',
          text: 'E-mail address',
          bounds: { x: 33, y: 322, width: 327, height: 48 }
        },
        {
          type: 'SecureTextField',
          text: 'Password',
          bounds: { x: 33, y: 415, width: 327, height: 48 }
        }
      ]
    }
    assert.deepEqual(passwordField(ios, label), {
      x: 33,
      y: 415,
      w: 327,
      h: 48
    })
    const android = (focusedY: number): HierarchyNode => ({
      children: [
        {
          type: 'EditText',
          focused: focusedY === 1140,
          bounds: { x: 84, y: 1140, width: 910, height: 128 }
        },
        {
          type: 'EditText',
          focused: focusedY === 1400,
          bounds: { x: 84, y: 1400, width: 910, height: 128 }
        }
      ]
    })
    const androidLabel = { x: 84, y: 1330, w: 220, h: 47 }
    assert.deepEqual(passwordField(android(1400), androidLabel), {
      x: 84,
      y: 1400,
      w: 910,
      h: 128
    })
    // The e-mail field has the keyboard: refuse.
    assert.equal(passwordField(android(1140), androidLabel), null)
    assert.equal(passwordField({ children: [] }, androidLabel), null)
  })

  it('finds a chip in the Primary row, not the navigation button of the same name', function () {
    const nodes = flatten({
      children: [
        {
          type: 'View',
          text: 'Primary',
          bounds: { x: 65, y: 1368, width: 234, height: 129 }
        },
        {
          type: 'TextView',
          text: 'Home',
          bounds: { x: 364, y: 1407, width: 103, height: 50 }
        },
        {
          type: 'View',
          text: 'Home',
          bounds: { x: 317, y: 1368, width: 197, height: 129 }
        },
        {
          type: 'Button',
          text: 'Home',
          bounds: { x: 80, y: 2100, width: 53, height: 53 }
        }
      ]
    })
    assert.deepEqual(chipFor(nodes, 'Home')?.rect, {
      x: 317,
      y: 1368,
      w: 197,
      h: 129
    })
    assert.equal(chipFor(nodes, '3rd'), null)
    assert.equal(chipFor(nodes.slice(1), 'Home'), null)
    // The floating navigation's square Home button, level with the chips on a
    // short live page, is not the Home chip.
    const level = [
      ...nodes.filter(node => node.text === 'Primary'),
      {
        type: 'Button',
        text: 'Home',
        rect: { x: 80, y: 1380, w: 110, h: 110 }
      }
    ]
    assert.equal(chipFor(level, 'Home'), null)
  })

  it('scrolls just enough to lift the chips clear without sticking the player', function () {
    // Pixel 8: player at 1444, chips end 2176, of 2400.
    assert.deepEqual(scrollToFit(1444, 2176, 2400), {
      start: '92%,60%',
      end: '92%,39%',
      duration: 300
    })
    assert.equal(scrollToFit(800, 1500, 2400), null)
    // Chips far down, player near the top: the player's limit wins.
    assert.deepEqual(scrollToFit(400, 2300, 2400), {
      start: '92%,60%',
      end: '92%,51%',
      duration: 300
    })
    // iPhone, a live game: the player covers 60 %, so the drag starts just
    // above it, where it moves the page and does not scrub.
    assert.deepEqual(scrollToFit(433, 700, 847, 638), {
      start: '92%,48%',
      end: '92%,35%',
      duration: 300
    })
    // Player tucked under the top, nothing above it: just below it.
    assert.deepEqual(scrollToFit(20, 600, 847, 500), {
      start: '92%,62%',
      end: '92%,68%',
      duration: 300
    })
    // Player above the screen: back down.
    assert.deepEqual(scrollToFit(-200, 400, 2400), {
      start: '92%,30%',
      end: '92%,46%',
      duration: 300
    })
  })

  it('reads the knob off the times either side of the track', function () {
    const track = { x: 68, y: 690, w: 257, h: 72 }
    const nodes = flatten({
      children: [
        {
          type: 'StaticText',
          text: '3:07',
          bounds: { x: 23, y: 730, width: 26, height: 16 }
        },
        {
          type: 'StaticText',
          text: '1:33:50',
          bounds: { x: 336, y: 730, width: 42, height: 16 }
        },
        {
          type: 'StaticText',
          text: '0:00',
          bounds: { x: 23, y: 100, width: 26, height: 16 }
        }
      ]
    })
    assert.equal(clockSeconds('1:33:50'), 5630)
    assert.equal(clockSeconds('3:07'), 187)
    assert.equal(clockSeconds('ready'), null)
    assert.ok(Math.abs((knobFraction(nodes, track) ?? 0) - 187 / 5630) < 1e-9)
    assert.equal(knobFraction(nodes.slice(0, 1), track), null)
    assert.equal(
      knobFraction(
        [...nodes.slice(0, 1), { ...nodes[1], text: '0:00' }],
        track
      ),
      null
    )
  })

  it('samples screenshots until the deadline, stamped halfway through each call', async function () {
    const dir = mkdtempSync(join(tmpdir(), 'pbr-device-'))
    try {
      let clock = 1000
      const slept: number[] = []
      const shots = await sampleScreens(
        {
          screenshot: async () => {
            clock += 200
            return png(1179)
          }
        },
        join(dir, 'shots'),
        2000,
        500,
        7,
        () => clock,
        async ms => {
          slept.push(ms)
          clock += ms
        }
      )
      assert.deepEqual(
        shots.map(shot => shot.atMs),
        [1100, 1600]
      )
      assert.deepEqual(slept, [300, 300])
      assert.ok(existsSync(join(dir, 'shots', '000008.png')))
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
