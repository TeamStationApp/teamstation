import assert from 'node:assert/strict'

import { PNG } from 'pngjs'

import { tsBallpark } from '../../../src/app/theme/tsBallpark'
import type { BrowserSession } from '../refinementsMaestro'
import type { Box } from './keyboardDock'

type Rgb = [number, number, number]
interface PaintedPart {
  paper: Rgb
  ink: Rgb
  contrast: number
}

function rgb(hex: string): Rgb {
  return [1, 3, 5].map(i => parseInt(hex.slice(i, i + 2), 16)) as Rgb
}
function distance(a: Rgb, b: Rgb): number {
  return Math.max(...a.map((channel, i) => Math.abs(channel - b[i])))
}
function luminance(color: Rgb): number {
  return color.reduce((sum, channel, i) => {
    const s = channel / 255
    return (
      sum +
      [0.2126, 0.7152, 0.0722][i] *
        (s <= 0.04045 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4)
    )
  }, 0)
}

/** Sample the most frequent background and solid stroke inside the glyph or the label. */
function paintedPart(
  image: PNG,
  frame: Box,
  slot: Box,
  label: boolean
): PaintedPart {
  const scale = image.width / frame.width
  const fromX = (fraction: number): number =>
    Math.round((slot.x + fraction * slot.width - frame.x) * scale)
  const fromY = (fraction: number): number =>
    Math.round((slot.y + fraction * slot.height - frame.y) * scale)
  const counts = new Map<string, number>()
  for (
    let y = fromY(label ? 0.61 : 0.13);
    y < fromY(label ? 0.85 : 0.58);
    y++
  ) {
    for (let x = fromX(0.2); x < fromX(0.8); x++) {
      const offset = (y * image.width + x) * 4
      const hex = '#' + image.data.subarray(offset, offset + 3).toString('hex')
      counts.set(hex, (counts.get(hex) ?? 0) + 1)
    }
  }
  const ranked = [...counts].sort((a, b) => b[1] - a[1])
  // On real glass the background varies while the solid icon has one ink;
  // it can be the most frequent color in a selected SF Symbol. Sample the
  // light TeamStation platter independently of those dark foreground strokes.
  const surface = ranked.find(([hex]) => luminance(rgb(hex)) > 0.45)
  assert(
    surface != null,
    'The light TeamStation platter has no visible surface'
  )
  const paper = rgb(surface[0])
  // Antialiased outlines shade gradually into the paper. Measure a solid
  // interior stroke, requiring repeated pixels in the isolated glyph band.
  const stroke = ranked.find(
    ([hex, count]) =>
      count >= 6 && luminance(rgb(hex)) < luminance(paper) * 0.42
  )
  assert(
    stroke != null,
    'Missing a dark foreground stroke in the ' + (label ? 'label' : 'icon')
  )
  const ink = rgb(stroke[0])
  return {
    paper,
    ink,
    contrast: (luminance(paper) + 0.05) / (luminance(ink) + 0.05)
  }
}

export function navigationPaint(
  data: Buffer,
  frame: Box,
  selected: Box,
  inactive: Box
): PaintedPart[] {
  const image = PNG.sync.read(data)
  return [selected, inactive].flatMap(slot =>
    [false, true].map(label => paintedPart(image, frame, slot, label))
  )
}

export function assertOpaqueNavigation(
  parts: PaintedPart[],
  system: boolean
): void {
  const [selectedIcon, selectedLabel, inactiveIcon, inactiveLabel] = parts
  const expectedPaper = rgb(tsBallpark.navOpaqueBackgroundColor)
  const expectedPill = rgb(tsBallpark.navOpaqueSelectedColor)
  for (const part of [inactiveIcon, inactiveLabel])
    assert(
      distance(part.paper, expectedPaper) <= 3,
      'The inactive tab has no opaque theme platter'
    )
  for (const part of [selectedIcon, selectedLabel]) {
    if (system) {
      // UIKit supplies the selected item's opaque fill. Read the painted
      // color from the simulator rather than hard-coding an OS gray.
      assert(
        distance(part.paper, expectedPaper) > 5,
        'Missing the UIKit selection pill'
      )
      assert(
        distance(part.paper, selectedIcon.paper) <= 3,
        'Inconsistent selected fill across the icon and label'
      )
    } else
      assert(
        distance(part.paper, expectedPill) <= 3,
        'The selection pill has the wrong opaque fill'
      )
  }
  assert(
    distance(selectedIcon.ink, rgb(tsBallpark.navOpaqueActiveColor)) <= 18,
    'The selected icon lost the app tint'
  )
  assert(
    distance(inactiveIcon.ink, rgb(tsBallpark.navOpaqueInactiveColor)) <= 18,
    'The inactive icon lost its high-contrast tint'
  )
  for (const [index, part] of parts.entries())
    assert(
      part.contrast >= 3,
      ['selected icon', 'selected label', 'inactive icon', 'inactive label'][
        index
      ] +
        ' contrast ' +
        part.contrast +
        ' falls below 3:1'
    )
}

export function assertNormalNavigation(
  normal: PaintedPart[],
  opaque: PaintedPart[]
): void {
  assert(
    distance(normal[0].paper, opaque[0].paper) > 3,
    'The mounted selected pill kept its opaque surface'
  )
  assert(
    distance(normal[2].ink, opaque[2].ink) > 8,
    'The mounted inactive icon kept its high-contrast tint'
  )
}

/** Chromium exposes its transparency preference and material styles on the mounted page. */
export async function verifyWebTransparency(
  page: BrowserSession['page']
): Promise<void> {
  const session = await page.createCDPSession()
  const root = await page.waitForSelector('[data-testid="tab-bar-capsule"]')
  assert(root != null)
  try {
    for (const reduced of [true, false]) {
      await session.send('Emulation.setEmulatedMedia', {
        features: [
          {
            name: 'prefers-reduced-transparency',
            value: reduced ? 'reduce' : 'no-preference'
          }
        ]
      })
      await page.waitForFunction(
        (bar, reduced, colors) => {
          if (bar !== document.querySelector('[data-testid="tab-bar-capsule"]'))
            return false
          const surface = (id: string): CSSStyleDeclaration =>
            getComputedStyle(bar.querySelector('[data-testid="' + id + '"]')!)
          const color = (value: string): string => {
            const style = document.createElement('span').style
            style.color = value
            return style.color
          }
          const platter = surface('tab-bar-platter')
          const pill = surface('tab-bar-pill')
          const label = (id: string): string =>
            getComputedStyle(
              bar.querySelector('[data-testid="tab-' + id + '"]')!
                .lastElementChild!
            ).color
          const foreground =
            label('home') === color(colors.active) &&
            label('videos') ===
              color(reduced ? colors.opaqueInactive : colors.inactive)
          if (!foreground) return false
          // The highlight is a filled capsule with no outline in both modes.
          if (
            !['', '0px'].includes(pill.borderTopWidth) ||
            pill.backdropFilter !== 'none'
          )
            return false
          if (reduced)
            return (
              platter.backgroundColor === color(colors.platter) &&
              pill.backgroundColor === color(colors.pill) &&
              platter.backdropFilter === 'none'
            )
          return (
            platter.backdropFilter.includes('blur(') &&
            pill.backgroundColor === color(colors.selected)
          )
        },
        {},
        root,
        reduced,
        {
          active: tsBallpark.navTabActiveColor,
          inactive: tsBallpark.navTabInactiveColor,
          opaqueInactive: tsBallpark.navOpaqueInactiveColor,
          platter: tsBallpark.navOpaqueBackgroundColor,
          pill: tsBallpark.navOpaqueSelectedColor,
          selected: tsBallpark.navSelectedColor
        }
      )
    }
  } finally {
    await session.send('Emulation.setEmulatedMedia', { features: [] })
    await session.detach()
    await root.dispose()
  }
}
