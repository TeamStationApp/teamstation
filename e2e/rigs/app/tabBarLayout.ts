import assert from 'node:assert/strict'

import {
  NAV_HEIGHT,
  NAV_PILL_PAD,
  NAV_SIDE_INSET
} from '../../../src/app/components/navGeometry'
import {
  capsuleLabels,
  highlightWidth
} from '../../../src/app/components/tabBarModel'
import { defineE2e, type E2eSpec } from '../../core/spec'
import type { BrowserSession } from '../refinementsMaestro'
import { type Box, boxOf, flatten } from './keyboardDock'

export function phoneTabSpec(
  spec: Pick<E2eSpec, 'id' | 'title' | 'covers' | 'scenarios'>
): E2eSpec {
  return defineE2e({
    kind: 'e2e',
    stack: 'isolated',
    fixtures: ['team-with-roster'],
    exclusive: false,
    surfaces: {
      'ios-app': {
        devices: [{ role: 'device', needs: ['ios-phone'], hardware: 'none' }]
      },
      'android-app': {
        devices: [
          { role: 'device', needs: ['android-phone'], hardware: 'none' }
        ]
      }
    },
    services: ['api'],
    apps: ['teamstation-ios', 'teamstation-android'],
    secrets: [],
    costUsd: 0,
    minutes: 5,
    guards: [],
    faults: [],
    manual: false,
    ...spec
  })
}

export async function windowBox(handset: any): Promise<Box> {
  const root = await handset.hierarchy()
  const frame = boxOf(root)
  if (frame != null && frame.width > 0 && frame.height > 0) return frame
  // Android can return an envelope with separate app and system-window roots.
  const frames = flatten(root)
    .map(boxOf)
    .filter(box => box != null)
  assert(frames.length > 0, 'The device hierarchy contains no window bounds')
  return {
    x: 0,
    y: 0,
    width: Math.max(...frames.map(b => b.x + b.width)),
    height: Math.max(...frames.map(b => b.y + b.height))
  }
}

export async function controlBox(handset: any, id: string): Promise<Box> {
  const node = flatten(await handset.hierarchy()).find(node => node.id === id)
  const box = boxOf(node)
  assert(
    box != null && box.width > 0 && box.height > 0,
    'Expected visible control ' + id
  )
  return box
}

/** Measure the actual glyphs, including the curved filled surfaces at their height. */
export async function verifyWebTabLabels(
  page: BrowserSession['page']
): Promise<void> {
  const viewport = page.viewport()
  assert(viewport != null)
  try {
    for (const width of [393, 320, 280]) {
      await page.setViewport({ ...viewport, width })
      await page.evaluate(async () => {
        await document.fonts.ready
      })
      // UIKit's highlight width, or the equal slot once labels take a row.
      const shell = width - 2 * NAV_SIDE_INSET
      const highlight = capsuleLabels(shell, NAV_HEIGHT - 2 * NAV_PILL_PAD, 1)
        .separate
        ? shell / 5 - 2 * NAV_PILL_PAD
        : highlightWidth(shell, 5, NAV_PILL_PAD)
      await page.waitForFunction(
        (platterWidth, highlight) => {
          const surface = (id: string): DOMRect =>
            document
              .querySelector('[data-testid="' + id + '"]')!
              .getBoundingClientRect()
          const platter = surface('tab-bar-platter')
          if (Math.abs(platter.width - platterWidth) > 0.1) return false
          const pill = surface('tab-bar-pill')
          if (Math.abs(pill.width - highlight) > 0.6) return false
          const fits = (shell: DOMRect, text: DOMRect): boolean => {
            const radius = shell.height / 2
            const centre = shell.top + radius
            const y = Math.max(
              Math.abs(text.top - centre),
              Math.abs(text.bottom - centre)
            )
            if (y > radius) return false
            const inset = radius - Math.sqrt(radius ** 2 - y ** 2)
            return (
              text.left >= shell.left + inset &&
              text.right <= shell.right - inset
            )
          }
          const tabs = [
            ...document.querySelectorAll(
              '[data-testid="tab-bar-capsule"] [role="tab"]'
            )
          ]
          if (tabs.length !== 5) return false
          return tabs.every(tab => {
            const label = tab.lastElementChild as HTMLElement
            const range = document.createRange()
            range.selectNodeContents(label)
            const text = range.getBoundingClientRect()
            if (!fits(platter, text) || label.scrollWidth > label.clientWidth)
              return false
            if (tab.getAttribute('aria-selected') !== 'true') return true
            return text.top >= pill.bottom - 0.5 || fits(pill, text)
          })
        },
        {},
        shell,
        highlight
      )
    }
  } finally {
    await page.setViewport(viewport)
  }
}
