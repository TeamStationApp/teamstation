import { expect } from 'chai'

import { TAB_GLYPHS } from '../components/tabGlyphs'
import { tsBallpark } from './tsBallpark'
import { tsDark } from './tsDark'

function contrast(a: string, b: string): number {
  const [low, high] = [luminance(a), luminance(b)].sort((x, y) => x - y)
  return (high + 0.05) / (low + 0.05)
}
function luminance(hex: string): number {
  const rgb = [1, 3, 5].map(start => {
    const channel = Number.parseInt(hex.slice(start, start + 2), 16) / 255
    return channel <= 0.04045
      ? channel / 12.92
      : ((channel + 0.055) / 1.055) ** 2.4
  })
  return rgb[0] * 0.2126 + rgb[1] * 0.7152 + rgb[2] * 0.0722
}
/** A CSS rgba() tint laid over an opaque backdrop. */
function over(tint: string, backdrop: string): string {
  const [r, g, b, a] = tint
    .slice(tint.indexOf('(') + 1, -1)
    .split(',')
    .map(Number)
  return (
    '#' +
    [r, g, b]
      .map((channel, i) => {
        const under = Number.parseInt(backdrop.slice(1 + 2 * i, 3 + 2 * i), 16)
        return Math.round(channel * a + under * (1 - a))
          .toString(16)
          .padStart(2, '0')
      })
      .join('')
  )
}
describe('the selected tab', () => {
  it('swaps an outlined glyph for a filled one, as UIKit does', () => {
    for (const [id, glyph] of Object.entries(TAB_GLYPHS)) {
      expect(glyph.filled, id).not.equals(glyph.outlined)
      expect(glyph.filled, id).matches(/^[Mm][-\d.,\sMmLlHhVvQqTtZz]+$/)
      expect(glyph.outlined, id).matches(/^[Mm][-\d.,\sMmLlHhVvQqTtZz]+$/)
    }
  })
  for (const theme of [tsBallpark, tsDark]) {
    const name = theme.isDark ? 'dark' : 'light'
    it(
      'is told apart by its glyph and its ink, each legible, in the ' +
        name +
        ' theme',
      () => {
        // The pill is as faint as UIKit's (about 1.2:1); the filled glyph and
        // the change of ink carry the selection (WCAG 2.2 SC 1.4.11).
        expect(theme.navTabActiveColor).not.equals(theme.navTabInactiveColor)
        expect(theme.navOpaqueActiveColor).not.equals(
          theme.navOpaqueInactiveColor
        )
        expect(
          contrast(theme.navTabActiveColor, theme.navSelectedColor)
        ).at.least(4.5)
        expect(
          contrast(theme.navOpaqueActiveColor, theme.navOpaqueSelectedColor)
        ).at.least(4.5)
        // The others on the painted bar, and on the glass over the canvas.
        for (const bar of [
          theme.glassFallbackColor,
          over(theme.glassBackgroundColor, theme.containerBackgroundColor)
        ])
          expect(
            contrast(theme.navTabInactiveColor, bar),
            theme.navTabInactiveColor + ' on ' + bar
          ).at.least(4.5)
        expect(
          contrast(theme.navOpaqueInactiveColor, theme.navOpaqueBackgroundColor)
        ).at.least(4.5)
      }
    )
  }
  it("uses the gray of UIKit's selected tab", () => {
    // Sampled from the iOS 27.2 bar over TeamStation's light canvas.
    expect(tsBallpark.navSelectedColor).equals('#E3E4DF')
    expect(over(tsBallpark.glassBackgroundColor, '#000000')).equals('#8c8c8c')
  })
})
describe('opaque navigation colors', () => {
  for (const theme of [tsBallpark, tsDark])
    it(
      'keeps 3:1 contrast in the ' +
        (theme.isDark ? 'dark' : 'light') +
        ' theme',
      () => {
        for (const fg of [
          theme.navOpaqueActiveColor,
          theme.navOpaqueInactiveColor
        ])
          for (const bg of [
            theme.navOpaqueBackgroundColor,
            theme.navOpaqueSelectedColor
          ]) {
            expect(bg).matches(/^#[0-9a-f]{6}$/i)
            expect(contrast(fg, bg), fg + ' on ' + bg).at.least(3)
          }
      }
    )
  for (const theme of [tsBallpark, tsDark])
    it(
      'sets the selected tab apart from the others in the ' +
        (theme.isDark ? 'dark' : 'light') +
        ' theme',
      () => {
        const platter = theme.navOpaqueBackgroundColor
        const active = theme.navOpaqueActiveColor
        const inactive = theme.navOpaqueInactiveColor
        // The selected tab reads as the most prominent, on its pill and off it.
        expect(contrast(active, platter)).above(contrast(inactive, platter))
        expect(contrast(active, theme.navOpaqueSelectedColor)).above(
          contrast(inactive, theme.navOpaqueSelectedColor)
        )
        // And its ink alone tells it apart, not only the pill and the weight.
        expect(contrast(active, inactive), active + ' vs ' + inactive).at.least(
          1.5
        )
      }
    )
})
